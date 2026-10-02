// Play screen: falling-notes highway + 노래방 lyrics + HUD, driven by a GameSession.
// Modes: play | practice (waits for the right key) | listen (auto-play) | calibrate (latency measurement).

import { GameSession } from '../game/session.js';
import { HighwayRenderer } from '../game/renderer.js';
import { Karaoke } from '../game/karaoke.js';
import { noteName } from '../core/notes.js';
import { songDuration, isPlayable, normalizeSong } from '../core/song.js';
import { DEFAULT_SETTINGS } from '../core/storage.js';
import { unlockAudio } from '../audio/engine.js';
import { h, toast, confirmDialog, formatTime } from '../ui/dom.js';
import * as dom from '../ui/dom.js';

const MODES = ['play', 'practice', 'listen', 'calibrate'];
const ACTIVE = new Set(['playing', 'holding', 'resuming']);
const MODE_LABEL = { play: '연주', practice: '연습 모드', listen: '듣기 모드', calibrate: '타이밍 보정' };
const MODE_DESC = {
  play: '노트가 빛나는 선에 닿는 순간 피아노 건반을 눌러 주세요. 박자와 음이 정확할수록 점수가 올라가요.',
  practice: '맞는 건반을 칠 때까지 노래가 기다려 줘요. 천천히 음을 익혀 보세요. (연습 기록은 최고점에 반영되지 않아요)',
  listen: '멜로디를 들으며 악보와 가사를 따라가 보세요.',
  calibrate: '노트가 선에 닿는 순간 아무 건반이나 또렷하게 쳐 주세요. 정확한 측정을 위해 메트로놈 소리는 일부러 나지 않아요.',
};
const INPUT_LABEL = { mic: '🎤 마이크', touch: '👆 터치', sim: '🤖 시뮬레이션' };
const INPUT_DESC = {
  mic: '태블릿을 피아노 위에 두고 마이크가 건반 소리를 잘 들을 수 있게 해 주세요.',
  touch: '화면 아래 건반을 터치해서 연주해요.',
  sim: '자동 연주 소리를 마이크 대신 인식기에 넣어 테스트해요.',
};
// Computer keyboard (desktop testing): a w s e d f t g y h u j k → C4..C5. Uses physical codes (IME-safe).
const KEY_MAP = {
  KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64, KeyF: 65, KeyT: 66,
  KeyG: 67, KeyY: 68, KeyH: 69, KeyU: 70, KeyJ: 71, KeyK: 72,
};
const SPEEDS = Array.from({ length: 16 }, (_, i) => Math.round((0.5 + i * 0.05) * 100) / 100);

const SVG = (body, fill = false) => `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" ${fill
  ? 'fill="currentColor"'
  : 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"'}>${body}</svg>`;
