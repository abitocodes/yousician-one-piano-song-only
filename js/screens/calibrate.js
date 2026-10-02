// 마이크·보정 화면: 마이크 확인(레벨/음 감지), 입력 설정, 지연(레이턴시) 보정.
import { noteName, centsOff } from '../core/notes.js';
import { unlockAudio } from '../audio/engine.js';
import { confirmDialog, syncRange } from '../ui/dom.js';

const DB_MIN = -80;
const DB_MAX = 0;
const LAT_SETTING_MIN = -0.1;
const LAT_SETTING_MAX = 0.5;
// 슬라이더·±10 버튼 범위 = 설정값 범위 (자동 측정은 최대 500ms까지 적용할 수 있다)
const LAT_MIN_MS = Math.round(LAT_SETTING_MIN * 1000);
const LAT_MAX_MS = Math.round(LAT_SETTING_MAX * 1000);
const MAX_CHIPS = 12;

const INPUT_MODES = [
  { value: 'mic', label: '🎤 마이크', desc: '실제 피아노 소리를 마이크로 듣고 판정해요.' },
  { value: 'touch', label: '👆 터치', desc: '화면 건반을 눌러서 연주해요. 마이크를 쓰지 않아요.' },
  { value: 'sim', label: '🤖 시뮬레이션', desc: '앱이 직접 연주한 소리로 인식 과정을 시험해요. (테스트용)' },
];

const STATE_LABELS = {
  idle: '마이크 꺼짐',
  requesting: '권한 요청 중…',
  running: '듣는 중',
  denied: '권한 거부됨',
  error: '오류',
  unsupported: '지원 안 됨',
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests and for the editor screen)
// ---------------------------------------------------------------------------