const ICON = {
  back: SVG('<path d="M15 18l-6-6 6-6"/>'),
  pause: SVG('<rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/>', true),
  play: SVG('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>', true),
  mic: SVG('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  headphones: SVG('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.6"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.6"/>'),
  fullscreen: SVG('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  music: SVG('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
  alert: SVG('<path d="M12 3l9.5 16.5h-19z"/><path d="M12 10v4M12 17.5v.01"/>'),
};

let S = null; // state of the mounted screen

// ------------------------------------------------------------------ lifecycle

export async function mount(root, params = {}, app) {
  if (S) teardown(S);
  const p = params && typeof params === 'object' ? params : {};
  const st = {
    root,
    app,
    params: p,
    mode: MODES.includes(p.mode) ? p.mode : 'play',
    song: null,
    duration: 0,
    audioBlob: null,
    hasBacking: false,
    settings: readSettings(app),
    inputMode: 'touch',
    lookahead: 2.5,
    wrap: null,
    els: {},
    renderer: null,
    karaoke: null,
    session: null,
    raf: 0,
    dirty: true,
    lastSnap: null,
    lastState: '',
    lastSongTime: NaN,
    finished: false,
    starting: false,
    finishTimer: 0,
    flashEl: null,
    frameErrorLogged: false,
    hud: freshHud(),
    pointers: new Map(),
    keyRefs: new Uint8Array(128),
    heldCodes: new Map(),
    cleanups: [],
    ro: null,
    previewSnap: null,
  };
  S = st;
  st.inputMode = ['mic', 'touch', 'sim'].includes(st.settings.inputMode) ? st.settings.inputMode : 'mic';
  st.lookahead = clampNum(st.settings.lookahead, 1, 6, 2.5);

  st.wrap = h('div', { class: 'pk-play', dataset: { mode: st.mode, state: 'ready' } },
    h('div', { class: 'pk-loading' }, h('span', { class: 'pk-spinner', 'aria-hidden': 'true' }), '곡을 불러오는 중…'));
  root.append(st.wrap);

  let song = null;
  try {
    song = await loadSong(p, app);
  } catch (err) {
    console.error('[play] load song', err);
  }
  if (S !== st) return;
  st.song = song;
  if (!song) {
    renderUnavailable(st, 'missing');
    return;
  }
  if (!isPlayable(song)) {
    renderUnavailable(st, 'empty');
    return;
  }

  st.audioBlob = p.audioBlob instanceof Blob ? p.audioBlob : null;
  if (!st.audioBlob && p.audioBlob === undefined && song.audio && song.id && app.library) {
    try {
      st.audioBlob = (await app.library.getAudio(song.id)) || null;
    } catch (err) {
      console.warn('[play] backing audio unavailable', err);
      st.audioBlob = null;
    }
    if (S !== st) return;
  }
  st.hasBacking = !!(st.audioBlob && song.audio);
  st.duration = songDuration(song);

  buildScreen(st);
  attachListeners(st);
  startLoop(st);
}

export function unmount() {
  if (S) teardown(S);
}

/** Hardware/browser back while playing pauses instead of leaving (router hook). */
export function onBack() {
  const st = S;
  if (!st) return false;
  const s = st.session;
  if (s && !st.finished && ACTIVE.has(s.state)) {
    s.pause();
    return true;
  }
  return false;
}

function teardown(st) {
  if (S === st) S = null;
  cancelAnimationFrame(st.raf);
  st.raf = 0;
  clearTimeout(st.finishTimer);
  for (const fn of st.cleanups.splice(0)) {
    try { fn(); } catch { /* ignore */ }
  }
  if (st.ro) {
    st.ro.disconnect();
    st.ro = null;
  }
  if (st.session) {
    try { st.session.destroy(); } catch (err) { console.warn('[play] session.destroy', err); }
    st.session = null;
  }
  if (st.karaoke) {
    try { st.karaoke.destroy(); } catch { /* ignore */ }
    st.karaoke = null;
  }
  keepAwake(st, false);
}

// ------------------------------------------------------------------ helpers

function readSettings(app) {
  try {
    return { ...DEFAULT_SETTINGS, ...app.settings.all() };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function freshHud() {
  return {
    score: NaN, combo: NaN, acc: NaN, progress: -1, countdown: -1, hold: -1,
    detAt: 0, level: -1, gate: null, detNote: -2, detSeen: 0,
  };
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

function formatScore(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('ko-KR') : '0';
}

function keepAwake(st, on) {
  try {
    const r = st.app && typeof st.app.keepAwake === 'function' ? st.app.keepAwake(on) : null;
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch { /* best effort */ }
}

function on(st, target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  st.cleanups.push(() => target.removeEventListener(type, fn, opts));
}

async function loadSong(p, app) {
  if (p.song && typeof p.song === 'object') {
    try {
      return normalizeSong(p.song);
    } catch (err) {
      console.warn('[play] draft song not normalizable, using as is', err);
      return Array.isArray(p.song.notes) ? p.song : null;
    }
  }
  if (p.songId != null && app && app.library) return (await app.library.get(String(p.songId))) || null;
  return null;
}

function hasLyrics(song) {
  const lines = song && song.lyrics && Array.isArray(song.lyrics.lines) ? song.lyrics.lines : [];
  return lines.some((l) => l && Array.isArray(l.syllables) && l.syllables.length > 0);
}

/** Params that reopen this same song (used by "연주하기" after listening). */
function songNavParams(st) {
  const p = st.params;
  const out = {};
  if (p.song) out.song = p.song;
  else out.songId = st.song.id;
  if (st.audioBlob) out.audioBlob = st.audioBlob;
  else if (p.audioBlob !== undefined) out.audioBlob = p.audioBlob;
  if (p.returnTo) {
    out.returnTo = p.returnTo;
    out.returnParams = p.returnParams;
  }
  return out;
}

function isPreview(st) {
  return Boolean(st.params.returnTo) && st.params.returnTo !== 'home';
}

function goExit(st) {
  if (S !== st) return;
  const { returnTo, returnParams } = st.params;
  if (returnTo) st.app.go(returnTo, returnParams || {});
  else st.app.go('home');
}

function displayName(st, m) {
  const en = noteName(m, 'en');
  return st.settings.labelStyle === 'solfege' ? `${noteName(m, 'solfege')} (${en})` : en;
}

// ------------------------------------------------------------------ DOM

function stat(label, valueEl, cls) {
  return h('div', { class: ['pk-stat', cls] }, h('span', { class: 'pk-stat-label' }, label), valueEl);
}

function buildScreen(st) {
  const { song, mode } = st;
  const e = st.els;
  const scored = mode === 'play' || mode === 'practice';

  e.back = h('button', {
    type: 'button', class: 'icon-btn pk-back', 'aria-label': '뒤로', title: '뒤로', html: ICON.back,
    onClick: () => onBackButton(st),
  });
  e.score = h('span', { class: 'pk-stat-value' }, '0');
  e.combo = h('span', { class: 'pk-stat-value' }, '0');
  e.acc = h('span', { class: 'pk-stat-value' }, '—');
  e.pause = h('button', {
    type: 'button', class: 'icon-btn pk-pause', 'aria-label': '일시정지', title: '일시정지 (Space)', html: ICON.pause,
    disabled: true, onClick: () => togglePause(st),
  });
  e.progress = h('div', { class: 'pk-progress-fill' });
  const subParts = [song.artist, MODE_LABEL[mode]].filter(Boolean);
  const topbar = h('header', { class: 'topbar pk-topbar' },
    e.back,
    h('div', { class: 'pk-titles' },
      h('div', { class: 'title pk-title' }, song.title || '제목 없음'),
      h('div', { class: 'pk-sub' }, subParts.join(' · '))),
    scored ? h('div', { class: 'pk-stats' },
      stat('점수', e.score, 'pk-score'),
      stat('콤보', e.combo, 'pk-combo'),
      stat('정확도', e.acc, 'pk-acc')) : null,
    e.pause,
    h('div', { class: 'pk-progress', 'aria-hidden': 'true' }, e.progress));

  const wantLyrics = st.settings.showLyrics !== false && mode !== 'calibrate' && hasLyrics(song);
  e.karaoke = h('div', { class: 'pk-karaoke-panel' });
  e.karaoke.hidden = !wantLyrics;

  e.canvas = h('canvas', { class: 'pk-canvas', role: 'img', 'aria-label': '떨어지는 노트와 건반' });
  e.detect = buildDetectHud(st);
  e.hold = h('div', { class: 'pk-hold', role: 'status' });
  e.hold.hidden = true;
  e.countNum = h('span', { class: 'pk-count-num' });
  e.countdown = h('div', { class: 'pk-countdown', 'aria-live': 'assertive' }, e.countNum);
  e.countdown.hidden = true;
  e.stage = h('div', { class: 'pk-stage' }, e.canvas, e.detect, e.hold, e.countdown);

  e.ready = buildReady(st);
  e.pauseOv = buildPause(st);
  e.pauseOv.hidden = true;
  e.finishOv = h('div', { class: 'overlay pk-overlay pk-finish' });
  e.finishOv.hidden = true;
  e.body = h('div', { class: 'pk-body' }, e.karaoke, e.stage, e.ready, e.pauseOv, e.finishOv);

  st.wrap.replaceChildren(topbar, e.body);

  st.renderer = new HighwayRenderer(e.canvas, {
    labelStyle: st.settings.labelStyle,
    showDetected: st.settings.showDetected !== false,
  });
  st.renderer.setSong(song);
  st.renderer.resize();
  updateHitVar(st);

  if (wantLyrics) {
    st.karaoke = new Karaoke(e.karaoke);
    st.karaoke.setLines(song.lyrics.lines, {
      bpm: song.bpm,
      idleText: song.artist ? `${song.title} · ${song.artist}` : song.title,
    });
    st.karaoke.update(-1e9);
  }

  st.previewSnap = makePreviewSnap(st);
  updateInputUi(st);
  st.dirty = true;
}

function makePreviewSnap(st) {
  const notes = st.song.notes;
  const first = notes.length ? notes[0].t : 0;
  return {
    songTime: first - st.lookahead * 0.35,
    state: 'ready',
    mode: st.mode,
    speed: 1,
    countdown: null,
    notes,
    states: null,
    judgedAt: null,
    expectedKeys: new Set(),
    pressedKeys: new Set(),
    detected: null,
    stats: null,
    progress: 0,
    holdingNotes: [],
  };
}

function buildDetectHud(st) {
  const e = st.els;
  e.meterFill = h('div', { class: 'pk-meter-fill' });
  e.detNote = h('span', { class: 'pk-detect-note' }, '—');
  const el = h('div', { class: 'pk-detect', 'aria-hidden': 'true' },
    h('span', { class: 'pk-detect-ico', html: ICON.mic }),
    h('div', { class: 'pk-meter' }, e.meterFill),
    e.detNote);
  el.hidden = true;
  return el;
}

function toggleButton(st, label, key) {
  const btn = h('button', {
    type: 'button', class: 'pk-toggle', 'aria-pressed': String(!!st.settings[key]),
  }, h('span', { class: 'pk-toggle-track', 'aria-hidden': 'true' }, h('span', { class: 'pk-toggle-knob' })), label);
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(next));
    st.settings[key] = next;
    try { st.app.settings.set(key, next); } catch (err) { console.warn('[play] settings', err); }
    updateInputUi(st);
  });
  return btn;
}

function buildReady(st) {
  const { song, mode, app } = st;
  const e = st.els;
  const meta = [`노트 ${song.notes.length}개`, formatTime(st.duration), `♩ = ${Math.round(song.bpm || 100)}`];
  if (st.hasBacking) meta.push('반주 있음');

  e.inputChip = h('span', { class: 'chip pk-input-chip' });
  e.desc = h('p', { class: 'pk-ready-desc' });

  let quick = null;
  if (mode !== 'calibrate') {
    const sel = h('select', { class: 'pk-select', 'aria-label': '재생 속도' },
      SPEEDS.map((v) => h('option', { value: String(v) }, v === 1 ? '100% (원래 속도)' : `${Math.round(v * 100)}%`)));
    const cur = Number(st.settings.speed) || 1;
    sel.value = String(SPEEDS.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a), 1));
    sel.addEventListener('change', () => {
      const v = Number(sel.value);
      st.settings.speed = v;
      try { app.settings.set('speed', v); } catch (err) { console.warn('[play] settings', err); }
    });
    e.speedSel = sel;
    quick = h('div', { class: 'pk-quick' },
      h('label', { class: 'pk-quick-speed' }, h('span', { class: 'pk-quick-label' }, '속도'), sel),
      mode !== 'listen' ? toggleButton(st, '가이드 멜로디', 'guideMelody') : null,
      toggleButton(st, '메트로놈', 'metronome'));
  }

  e.hint = h('div', { class: 'pk-hint' });
  e.hint.hidden = true;
  e.micErr = h('div', { class: 'pk-mic-error', role: 'alert' });
  e.micErr.hidden = true;
  e.start = h('button', { type: 'button', class: 'btn primary big pk-start', onClick: () => onStart(st) },
    mode === 'listen' ? '듣기 시작' : mode === 'calibrate' ? '측정 시작' : '시작');

  let fsBtn = null;
  const fsEnabled = typeof document !== 'undefined'
    && (document.fullscreenEnabled || document.webkitFullscreenEnabled)
    && !(document.fullscreenElement || document.webkitFullscreenElement);
  if (fsEnabled && typeof app.requestFullscreen === 'function') {
    fsBtn = h('button', {
      type: 'button', class: 'btn ghost pk-fs', title: '전체화면',
      onClick: async () => {
        try { await app.requestFullscreen(); } catch { /* ignore */ }
        if (document.fullscreenElement || document.webkitFullscreenElement) fsBtn.hidden = true;
      },
    }, h('span', { class: 'pk-ico', html: ICON.fullscreen }), '전체화면');
  }

  const panel = h('div', { class: 'panel pk-panel pk-ready-panel' },
    h('div', { class: 'pk-ready-head' },
      h('span', { class: ['badge', 'pk-mode-badge', `is-${mode}`] }, MODE_LABEL[mode]),
      mode !== 'listen' ? e.inputChip : null),
    h('h2', { class: 'pk-ready-title' }, song.title || '제목 없음'),
    song.artist ? h('div', { class: 'pk-ready-artist' }, song.artist) : null,
    h('div', { class: 'pk-ready-meta' }, meta.join(' · ')),
    e.desc,
    quick,
    e.hint,
    e.micErr,
    h('div', { class: 'pk-ready-actions' },
      h('button', { type: 'button', class: 'btn ghost', onClick: () => goExit(st) }, '나가기'),
      fsBtn,
      e.start),
    mode !== 'listen'
      ? h('p', { class: 'pk-keys-hint' }, '키보드로도 칠 수 있어요: A W S E D F T G Y H U J K = 도(C4)~도(C5) · Space 일시정지')
      : null);
  return h('div', { class: 'overlay pk-overlay pk-ready' }, panel);
}

function buildPause(st) {
  const e = st.els;
  e.pauseInfo = h('p', { class: 'pk-pause-info' });
  const panel = h('div', { class: 'panel pk-panel pk-pause-panel' },
    h('h2', null, '일시정지'),
    e.pauseInfo,
    h('div', { class: 'pk-stack-actions' },
      h('button', { type: 'button', class: 'btn primary big', onClick: () => resume(st) }, '계속'),
      h('button', { type: 'button', class: 'btn big', onClick: () => restart(st) }, '처음부터'),
      h('button', { type: 'button', class: 'btn ghost big', onClick: () => goExit(st) }, '나가기')));
  return h('div', { class: 'overlay pk-overlay pk-pause' }, panel);
}

function updateInputUi(st) {
  const e = st.els;
  if (!e.desc) return;
  const usesInput = st.mode !== 'listen';
  if (e.inputChip) {
    e.inputChip.textContent = INPUT_LABEL[st.inputMode] || INPUT_LABEL.mic;
    e.inputChip.dataset.input = st.inputMode;
  }
  e.desc.textContent = usesInput ? `${MODE_DESC[st.mode]} ${INPUT_DESC[st.inputMode] || ''}`.trim() : MODE_DESC[st.mode];

  const mic = usesInput && st.inputMode === 'mic';
  let text = '';
  if (mic && st.hasBacking) {
    text = '반주 음원이 함께 재생돼요. 반주 소리가 마이크로 들어가면 판정이 흔들리니 이어폰(헤드폰)을 사용해 주세요.';
  } else if (mic && st.settings.guideMelody && st.mode !== 'calibrate') {
    text = '가이드 멜로디 소리가 마이크로 들어가면 잘못 판정될 수 있어요. 이어폰을 쓰거나 가이드를 꺼 주세요.';
  }
  e.hint.replaceChildren(h('span', { class: 'pk-ico', html: ICON.headphones }), h('span', null, text));
  e.hint.hidden = !text;
}

function setStartBusy(st, busy, label) {
  const b = st.els.start;
  if (!b) return;
  if (!b.dataset.label) b.dataset.label = b.textContent;
  b.disabled = busy;
  b.classList.toggle('is-busy', busy);
  b.textContent = busy ? (label || '준비 중…') : b.dataset.label;
}

function micErrorInfo(st, err) {
  const code = err && err.code;
  if (st.inputMode === 'touch' || st.mode === 'listen') {
    return {
      title: '소리를 켜지 못했어요',
      body: `브라우저가 오디오 재생을 막았어요. 다시 시도해 주세요.${err && err.message ? ` (${err.message})` : ''}`,
      touch: false,
    };
  }
  switch (code) {
    case 'denied':
      return {
        title: '마이크 권한이 필요해요',
        body: '브라우저가 마이크 사용을 막고 있어요. 주소창 왼쪽의 자물쇠(사이트 정보) 아이콘 → 권한에서 마이크를 "허용"으로 바꾼 뒤 '
          + '다시 시도해 주세요. 삼성 인터넷은 메뉴 → 설정 → 사이트 및 다운로드 → 사이트 권한 → 마이크에서도 바꿀 수 있어요.',
        touch: true,
      };
    case 'insecure':
      return {
        title: '보안 연결(HTTPS)이 필요해요',
        body: '마이크는 https:// 로 시작하는 주소에서만 쓸 수 있어요. 보안 주소로 다시 접속하거나, 지금은 터치 모드로 연주해 주세요.',
        touch: true,
      };
    case 'unsupported':
      return {
        title: '마이크를 지원하지 않는 브라우저예요',
        body: '최신 Chrome 또는 삼성 인터넷에서 열어 주세요. 지금은 터치 모드로 연주할 수 있어요.',
        touch: true,
      };
    default: {
      let body = '';
      try {
        body = typeof st.app.inputErrorMessage === 'function' ? st.app.inputErrorMessage(err) : '';
      } catch { /* ignore */ }
      if (!body) {
        body = `다른 앱이 마이크를 쓰고 있지 않은지 확인한 뒤 다시 시도해 주세요.${err && err.message ? ` (${err.message})` : ''}`;
      }
      return { title: '마이크를 시작하지 못했어요', body, touch: true };
    }
  }
}

function showMicError(st, err) {
  const e = st.els;
  const info = micErrorInfo(st, err);
  e.micErr.replaceChildren(
    h('div', { class: 'pk-err-title' }, h('span', { class: 'pk-ico', html: ICON.alert }), info.title),
    h('p', null, info.body),
    h('div', { class: 'pk-err-actions' },
      h('button', { type: 'button', class: 'btn small', onClick: () => onStart(st) }, '다시 시도'),
      info.touch
        ? h('button', { type: 'button', class: 'btn small primary', onClick: () => switchToTouch(st) }, '터치 모드로 전환')
        : null));
  e.micErr.hidden = false;
}

function switchToTouch(st) {
  st.inputMode = 'touch';
  st.settings.inputMode = 'touch';
  try { st.app.settings.set('inputMode', 'touch'); } catch (err) { console.warn('[play] settings', err); }
  st.els.micErr.hidden = true;
  updateInputUi(st);
  toast('터치 모드로 바꿨어요. 화면 아래 건반을 눌러 연주하세요. 설정에서 다시 마이크로 바꿀 수 있어요.', { type: 'success' });
}

// ------------------------------------------------------------------ start / session

async function onStart(st) {
  if (st.starting || st.session || S !== st || st.els.ready.hidden) return;
  st.starting = true;
  const e = st.els;
  const usesInput = st.mode !== 'listen';
  setStartBusy(st, true, usesInput && st.inputMode === 'mic' ? '마이크 연결 중…' : '준비 중…');
  e.micErr.hidden = true;

  // Must be the first await of the click handler: mic permission + AudioContext resume need the user gesture.
  let input = null;
  try {
    if (usesInput) {
      input = await st.app.ensureInput();
      if (st.inputMode === 'touch') input = null;
    } else if (typeof st.app.unlockAudio === 'function') {
      await st.app.unlockAudio();
    } else {
      await unlockAudio();
    }
  } catch (err) {
    if (S !== st) return;
    console.warn('[play] input start failed', err);
    st.starting = false;
    setStartBusy(st, false);
    showMicError(st, err);
    return;
  }
  if (S !== st) return;
  setStartBusy(st, true, '준비 중…');

  st.settings = { ...readSettings(st.app), ...pickQuick(st.settings) };
  const settings = { ...st.settings, inputMode: usesInput ? st.inputMode : 'touch' };
  if (st.mode === 'calibrate') {
    settings.speed = 1;
    settings.guideMelody = false;
    settings.metronome = false;
  }

  let session;
  try {
    session = await createSession(st, settings, input);
  } catch (err) {
    console.error('[play] session prepare failed', err);
    if (S !== st) return;
    st.starting = false;
    setStartBusy(st, false);
    toast(`게임을 준비하지 못했어요.${err && err.message ? ` (${err.message})` : ''}`, { type: 'error' });
    return;
  }
  if (S !== st) {
    try { session.destroy(); } catch { /* ignore */ }
    return;
  }

  session.on('judge', (r) => {
    if (S === st && st.renderer) st.renderer.addJudgeEffect(r);
  });
  session.on('finish', (stats) => {
    if (S === st) onFinish(st, stats);
  });

  try {
    session.start();
  } catch (err) {
    console.error('[play] session.start', err);
    try { session.destroy(); } catch { /* ignore */ }
    st.starting = false;
    setStartBusy(st, false);
    toast('게임을 시작하지 못했어요. 다시 시도해 주세요.', { type: 'error' });
    return;
  }

  st.session = session;
  st.starting = false;
  e.ready.hidden = true;
  e.pause.disabled = false;
  e.detect.hidden = !(input && usesInput && (st.inputMode === 'mic' || st.inputMode === 'sim'));
  st.hud = freshHud();
  st.lastState = '';
  st.dirty = true;
  const active = document.activeElement;
  if (active && typeof active.blur === 'function' && active !== document.body) active.blur();
  keepAwake(st, true);
}

// Quick toggles chosen on the ready panel win even if persisting them failed.
function pickQuick(s) {
  const out = {};
  for (const k of ['speed', 'guideMelody', 'metronome', 'inputMode']) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

async function createSession(st, settings, input) {
  const make = async (audioBlob) => {
    const s = new GameSession({ song: st.song, settings, mode: st.mode, input, audioBlob });
    try {
      await s.prepare();
    } catch (err) {
      try { s.destroy(); } catch { /* ignore */ }
      throw err;
    }
    return s;
  };
  let session;
  try {
    session = await make(st.audioBlob);
  } catch (err) {
    if (!st.audioBlob || S !== st) throw err;
    console.warn('[play] session with backing track failed, retrying without it', err);
    session = await make(null);
    session.backingError = session.backingError || err;
  }
  if (st.audioBlob && session.backingError) {
    console.warn('[play] backing track unavailable', session.backingError);
    toast('반주 음원을 불러오지 못해 반주 없이 진행해요.', { type: 'error' });
    st.audioBlob = null;
    st.hasBacking = false;
  }
  return session;
}

function togglePause(st) {
  const s = st.session;
  if (!s || st.finished) return;
  if (s.state === 'paused') s.resume();
  else if (ACTIVE.has(s.state)) s.pause();
}

function resume(st) {
  const s = st.session;
  if (s && !st.finished && s.state === 'paused') s.resume();
}

function restart(st) {
  const s = st.session;
  if (!s || S !== st) return;
  clearTimeout(st.finishTimer);
  st.finishTimer = 0;
  st.finished = false;
  if (st.flashEl) {
    st.flashEl.remove();
    st.flashEl = null;
  }
  st.els.finishOv.hidden = true;
  st.els.finishOv.replaceChildren();
  releaseAllInputs(st);
  st.renderer.clearEffects();
  if (st.karaoke) st.karaoke.reset();
  try {
    s.restart();
    if (s.state === 'ready') s.start();
  } catch (err) {
    console.error('[play] restart', err);
    toast('처음부터 다시 시작하지 못했어요.', { type: 'error' });
    return;
  }
  st.hud = freshHud();
  st.lastState = '';
  st.els.pause.disabled = false;
  st.dirty = true;
  keepAwake(st, true);
}

async function onBackButton(st) {
  const s = st.session;
  if (s && !st.finished && ACTIVE.has(s.state)) {
    s.pause();
    const ok = await confirmDialog({
      title: '연주를 그만둘까요?',
      message: '지금까지의 연주는 기록되지 않아요.',
      okText: '나가기',
      cancelText: '계속 있기',
      danger: true,
    });
    if (S !== st) return;
    if (ok) goExit(st);
    return;
  }
  goExit(st);
}

// ------------------------------------------------------------------ finish

function showFlash(st, text) {
  if (st.flashEl) st.flashEl.remove();
  st.flashEl = h('div', { class: 'pk-finish-flash', role: 'status' }, h('span', null, text));
  st.els.body.append(st.flashEl);
}

function onFinish(st, stats) {
  if (st.finished || S !== st) return;
  st.finished = true;
  releaseAllInputs(st);
  st.els.pause.disabled = true;
  keepAwake(st, false);
  const { app, mode, params, song } = st;
  const finalStats = stats || (st.session && st.session.stats) || null;

  if (mode === 'calibrate') {
    showFlash(st, '측정 완료!');
    st.finishTimer = setTimeout(() => {
      if (S !== st) return;
      app.go(params.returnTo || 'calibrate', { ...(params.returnParams || {}), calibrationResult: finalStats });
    }, 700);
    return;
  }
  if (mode === 'listen') {
    showListenFinish(st);
    return;
  }
  if (isPreview(st)) {
    showPreviewFinish(st, finalStats);
    return;
  }
  let rec = null;
  try {
    rec = app.scores.record(song.id, finalStats, mode);
  } catch (err) {
    console.error('[play] record score', err);
  }
  showFlash(st, mode === 'practice' ? '연습 완료!' : '연주 완료!');
  st.finishTimer = setTimeout(() => {
    if (S !== st) return;
    app.go('results', { song, stats: finalStats, mode, isBest: false, previousBest: null, ...(rec || {}) });
  }, 1400);
}

function showListenFinish(st) {
  const e = st.els;
  e.finishOv.replaceChildren(h('div', { class: 'panel pk-panel pk-finish-panel' },
    h('div', { class: 'pk-finish-icon', html: ICON.music }),
    h('h2', null, '감상 완료'),
    h('p', { class: 'pk-finish-text' }, '멜로디를 익혔다면 이제 직접 연주해 볼까요?'),
    h('div', { class: 'pk-stack-actions' },
      h('button', {
        type: 'button', class: 'btn primary big',
        onClick: () => st.app.go('play', { ...songNavParams(st), mode: 'play' }),
      }, '연주하기'),
      h('button', { type: 'button', class: 'btn big', onClick: () => restart(st) }, '다시 듣기'),
      h('button', { type: 'button', class: 'btn ghost big', onClick: () => goExit(st) }, '나가기'))));
  e.finishOv.hidden = false;
}

function showPreviewFinish(st, stats) {
  const e = st.els;
  const s = stats || {};
  const c = s.counts || {};
  const acc = Number.isFinite(s.accuracy) && s.judged > 0 ? `${(s.accuracy * 100).toFixed(1)}%` : '—';
  const grades = [['perfect', 'PERFECT'], ['great', 'GREAT'], ['good', 'GOOD'], ['miss', 'MISS']];
  e.finishOv.replaceChildren(h('div', { class: 'panel pk-panel pk-finish-panel' },
    st.mode === 'play' && s.rank ? h('div', { class: ['pk-rank', `rank-${s.rank}`] }, s.rank) : null,
    h('h2', null, st.mode === 'practice' ? '연습 완료' : '연주 완료'),
    h('div', { class: 'pk-finish-score' },
      h('div', null, h('span', { class: 'pk-stat-label' }, '점수'), h('strong', null, formatScore(s.score))),
      h('div', null, h('span', { class: 'pk-stat-label' }, '정확도'), h('strong', null, acc)),
      h('div', null, h('span', { class: 'pk-stat-label' }, '최대 콤보'), h('strong', null, String(s.maxCombo || 0)))),
    h('div', { class: 'pk-finish-counts' },
      grades.map(([k, label]) => h('span', { class: ['pk-count', `is-${k}`] }, label, h('b', null, String(c[k] || 0))))),
    h('p', { class: 'pk-finish-text' }, '미리보기 기록은 저장되지 않아요.'),
    h('div', { class: 'pk-stack-actions' },
      h('button', { type: 'button', class: 'btn primary big', onClick: () => goExit(st) },
        st.params.returnTo === 'editor' ? '편집으로 돌아가기' : '돌아가기'),
      h('button', { type: 'button', class: 'btn big', onClick: () => restart(st) }, '다시하기'))));
  e.finishOv.hidden = false;
}

function renderUnavailable(st, kind) {
  const { params, song, app } = st;
  const missing = kind === 'missing';
  const title = missing ? '곡을 찾을 수 없어요' : '아직 연주할 악보가 없어요';
  const msg = missing
    ? '삭제되었거나 잘못된 주소일 수 있어요. 곡 목록에서 다시 골라 주세요.'
    : (song && song.template && song.description) || '편집 화면에서 MIDI 가져오기 · 피아노로 녹음 · 계이름 입력으로 멜로디를 만들면 바로 연주할 수 있어요.';
  const actions = [];
  if (!missing) {
    actions.push(h('button', {
      type: 'button', class: 'btn primary big',
      onClick: () => {
        if (params.returnTo === 'editor') app.go('editor', params.returnParams || {});
        else if (params.song && params.songId == null) app.go('editor', { draft: song });
        else app.go('editor', { songId: song.id });
      },
    }, '악보 만들기'));
  }
  actions.push(h('button', { type: 'button', class: 'btn big', onClick: () => goExit(st) },
    params.returnTo ? '돌아가기' : '곡 목록으로'));
  st.wrap.replaceChildren(
    h('header', { class: 'topbar pk-topbar' },
      h('button', {
        type: 'button', class: 'icon-btn pk-back', 'aria-label': '뒤로', title: '뒤로', html: ICON.back,
        onClick: () => goExit(st),
      }),
      h('div', { class: 'pk-titles' },
        h('div', { class: 'title pk-title' }, song ? song.title || '제목 없음' : '피아노 노래방'),
        song && song.artist ? h('div', { class: 'pk-sub' }, song.artist) : null)),
    h('div', { class: 'pk-empty' },
      h('div', { class: 'panel pk-panel pk-empty-panel' },
        h('div', { class: 'pk-finish-icon', html: ICON.music }),
        h('h2', null, title),
        h('p', { class: 'pk-finish-text' }, msg),
        h('div', { class: 'pk-stack-actions' }, actions))));
}

// ------------------------------------------------------------------ frame loop & HUD

function startLoop(st) {
  const frame = () => {
    if (S !== st) return;
    st.raf = requestAnimationFrame(frame);
    try {
      tickFrame(st);
    } catch (err) {
      if (!st.frameErrorLogged) {
        st.frameErrorLogged = true;
        console.error('[play] frame', err);
      }
    }
  };
  st.raf = requestAnimationFrame(frame);
}

function tickFrame(st) {
  const r = st.renderer;
  const s = st.session;
  if (!s) {
    if (st.dirty || r.animating) {
      r.render(st.previewSnap, st.lookahead);
      st.dirty = false;
    }
    return;
  }
  const snap = s.tick();
  if (!snap || S !== st) return;
  st.lastSnap = snap;
  if (snap.state !== st.lastState) onStateChange(st, snap);
  const frozen = (snap.state === 'paused' || snap.state === 'finished')
    && snap.songTime === st.lastSongTime && !st.dirty && !r.animating;
  st.lastSongTime = snap.songTime;
  if (!frozen) {
    r.render(snap, st.lookahead);
    st.dirty = false;
  }
  if (st.karaoke) st.karaoke.update(snap.songTime);
  updateHud(st, snap);
}

function onStateChange(st, snap) {
  const state = snap.state;
  st.lastState = state;
  const e = st.els;
  st.wrap.dataset.state = state;
  const paused = state === 'paused';
  e.pauseOv.hidden = !paused || st.finished;
  if (paused) {
    e.pauseInfo.textContent = `${formatTime(Math.max(0, snap.songTime))} / ${formatTime(st.duration)}`;
    releaseAllInputs(st);
  }
  e.pause.innerHTML = paused ? ICON.play : ICON.pause;
  e.pause.setAttribute('aria-label', paused ? '계속하기' : '일시정지');
  e.pause.title = paused ? '계속하기 (Space)' : '일시정지 (Space)';
  e.pause.disabled = state === 'finished' || st.finished;
  if (state === 'finished' && !st.finished) onFinish(st, snap.stats || (st.session && st.session.stats));
}

function updateHud(st, snap) {
  const e = st.els;
  const hud = st.hud;
  const stats = snap.stats;
  if (stats && e.score.isConnected) {
    const score = Math.round(Number(stats.score) || 0);
    if (score !== hud.score) {
      hud.score = score;
      e.score.textContent = formatScore(score);
    }
    const combo = Number(stats.combo) | 0;
    if (combo !== hud.combo) {
      const up = combo > hud.combo;
      hud.combo = combo;
      e.combo.textContent = String(combo);
      if (up && combo >= 2 && typeof e.combo.animate === 'function') {
        e.combo.animate([{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'ease-out' });
      }
    }
    const acc = stats.judged > 0 && Number.isFinite(stats.accuracy) ? Math.round(stats.accuracy * 1000) : -1;
    if (acc !== hud.acc) {
      hud.acc = acc;
      e.acc.textContent = acc < 0 ? '—' : `${(acc / 10).toFixed(1)}%`;
    }
  }

  const prog = clampNum(snap.progress, 0, 1, 0);
  if (Math.abs(prog - hud.progress) > 0.001) {
    hud.progress = prog;
    e.progress.style.transform = `scaleX(${prog.toFixed(4)})`;
  }

  const cd = snap.countdown == null || !(snap.countdown > 0) ? 0 : Math.ceil(snap.countdown);
  if (cd !== hud.countdown) {
    hud.countdown = cd;
    e.countdown.hidden = cd <= 0;
    if (cd > 0) {
      e.countNum.textContent = String(cd);
      if (typeof e.countNum.animate === 'function') {
        e.countNum.animate([
          { transform: 'scale(1.6)', opacity: 0 },
          { transform: 'scale(1)', opacity: 1, offset: 0.35 },
          { transform: 'scale(0.92)', opacity: 0.85 },
        ], { duration: 900, easing: 'ease-out' });
      }
    }
  }

  let holdKey = 0;
  const hn = snap.state === 'holding' && Array.isArray(snap.holdingNotes) ? snap.holdingNotes : null;
  if (hn && hn.length) for (let i = 0; i < hn.length; i++) holdKey = (holdKey * 131 + (hn[i] | 0) + 1) % 2147483647;
  if (holdKey !== hud.hold) {
    hud.hold = holdKey;
    if (holdKey && hn) {
      const uniq = Array.from(new Set(hn.map((m) => Math.round(m)))).sort((a, b) => a - b);
      const names = uniq.map((m) => displayName(st, m)).join(' · ');
      const solfege = st.settings.labelStyle === 'solfege';
      e.hold.replaceChildren(h('b', null, names), solfege ? ' 을 쳐주세요' : ' 건반을 쳐주세요');
      e.hold.hidden = false;
    } else {
      e.hold.hidden = true;
    }
  }

  if (!e.detect.hidden) {
    const now = performance.now();
    if (now - hud.detAt >= 80) {
      hud.detAt = now;
      const det = snap.detected;
      const db = det && Number.isFinite(det.db) ? det.db : -120;
      const level = Math.round(clampNum((db + 72) / 66, 0, 1, 0) * 100);
      if (level !== hud.level) {
        hud.level = level;
        e.meterFill.style.transform = `scaleX(${level / 100})`;
      }
      const gate = !!(det && det.gateOpen);
      if (gate !== hud.gate) {
        hud.gate = gate;
        e.detect.classList.toggle('is-open', gate);
      }
      let m = det && det.gateOpen && det.pitch && det.pitch.clarity >= 0.6 && Number.isFinite(det.pitch.midi)
        ? Math.round(det.pitch.midi) : -1;
      if (m >= 0) hud.detSeen = now;
      else if (now - hud.detSeen < 350) m = hud.detNote;
      if (m !== hud.detNote) {
        hud.detNote = m;
        e.detNote.textContent = m < 0 ? '—' : displayName(st, m);
      }
    }
  }
}

function updateHitVar(st) {
  if (!st.renderer || !st.els.stage) return;
  st.els.stage.style.setProperty('--hit-y', `${Math.round(st.renderer.keyboardTop)}px`);
  st.els.stage.style.setProperty('--kb-h', `${Math.round(st.renderer.keyboardHeight || 0)}px`);
}

function onResize(st) {
  if (S !== st || !st.renderer) return;
  if (!st.renderer.resize()) return;
  updateHitVar(st);
  st.dirty = true;
  // Resizing cleared the canvas; repaint now so no blank frame is shown.
  const snap = st.session ? st.lastSnap : st.previewSnap;
  if (snap) {
    try { st.renderer.render(snap, st.lookahead); } catch (err) { console.error('[play] render', err); }
  }
}

// ------------------------------------------------------------------ input (touch keys, computer keyboard)

function pressKey(st, m) {
  const s = st.session;
  if (!s || st.finished || st.mode === 'listen' || !(m >= 0 && m <= 127) || !ACTIVE.has(s.state)) return false;
  if (st.keyRefs[m]++ > 0) return true;
  try { s.touchDown(m); } catch (err) { console.warn('[play] touchDown', err); }
  return true;
}

function releaseKey(st, m) {
  if (!(m >= 0 && m <= 127) || st.keyRefs[m] === 0) return;
  st.keyRefs[m]--;
  if (st.keyRefs[m] > 0) return;
  try { if (st.session) st.session.touchUp(m); } catch (err) { console.warn('[play] touchUp', err); }
}

function releaseAllInputs(st) {
  st.pointers.clear();
  st.heldCodes.clear();
  for (let m = 0; m < 128; m++) {
    if (st.keyRefs[m] > 0) {
      st.keyRefs[m] = 1;
      releaseKey(st, m);
    }
  }
}

function attachListeners(st) {
  const canvas = st.els.canvas;

  on(st, canvas, 'pointerdown', (ev) => {
    if (ev.button > 0) return;
    const m = st.renderer.keyAt(ev.clientX, ev.clientY);
    if (m == null) return;
    ev.preventDefault();
    if (!pressKey(st, m)) return;
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    st.pointers.set(ev.pointerId, m);
  });
  on(st, canvas, 'pointermove', (ev) => {
    if (!st.pointers.has(ev.pointerId)) return;
    const prev = st.pointers.get(ev.pointerId);
    const m = st.renderer.keyAt(ev.clientX, ev.clientY);
    if (m === prev) return;
    if (prev != null) releaseKey(st, prev);
    st.pointers.set(ev.pointerId, m != null && pressKey(st, m) ? m : null);
  });
  const up = (ev) => {
    if (!st.pointers.has(ev.pointerId)) return;
    const prev = st.pointers.get(ev.pointerId);
    st.pointers.delete(ev.pointerId);
    if (prev != null) releaseKey(st, prev);
  };
  on(st, canvas, 'pointerup', up);
  on(st, canvas, 'pointercancel', up);
  on(st, canvas, 'lostpointercapture', up);

  on(st, window, 'keydown', (ev) => onKeyDown(st, ev));
  on(st, window, 'keyup', (ev) => {
    const m = st.heldCodes.get(ev.code);
    if (m === undefined) return;
    st.heldCodes.delete(ev.code);
    releaseKey(st, m);
  });
  on(st, window, 'blur', () => releaseAllInputs(st));
  on(st, document, 'visibilitychange', () => {
    if (!document.hidden) return;
    releaseAllInputs(st);
    const s = st.session;
    if (s && !st.finished && ACTIVE.has(s.state)) s.pause();
  });

  if (typeof ResizeObserver === 'function') {
    st.ro = new ResizeObserver(() => onResize(st));
    st.ro.observe(st.els.stage);
  } else {
    on(st, window, 'resize', () => onResize(st));
  }
}

function onKeyDown(st, ev) {
  if (S !== st || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (typeof dom.isModalOpen === 'function' && dom.isModalOpen()) return;
  const t = ev.target;
  const tag = t && t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;

  if (ev.code === 'Space') {
    if (tag === 'BUTTON') return; // the focused button handles Space itself
    ev.preventDefault();
    if (ev.repeat) return;
    if (!st.session) {
      if (st.els.ready && !st.els.ready.hidden && !st.starting) onStart(st);
    } else {
      togglePause(st);
    }
    return;
  }
  if (ev.code === 'Escape') {
    const s = st.session;
    if (s && !st.finished && ACTIVE.has(s.state)) {
      ev.preventDefault();
      s.pause();
    }
    return;
  }
  const m = KEY_MAP[ev.code];
  if (m === undefined) return;
  ev.preventDefault();
  if (ev.repeat || st.heldCodes.has(ev.code)) return;
  if (pressKey(st, m)) st.heldCodes.set(ev.code, m);
}