/** 타이밍 보정용 곡: C4 12개, t = 2 s부터 1초 간격 (판정은 아무 음이나 허용). */
export function makeCalibrationSong() {
  const notes = [];
  for (let i = 0; i < 12; i++) notes.push({ t: 2 + i, d: 0.5, m: 60, v: 0.8 });
  return {
    format: 'piano-karaoke-song',
    version: 1,
    id: 'calibration',
    title: '타이밍 보정',
    artist: '마이크 지연 측정',
    description: '노트가 판정선에 닿는 순간 아무 건반이나 쳐 주세요.',
    bpm: 60,
    beatsPerBar: 4,
    offset: 0,
    notes,
    lyrics: { text: '', source: 'notes', lines: [] },
    audio: null,
    builtin: false,
    template: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Linear-interpolated quantile of an ascending-sorted array. */
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

/**
 * 보정 플레이 결과(Stats) → 새 지연값.
 * 보정 모드는 지연 보정 0으로 판정하므로 delta 자체가 원시 지연이다 → 새 지연 = median(deltas).
 */
export function analyzeCalibration(stats, { minHits = 4 } = {}) {
  const deltas = (stats && Array.isArray(stats.deltas) ? stats.deltas : []).filter(Number.isFinite);
  const total = stats && Number.isFinite(stats.total) && stats.total > 0 ? stats.total : 12;
  const n = deltas.length;
  if (n < minHits) return { ok: false, n, total, minHits, deltas };
  const sorted = [...deltas].sort((a, b) => a - b);
  const med = quantile(sorted, 0.5);
  const spread = (quantile(sorted, 0.75) - quantile(sorted, 0.25)) / 2;
  const rounded = Math.round(med * 1000) / 1000;
  const latency = Math.min(LAT_SETTING_MAX, Math.max(LAT_SETTING_MIN, rounded));
  return {
    ok: true,
    n,
    total,
    minHits,
    deltas,
    median: med,
    latency,
    spread,
    clamped: latency !== rounded,
    unstable: spread > 0.05,
  };
}

/**
 * 검출기 게이트 근사치 (dBFS): detector.js와 같은 식 max(−40 − 25·s, 잡음 바닥 + (11 − 5·s)).
 * 실제 검출기는 잡음 바닥을 직접 추적하므로 화면의 잡음 바닥 추정값으로 근사한다.
 */
export function estimateGateDb(sensitivity, noiseFloor) {
  const s = Number.isFinite(sensitivity) ? Math.min(1, Math.max(0, sensitivity)) : 0.6;
  const base = -40 - 25 * s;
  return Number.isFinite(noiseFloor) ? Math.max(base, noiseFloor + (11 - 5 * s)) : base;
}

/** 지연 슬라이더·±10 버튼 범위 (ms). 자동 측정 결과의 범위(LAT_SETTING_*)와 같다. */
export const LATENCY_RANGE_MS = Object.freeze({ min: LAT_MIN_MS, max: LAT_MAX_MS });

/** 현재 지연(초)에 ms만큼 더한 새 지연(초). 1ms 단위로 반올림하고 설정 범위로 자른다. */
export function nudgeLatency(currentSec, ms) {
  const cur = Number.isFinite(currentSec) ? currentSec : 0;
  return clamp(Math.round(cur * 1000 + (Number.isFinite(ms) ? ms : 0)), LAT_MIN_MS, LAT_MAX_MS) / 1000;
}

/** AudioInput.startMic() 오류(.code) → 사용자 안내 문구. */
export function micErrorMessage(err) {
  const code = err && err.code;
  switch (code) {
    case 'insecure':
      return {
        title: '보안 연결(HTTPS)이 필요해요',
        message: '마이크는 https:// 주소나 localhost에서만 쓸 수 있어요. GitHub Pages 주소(https://…)로 접속해 주세요.',
      };
    case 'denied':
      return {
        title: '마이크 권한이 거부되었어요',
        message: '주소창 왼쪽의 자물쇠(또는 ⓘ) 아이콘 → 권한 → 마이크를 "허용"으로 바꾼 뒤 다시 시도해 주세요. '
          + '삼성 인터넷은 메뉴 → 설정 → 사이트 및 다운로드 → 사이트 권한에서 바꿀 수 있어요.',
      };
    case 'unsupported':
      return {
        title: '이 브라우저는 마이크 입력을 지원하지 않아요',
        message: '최신 Chrome 또는 삼성 인터넷에서 열어 주세요. 메신저 앱 안의 내장 브라우저에서는 동작하지 않을 수 있어요.',
      };
    default: {
      const detail = err && err.message ? ` (${err.message})` : '';
      return {
        title: '마이크를 시작하지 못했어요',
        message: `통화·녹음 앱 등 다른 앱이 마이크를 쓰고 있지 않은지 확인하고 다시 시도해 주세요.${detail}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  let value;
  let checked;
  if (props) {
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v == null || v === false) continue;
      if (key === 'class') node.className = v;
      else if (key === 'text') node.textContent = v;
      else if (key === 'style') node.style.cssText = v;
      else if (key === 'dataset') Object.assign(node.dataset, v);
      else if (key === 'value') value = v;
      else if (key === 'checked') checked = v;
      else if (key.startsWith('on') && typeof v === 'function') node.addEventListener(key.slice(2).toLowerCase(), v);
      else if (key === 'disabled' || key === 'hidden') node[key] = Boolean(v);
      else node.setAttribute(key, v === true ? '' : String(v));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  if (value !== undefined) node.value = String(value);
  if (checked !== undefined) node.checked = Boolean(checked);
  return node;
}

/** replaceChildren that skips null/false (conditional children). */
function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function fmtMs(sec) {
  const ms = Math.round(sec * 1000);
  return `${ms > 0 ? '+' : ''}${ms}ms`;
}

function noteLabel(midi) {
  const m = Math.round(midi);
  return `${noteName(m, 'solfege-octave')} · ${noteName(m, 'en')}`;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

let S = null;

export async function mount(root, params = {}, app) {
  unmount();
  const s = {
    root,
    app,
    input: null,
    inputFailed: false,
    offs: [],
    timer: 0,
    noiseFloor: NaN,
    meterDb: DB_MIN,
    lastPitchAt: 0,
    lastAnalysisAt: 0,
    recent: [],
    startedHere: false,
    busy: false,
    ui: {},
  };
  S = s;

  build(s);

  // 오디오 모듈이 아직 로드 중이면 null → 마이크 버튼을 누를 때 다시 연결한다.
  attachInput(s);
  const settingsOff = app.settings && typeof app.settings.on === 'function'
    ? app.settings.on('change', () => renderSettings(s))
    : null;
  if (typeof settingsOff === 'function') s.offs.push(settingsOff);

  s.timer = setInterval(() => idleTick(s), 250);

  renderMicState(s);
  renderSettings(s);
  resetLiveDisplay(s);

  if (params && params.calibrationResult) showResult(s, params.calibrationResult);
}

/** 공유 AudioInput을 가져와 이벤트를 연결한다 (한 번만). 오디오 모듈을 못 불러왔으면 null. */
function attachInput(s) {
  if (s.input) return s.input;
  let input = null;
  try {
    input = s.app.getInput();
  } catch (err) {
    console.error(err);
    input = null;
  }
  if (!input) return null;
  s.input = input;
  s.offs.push(input.on('analysis', (a) => onAnalysis(s, a)));
  s.offs.push(input.on('note', (ev) => onNote(s, ev)));
  s.offs.push(input.on('state', () => renderMicState(s)));
  return input;
}

export function unmount() {
  const s = S;
  if (!s) return;
  S = null;
  for (const off of s.offs) {
    try { if (typeof off === 'function') off(); } catch (err) { console.error(err); }
  }
  s.offs.length = 0;
  clearInterval(s.timer);
  // 이 화면에서 켠 마이크는 마이크 모드가 아닐 때만 끈다 (마이크 모드면 플레이 화면이 이어서 사용).
  if (s.startedHere && s.input && s.app.settings.get('inputMode') !== 'mic' && s.input.mode === 'mic') {
    try { s.input.stop(); } catch (err) { console.error(err); }
  }
}

function build(s) {
  const { app, ui } = s;

  // --- top bar
  ui.stateChip = el('span', { class: 'chip cal-state-chip', dataset: { state: 'idle' } }, '마이크 꺼짐');
  const topbar = el('header', { class: 'topbar cal-topbar' },
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': '뒤로', title: '뒤로', onClick: () => app.back() }, '←'),
    el('div', { class: 'title' }, '마이크 · 보정'),
    el('div', { class: 'spacer' }),
    ui.stateChip,
  );

  // --- card 1: mic check
  ui.micBtn = el('button', { class: 'btn primary big cal-mic-btn', type: 'button', onClick: () => toggleMic(s) }, '🎤 마이크 켜기');
  ui.micMsg = el('div', { class: 'cal-mic-msg muted' });
  ui.errBox = el('div', { class: 'cal-error', role: 'alert', hidden: true });

  ui.meterFill = el('div', { class: 'cal-meter-fill' });
  ui.meterGate = el('div', { class: 'cal-meter-gate', title: '이 선을 넘는 소리만 음으로 인식해요' });
  ui.dbText = el('span', { class: 'cal-db' }, '-∞ dB');
  ui.gateText = el('span', { class: 'cal-gate-text muted' });
  const meter = el('div', { class: 'cal-meter' },
    el('div', { class: 'cal-meter-track' }, ui.meterFill, ui.meterGate),
    el('div', { class: 'cal-meter-labels' },
      el('span', { class: 'muted' }, '소리 크기'), ui.gateText, el('span', { class: 'spacer' }), ui.dbText),
  );

  ui.noteMain = el('div', { class: 'cal-note-main' }, '—');
  ui.noteSub = el('div', { class: 'cal-note-sub muted' }, '건반을 눌러 보세요');
  ui.needle = el('div', { class: 'cal-needle' });
  ui.centsText = el('div', { class: 'cal-cents-text muted' }, '음정');
  const tuner = el('div', { class: 'cal-tuner', 'aria-hidden': 'true' },
    el('div', { class: 'cal-tuner-scale' },
      el('span', { class: 'cal-tick', style: 'left:0%' }),
      el('span', { class: 'cal-tick', style: 'left:25%' }),
      el('span', { class: 'cal-tick cal-tick-center', style: 'left:50%' }),
      el('span', { class: 'cal-tick', style: 'left:75%' }),
      el('span', { class: 'cal-tick', style: 'left:100%' }),
      ui.needle,
    ),
    el('div', { class: 'cal-tuner-labels muted' }, el('span', null, '-50'), el('span', null, '0'), el('span', null, '+50')),
    ui.centsText,
  );
  const pitchBox = el('div', { class: 'cal-pitch' },
    el('div', { class: 'cal-note' }, ui.noteMain, ui.noteSub),
    tuner,
  );

  ui.chips = el('div', { class: 'cal-chips' });
  ui.chipsEmpty = el('div', { class: 'cal-chips-empty muted' }, '아직 감지된 음이 없어요.');
  const recent = el('div', { class: 'cal-recent' },
    el('div', { class: 'cal-recent-head' },
      el('span', null, '최근 감지된 음'),
      el('button', { class: 'btn ghost small', type: 'button', onClick: () => { s.recent = []; renderChips(s); } }, '지우기'),
    ),
    ui.chipsEmpty,
    ui.chips,
  );

  const cardMic = el('section', { class: 'card cal-card cal-card-mic' },
    el('h2', { class: 'cal-h' }, el('span', { class: 'cal-step' }, '1'), '마이크 확인'),
    el('p', { class: 'cal-lead muted' },
      '태블릿을 피아노 보면대에 올려 두고 건반을 하나씩 눌러 보세요. 친 음이 정확히 표시되면 준비 완료예요.'),
    el('div', { class: 'cal-micbar' }, ui.micBtn, ui.micMsg),
    ui.errBox,
    meter,
    pitchBox,
    recent,
  );

  // --- card 2: input settings
  ui.modeSeg = el('div', { class: 'seg cal-seg', role: 'radiogroup', 'aria-label': '입력 방식' },
    INPUT_MODES.map((m) => el('button', {
      type: 'button', role: 'radio', dataset: { value: m.value },
      onClick: () => setInputMode(s, m.value),
    }, m.label)),
  );
  ui.modeDesc = el('p', { class: 'cal-hint muted' });

  ui.sens = el('input', {
    type: 'range', min: 0, max: 1, step: 0.05, 'aria-label': '마이크 민감도',
    onInput: (e) => setSetting(s, 'sensitivity', clamp(Number(e.target.value), 0, 1)),
  });
  ui.sensVal = el('span', { class: 'cal-val' });

  ui.a4 = el('input', {
    type: 'range', min: 415, max: 466, step: 1, 'aria-label': 'A4 기준음',
    onInput: (e) => setSetting(s, 'a4', clamp(Math.round(Number(e.target.value)), 415, 466)),
  });
  ui.a4Val = el('span', { class: 'cal-val' });

  ui.octave = el('input', {
    type: 'checkbox', role: 'switch', class: 'switch',
    onChange: (e) => setSetting(s, 'octaveTolerant', Boolean(e.target.checked)),
  });

  const cardSettings = el('section', { class: 'card cal-card cal-card-settings' },
    el('h2', { class: 'cal-h' }, el('span', { class: 'cal-step' }, '2'), '입력 설정'),
    el('div', { class: 'cal-field' },
      el('div', { class: 'cal-label' }, '입력 방식'),
      ui.modeSeg,
      ui.modeDesc,
    ),
    el('div', { class: 'cal-field' },
      el('div', { class: 'cal-label' }, '마이크 민감도', ui.sensVal),
      ui.sens,
      el('div', { class: 'cal-range-ends muted' }, el('span', null, '둔감 (잡음 무시)'), el('span', null, '민감 (작은 소리도)')),
      el('p', { class: 'cal-hint muted' },
        '아무것도 치지 않았는데 음이 잡히면 낮추고, 친 음이 잘 안 잡히면 높이세요. 소리 막대의 흰 선을 넘는 소리만 인식해요.'),
    ),
    el('div', { class: 'cal-field' },
      el('div', { class: 'cal-label' }, '기준음 (A4)', ui.a4Val),
      el('div', { class: 'cal-inline' },
        ui.a4,
        el('button', { class: 'btn small ghost', type: 'button', onClick: () => setSetting(s, 'a4', 440) }, '440으로'),
      ),
      el('p', { class: 'cal-hint muted' }, '피아노 조율이 표준(440Hz)과 다를 때만 바꾸세요. 위의 음정 바늘이 늘 한쪽으로 치우치면 조정해 보세요.'),
    ),
    el('label', { class: 'cal-switch-row' },
      el('span', { class: 'cal-switch-text' },
        el('span', { class: 'cal-label' }, '옥타브 무시'),
        el('span', { class: 'cal-hint muted' }, '음 이름만 맞으면 정답으로 인정해요. 낮은 음이 한 옥타브 다르게 잡힐 때 켜 두세요.'),
      ),
      ui.octave,
    ),
  );

  // --- card 3: latency
  ui.latVal = el('div', { class: 'cal-lat-val' });
  ui.lat = el('input', {
    type: 'range', min: LAT_MIN_MS, max: LAT_MAX_MS, step: 5, 'aria-label': '입력 지연 보정 (ms)',
    onInput: (e) => setSetting(s, 'latency', clamp(Number(e.target.value), LAT_MIN_MS, LAT_MAX_MS) / 1000),
  });
  const nudge = (ms) => setSetting(s, 'latency', nudgeLatency(Number(app.settings.get('latency')) || 0, ms));
  ui.result = el('div', { class: 'cal-result', hidden: true, 'aria-live': 'polite' });

  const cardLatency = el('section', { class: 'card cal-card cal-card-latency' },
    el('h2', { class: 'cal-h' }, el('span', { class: 'cal-step' }, '3'), '타이밍(지연) 보정'),
    el('p', { class: 'cal-lead muted' },
      '마이크 소리는 조금 늦게 도착해요. 이 값만큼 판정 시간을 앞당겨서 정확하게 맞춰요. 처음 한 번은 자동 측정을 권장해요.'),
    el('div', { class: 'cal-lat-row' },
      el('button', { class: 'btn small', type: 'button', 'aria-label': '10ms 줄이기', onClick: () => nudge(-10) }, '−10'),
      ui.latVal,
      el('button', { class: 'btn small', type: 'button', 'aria-label': '10ms 늘리기', onClick: () => nudge(10) }, '+10'),
    ),
    ui.lat,
    el('div', { class: 'cal-range-ends muted' }, el('span', null, `${LAT_MIN_MS}ms`), el('span', null, `${LAT_MAX_MS}ms`)),
    el('div', { class: 'cal-auto' },
      el('button', { class: 'btn primary', type: 'button', onClick: () => startAutoMeasure(s) }, '⏱ 자동 측정'),
      el('button', { class: 'btn ghost small', type: 'button', onClick: () => setSetting(s, 'latency', 0.1) }, '기본값 (100ms)'),
    ),
    el('ol', { class: 'cal-steps muted' },
      el('li', null, '자동 측정을 누르면 노트 12개가 1초 간격으로 내려와요.'),
      el('li', null, '노트가 판정선에 닿는 순간 아무 건반이나 한 번씩 쳐 주세요.'),
      el('li', null, '메트로놈 소리는 일부러 꺼 두었어요. 화면만 보고 맞춰 주세요.'),
      el('li', null, '끝나면 이 화면으로 돌아와서 결과를 적용할 수 있어요.'),
    ),
    ui.result,
  );

  const body = el('div', { class: 'cal-body' },
    el('div', { class: 'cal-grid' },
      el('div', { class: 'cal-col' }, cardMic),
      el('div', { class: 'cal-col' }, cardLatency, cardSettings),
    ),
  );

  s.root.append(el('div', { class: 'cal-wrap' }, topbar, body));
}

// ---------------------------------------------------------------------------
// Mic control
// ---------------------------------------------------------------------------

async function toggleMic(s) {
  if (s.busy) return;
  const cur = s.input;
  if (cur && cur.state === 'running' && cur.mode === 'mic') {
    cur.stop();
    s.startedHere = false;
    resetLiveDisplay(s);
    renderMicState(s);
    return;
  }
  s.busy = true;
  hideError(s);
  renderMicState(s);
  try {
    // 사용자 제스처 안에서 가장 먼저 (app.unlockAudio는 마스터 볼륨도 맞춘다).
    // 오디오 모듈이 늦게 로드된 경우를 위해 입력 객체는 잠금 해제를 기다린 뒤에 가져온다.
    await (typeof s.app.unlockAudio === 'function' ? s.app.unlockAudio() : unlockAudio());
    if (S !== s) return;
    const input = attachInput(s);
    if (!input) {
      const err = new Error('오디오 기능을 불러오지 못했어요.');
      err.code = 'unsupported';
      throw err;
    }
    if (input.state === 'running' && input.mode !== 'mic') input.stop();
    await input.startMic();
    if (S !== s) return;
    s.startedHere = true;
    s.noiseFloor = NaN;
  } catch (err) {
    console.error(err);
    if (S !== s) return;
    if (!s.input) s.inputFailed = true;
    showError(s, micErrorMessage(err));
  } finally {
    s.busy = false;
    if (S === s) renderMicState(s);
  }
}

function showError(s, { title, message }) {
  const box = s.ui.errBox;
  fill(box, el('strong', null, title), el('p', null, message));
  box.hidden = false;
}

function hideError(s) {
  s.ui.errBox.hidden = true;
  fill(s.ui.errBox);
}

function renderMicState(s) {
  const { ui, input } = s;
  // 입력 객체가 아직 없으면(오디오 모듈 로드 중) 꺼진 상태로 보여주고, 버튼을 누를 때 다시 시도한다.
  const state = input ? input.state : s.inputFailed ? 'unsupported' : 'idle';
  const mode = input ? input.mode : null;
  const running = state === 'running';
  let label = STATE_LABELS[state] || state;
  if (running && mode === 'sim') label = '시뮬레이션 중';
  ui.stateChip.textContent = running && mode === 'mic' ? `🎤 ${label}` : label;
  ui.stateChip.dataset.state = state;

  const micOn = running && mode === 'mic';
  ui.micBtn.disabled = s.busy || state === 'requesting';
  ui.micBtn.textContent = s.busy || state === 'requesting' ? '권한 요청 중…' : micOn ? '마이크 끄기' : '🎤 마이크 켜기';
  ui.micBtn.classList.toggle('primary', !micOn);

  let msg = '';
  if (micOn) msg = '듣고 있어요. 건반을 눌러 보세요.';
  else if (running && mode === 'sim') msg = '시뮬레이션 입력이 켜져 있어요. 마이크를 켜면 실제 소리로 바뀌어요.';
  else if (state === 'requesting') msg = '브라우저 창에서 마이크 사용을 "허용"해 주세요.';
  else if (state === 'denied') msg = '마이크 권한이 필요해요.';
  else if (state === 'unsupported') msg = '이 브라우저에서는 마이크를 쓸 수 없어요.';
  else msg = '버튼을 누르면 마이크 권한을 요청해요.';
  ui.micMsg.textContent = msg;

  if (!running) resetLiveDisplay(s);
}

// ---------------------------------------------------------------------------
// Live analysis display
// ---------------------------------------------------------------------------

function onAnalysis(s, a) {
  if (!a) return;
  const { ui } = s;
  const now = performance.now();
  s.lastAnalysisAt = now;

  const db = Number.isFinite(a.db) ? a.db : -120;
  // 잡음 바닥 근사: 빠르게 내려가고 천천히 올라감
  if (!Number.isFinite(s.noiseFloor)) s.noiseFloor = db;
  else if (db < s.noiseFloor) s.noiseFloor += (db - s.noiseFloor) * 0.3;
  else s.noiseFloor += (db - s.noiseFloor) * 0.004;
  s.noiseFloor = Math.max(-110, s.noiseFloor);

  s.meterDb = db >= s.meterDb ? db : Math.max(db, s.meterDb - 1.8);
  const pct = clamp((s.meterDb - DB_MIN) / (DB_MAX - DB_MIN), 0, 1);
  ui.meterFill.style.transform = `scaleX(${pct.toFixed(3)})`;
  ui.meterFill.classList.toggle('open', Boolean(a.gateOpen));
  ui.dbText.textContent = db <= -119 ? '-∞ dB' : `${Math.round(db)} dB`;

  const gate = estimateGateDb(Number(s.app.settings.get('sensitivity')), s.noiseFloor);
  const gp = clamp((gate - DB_MIN) / (DB_MAX - DB_MIN), 0, 1);
  ui.meterGate.style.left = `${(gp * 100).toFixed(1)}%`;
  ui.gateText.textContent = `인식 기준 ≈ ${Math.round(gate)} dB`;

  const p = a.pitch;
  if (p && Number.isFinite(p.midi) && Number.isFinite(p.freq) && (p.clarity == null || p.clarity >= 0.5)) {
    const m = Math.round(p.midi);
    const a4 = Number(s.app.settings.get('a4')) || 440;
    const cents = clamp(centsOff(p.freq, m, a4), -50, 50);
    s.lastPitchAt = now;
    ui.noteMain.textContent = noteName(m, 'solfege-octave');
    ui.noteSub.textContent = `${noteName(m, 'en')} · ${p.freq.toFixed(1)} Hz`;
    ui.noteMain.parentElement.classList.remove('stale');
    ui.needle.style.left = `${(50 + cents).toFixed(1)}%`;
    ui.needle.classList.toggle('good', Math.abs(cents) <= 10);
    ui.needle.classList.add('on');
    const c = Math.round(cents);
    ui.centsText.textContent = c === 0 ? '정확해요' : `${c > 0 ? '+' : ''}${c} 센트 ${c > 0 ? '(높음)' : '(낮음)'}`;
  }
}

function idleTick(s) {
  const now = performance.now();
  if (s.lastPitchAt && now - s.lastPitchAt > 600) {
    s.ui.noteMain.parentElement.classList.add('stale');
    s.ui.needle.classList.remove('on');
  }
  if (s.lastAnalysisAt && now - s.lastAnalysisAt > 800) {
    s.lastAnalysisAt = 0;
    resetMeter(s);
  }
}

function resetMeter(s) {
  s.meterDb = DB_MIN;
  s.ui.meterFill.style.transform = 'scaleX(0)';
  s.ui.meterFill.classList.remove('open');
  s.ui.dbText.textContent = '-∞ dB';
  const gate = estimateGateDb(Number(s.app.settings.get('sensitivity')), NaN);
  const gp = clamp((gate - DB_MIN) / (DB_MAX - DB_MIN), 0, 1);
  s.ui.meterGate.style.left = `${(gp * 100).toFixed(1)}%`;
  s.ui.gateText.textContent = `인식 기준 ≈ ${Math.round(gate)} dB`;
}

function resetLiveDisplay(s) {
  resetMeter(s);
  s.lastPitchAt = 0;
  s.ui.noteMain.textContent = '—';
  s.ui.noteSub.textContent = '건반을 눌러 보세요';
  s.ui.noteMain.parentElement.classList.add('stale');
  s.ui.needle.classList.remove('on', 'good');
  s.ui.needle.style.left = '50%';
  s.ui.centsText.textContent = '음정';
}

function onNote(s, ev) {
  if (!ev || !Number.isFinite(ev.midi)) return;
  s.recent.unshift({ midi: Math.round(ev.midi), strength: ev.strength, source: ev.source, at: performance.now() });
  if (s.recent.length > MAX_CHIPS) s.recent.length = MAX_CHIPS;
  renderChips(s, true);
}

function renderChips(s, flashFirst = false) {
  const { ui } = s;
  ui.chipsEmpty.hidden = s.recent.length > 0;
  fill(ui.chips, ...s.recent.map((n, i) => {
    const strength = Number.isFinite(n.strength) ? clamp(n.strength, 0, 1) : 1;
    const chip = el('span', {
      class: `chip cal-note-chip${n.source === 'pitch-change' ? ' legato' : ''}${i === 0 && flashFirst ? ' new' : ''}`,
      style: `opacity:${(0.55 + 0.45 * strength).toFixed(2)}`,
      title: n.source === 'pitch-change' ? '음높이 변화로 감지' : '타건으로 감지',
    }, noteLabel(n.midi));
    return chip;
  }));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function setSetting(s, key, value) {
  const { app, input } = s;
  try {
    app.settings.set(key, value);
  } catch (err) {
    console.error(err);
    app.toast('설정을 저장하지 못했어요.', 'error');
    return;
  }
  if (input) {
    try {
      if (key === 'sensitivity' && typeof input.setSensitivity === 'function') input.setSensitivity(app.settings.get('sensitivity'));
      if (key === 'a4' && typeof input.setA4 === 'function') input.setA4(app.settings.get('a4'));
    } catch (err) {
      console.error(err);
    }
  }
  renderSettings(s);
}

function setInputMode(s, mode) {
  const { app } = s;
  setSetting(s, 'inputMode', mode);
  if (app.settings.get('inputMode') !== mode) {
    app.toast('주소에 붙은 ?input= 설정이 우선 적용되고 있어요. 주소에서 지우면 바뀌어요.', 'error');
  }
}

function renderSettings(s) {
  const { ui, app } = s;
  if (!ui.modeSeg) return;
  const st = app.settings;
  const mode = st.get('inputMode');
  for (const btn of ui.modeSeg.children) {
    const on = btn.dataset.value === mode;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  const info = INPUT_MODES.find((m) => m.value === mode);
  ui.modeDesc.textContent = info ? info.desc : '';

  const sens = Number(st.get('sensitivity'));
  if (document.activeElement !== ui.sens) ui.sens.value = String(sens);
  syncRange(ui.sens);
  ui.sensVal.textContent = `${Math.round(sens * 100)}%`;

  const a4 = Number(st.get('a4'));
  if (document.activeElement !== ui.a4) ui.a4.value = String(a4);
  syncRange(ui.a4);
  ui.a4Val.textContent = `${a4} Hz`;

  ui.octave.checked = Boolean(st.get('octaveTolerant'));

  const lat = Number(st.get('latency')) || 0;
  if (document.activeElement !== ui.lat) ui.lat.value = String(clamp(Math.round(lat * 1000), LAT_MIN_MS, LAT_MAX_MS));
  syncRange(ui.lat);
  ui.latVal.textContent = `${Math.round(lat * 1000)} ms`;
}

// ---------------------------------------------------------------------------
// Auto latency measurement
// ---------------------------------------------------------------------------

async function startAutoMeasure(s) {
  const { app } = s;
  if (app.settings.get('inputMode') !== 'mic') {
    const ok = await confirmDialog({
      title: '마이크 입력으로 바꿀까요?',
      message: '자동 측정은 마이크로 들은 소리의 지연을 재요. 입력 방식을 마이크로 바꾼 뒤 측정할게요.',
      okText: '마이크로 바꾸기',
      cancelText: '취소',
    });
    if (!ok || S !== s) return;
    setSetting(s, 'inputMode', 'mic');
    if (app.settings.get('inputMode') !== 'mic') {
      app.toast('주소의 ?input= 설정 때문에 입력 방식을 바꿀 수 없어요.', 'error');
      return;
    }
  }
  app.go('play', { song: makeCalibrationSong(), mode: 'calibrate', returnTo: 'calibrate' });
}

function showResult(s, stats) {
  const { ui, app } = s;
  const r = analyzeCalibration(stats);
  const box = ui.result;
  box.hidden = false;
  box.classList.toggle('bad', !r.ok);

  const close = () => { box.hidden = true; fill(box); };
  const retry = el('button', { class: 'btn', type: 'button', onClick: () => startAutoMeasure(s) }, '다시 측정');

  if (!r.ok) {
    fill(box,
      el('div', { class: 'cal-result-title' }, '측정하지 못했어요'),
      el('p', null, `감지된 타건이 ${r.n}개뿐이에요 (최소 ${r.minHits}개 필요). `
        + '마이크가 켜져 있고 건반을 칠 때 소리 막대가 움직이는지 확인한 뒤, 노트가 선에 닿을 때 또렷하게 쳐 주세요.'),
      el('div', { class: 'cal-result-actions' },
        retry,
        el('button', { class: 'btn ghost', type: 'button', onClick: close }, '닫기'),
      ),
    );
    return;
  }

  const cur = Number(app.settings.get('latency')) || 0;
  const ms = Math.round(r.latency * 1000);
  const spreadMs = Math.round(r.spread * 1000);
  const warnings = [];
  if (r.unstable) warnings.push('타이밍 편차가 커요. 노트가 선에 닿는 순간에 맞춰 다시 측정하면 더 정확해져요.');
  if (r.clamped) warnings.push(`측정값(${Math.round(r.median * 1000)}ms)이 허용 범위를 벗어나서 ${ms}ms로 맞췄어요.`);
  if (r.n < r.total * 0.6) warnings.push(`${r.total}개 중 ${r.n}개만 감지됐어요. 민감도를 조금 높여 보세요.`);

  fill(box,
    el('div', { class: 'cal-result-title' }, '측정 결과'),
    el('div', { class: 'cal-result-main' },
      el('span', { class: 'cal-result-ms' }, `${ms} ms`),
      el('span', { class: 'muted' }, `현재 ${Math.round(cur * 1000)} ms`),
    ),
    el('div', { class: 'cal-result-sub muted' }, `감지 ${r.n}/${r.total}개 · 편차 ±${spreadMs}ms`),
    deltaStrip(r.deltas, r.median),
    warnings.length ? el('ul', { class: 'cal-result-warn' }, warnings.map((w) => el('li', null, w))) : null,
    el('div', { class: 'cal-result-actions' },
      el('button', {
        class: 'btn primary', type: 'button',
        onClick: () => {
          setSetting(s, 'latency', r.latency);
          app.toast(`지연 보정을 ${ms}ms로 적용했어요.`, 'success');
          close();
        },
      }, '적용'),
      retry,
      el('button', { class: 'btn ghost', type: 'button', onClick: close }, '취소'),
    ),
  );
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** 측정된 delta들을 −100..+500ms 축 위의 점으로 보여준다. */
function deltaStrip(deltas, med) {
  const lo = -0.1;
  const hi = 0.5;
  const pos = (v) => `${(clamp((v - lo) / (hi - lo), 0, 1) * 100).toFixed(1)}%`;
  return el('div', { class: 'cal-strip', 'aria-hidden': 'true' },
    el('div', { class: 'cal-strip-axis' },
      el('span', { class: 'cal-strip-zero', style: `left:${pos(0)}` }),
      deltas.map((d) => el('span', { class: 'cal-strip-dot', style: `left:${pos(d)}`, title: fmtMs(d) })),
      el('span', { class: 'cal-strip-med', style: `left:${pos(med)}` }),
    ),
    el('div', { class: 'cal-strip-labels muted' },
      el('span', { style: 'left:0%' }, '-100ms'),
      el('span', { style: `left:${pos(0)}` }, '0'),
      el('span', { style: `left:${pos(0.2)}` }, '200'),
      el('span', { style: 'left:100%' }, '+500ms')),
  );
}
