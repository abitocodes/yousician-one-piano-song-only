// Home: song library grid, input-mode chip, first-visit tips, song import.

import { h, toast, modal, pickFile, formatTime, formatNumber, listen } from '../ui/dom.js';
import { normalizeSong, songDuration } from '../core/song.js';
import { safeLocalStorage } from '../core/storage.js';

const TIP_KEY = 'pk.tipDismissed';

export const INPUT_MODES = [
  { value: 'mic', icon: '🎤', label: '마이크', desc: '실제 피아노 소리를 마이크로 듣고 음정과 타이밍을 판정해요.' },
  { value: 'touch', icon: '👆', label: '터치', desc: '화면 아래 건반을 직접 눌러서 플레이해요. 마이크가 필요 없어요.' },
  { value: 'sim', icon: '🤖', label: '시뮬레이션', desc: '자동 연주 소리를 판정기에 넣어 동작을 확인하는 테스트 모드예요.' },
];

export function inputModeInfo(mode) {
  return INPUT_MODES.find((m) => m.value === mode) || INPUT_MODES[0];
}

const BLACK = new Set([1, 3, 6, 8, 10]);

let cleanups = [];
let renderToken = 0;

function makeSongId() {
  return `song-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Picks a .json file holding one song, an array of songs, or { songs: [...] } and saves them. → imported count */
export async function importSongs(app) {
  const file = await pickFile('.json,application/json');
  if (!file) return 0;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('JSON 파일을 읽을 수 없어요. 피아노 노래방에서 내보낸 곡 파일인지 확인해 주세요.', { type: 'error' });
    return 0;
  }
  const raws = Array.isArray(data) ? data : (Array.isArray(data?.songs) ? data.songs : [data]);
  const songs = [];
  const errors = [];
  for (const raw of raws) {
    try {
      songs.push(normalizeSong(raw));
    } catch (err) {
      errors.push(err?.message || '곡 파일 형식이 올바르지 않아요.');
    }
  }
  if (!songs.length) {
    toast(errors[0] || '곡 파일 형식이 올바르지 않아요.', { type: 'error' });
    return 0;
  }

  const existingUser = new Set((await app.library.userSongs()).map((s) => s.id));
  const conflicts = songs.filter((s) => existingUser.has(s.id));
  let strategy = 'overwrite';
  if (conflicts.length) {
    strategy = await new Promise((resolve) => {
      let choice = null;
      modal({
        title: '같은 곡이 이미 있어요',
        content: `${conflicts.map((s) => `"${s.title || '제목 없음'}"`).slice(0, 3).join(', ')}${conflicts.length > 3 ? ` 외 ${conflicts.length - 3}곡` : ''}이(가) 이미 내 곡에 있어요. 어떻게 할까요?`,
        actions: [
          { text: '취소', onClick: () => { choice = null; } },
          { text: '사본으로 추가', onClick: () => { choice = 'copy'; } },
          { text: '덮어쓰기', primary: true, onClick: () => { choice = 'overwrite'; } },
        ],
        onClose: () => resolve(choice),
      });
    });
    if (!strategy) return 0;
  }

  let count = 0;
  let withAudio = 0;
  for (const s of songs) {
    if (strategy === 'copy' && existingUser.has(s.id)) {
      s.id = makeSongId();
      s.title = `${s.title || '제목 없음'} (사본)`;
    }
    try {
      await app.library.save(s);
      count++;
      if (s.audio) withAudio++;
    } catch (err) {
      errors.push(err?.message || '저장 실패');
    }
  }
  if (count) toast(`곡 ${count}개를 가져왔어요.`, { type: 'success' });
  if (withAudio) toast('반주 음원은 곡 파일에 포함되지 않아요. 편집 화면에서 음원 파일을 다시 선택해 주세요.', { duration: 5000 });
  if (errors.length) toast(`${errors.length}개는 가져오지 못했어요: ${errors[0]}`, { type: 'error' });
  return count;
}

function songArt(song) {
  const notes = song.notes || [];
  if (!notes.length) {
    return h('div', { class: 'song-art empty', 'aria-hidden': 'true' }, h('span', {}, '♪ 아직 악보가 없어요'));
  }
  const W = 320;
  const H = 80;
  let end = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of notes) {
    end = Math.max(end, n.t + n.d);
    lo = Math.min(lo, n.m);
    hi = Math.max(hi, n.m);
  }
  const start = Math.min(...notes.map((n) => n.t));
  const span = Math.max(0.5, end - start);
  if (hi - lo < 8) {
    const pad = (8 - (hi - lo)) / 2;
    lo -= pad;
    hi += pad;
  }
  const rows = hi - lo + 1;
  const barH = Math.max(3, Math.min(9, (H - 12) / rows));
  const step = Math.max(1, Math.ceil(notes.length / 400));
  const rects = [];
  for (let i = 0; i < notes.length; i += step) {
    const n = notes[i];
    const x = 6 + ((n.t - start) / span) * (W - 12);
    const w = Math.max(2, (n.d / span) * (W - 12) - 1.5);
    const y = 6 + (1 - (n.m - lo) / Math.max(1, hi - lo)) * (H - 12 - barH);
    rects.push(h('rect', {
      class: BLACK.has(((Math.round(n.m) % 12) + 12) % 12) ? 'b' : 'w',
      x: x.toFixed(1),
      y: y.toFixed(1),
      width: w.toFixed(1),
      height: barH.toFixed(1),
      rx: '1.5',
    }));
  }
  return h('div', { class: 'song-art', 'aria-hidden': 'true' },
    h('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' }, rects));
}

function howToModal(app, song) {
  const steps = [
    ['🎹 MIDI 가져오기', '가지고 있는 MIDI 파일을 열고 멜로디 트랙을 고르면 노트가 자동으로 만들어져요.'],
    ['🎤 피아노로 녹음', '피아노로 멜로디를 치면 마이크가 음을 듣고 받아 적어요. 박자에 맞춰 정리(퀀타이즈)할 수 있어요.'],
    ['⌨️ 텍스트로 입력', '"C4 D4 E4:2" 또는 "도4 레4 미4:2"처럼 음 이름과 박자를 적어요.'],
    ['📝 가사 붙여넣기', '한 줄에 한 소절씩 붙여넣으면 한 글자가 노트 하나에 자동으로 배치돼요. LRC 파일도 가져올 수 있어요.'],
  ];
  modal({
    title: `"${song.title}" 악보 만드는 방법`,
    content: h('div', { class: 'stack howto' },
      steps.map(([title, desc]) => h('div', { class: 'howto-step' }, h('strong', {}, title), h('p', { class: 'muted' }, desc))),
      h('p', { class: 'muted small' }, '완성한 곡은 곡 파일(.json)로 내보내 다른 기기에서도 가져올 수 있어요.')),
    actions: [
      { text: '닫기' },
      { text: '악보 만들기', primary: true, onClick: () => { app.go('editor', { songId: song.id }); } },
    ],
  });
}

function inputModeModal(app, onPicked) {
  const current = app.settings.get('inputMode');
  let dlg = null;
  const options = INPUT_MODES.map((m) => h('button', {
    type: 'button',
    class: ['mode-option', m.value === current && 'active'],
    'aria-pressed': m.value === current ? 'true' : 'false',
    onClick: () => {
      app.settings.set('inputMode', m.value);
      onPicked?.();
      dlg?.close();
    },
  },
  h('span', { class: 'mode-icon' }, m.icon),
  h('span', { class: 'mode-text' }, h('strong', {}, m.label), h('span', { class: 'muted' }, m.desc))));
  dlg = modal({
    title: '입력 방식',
    content: h('div', { class: 'stack' }, options,
      app.settings.isOverridden?.('inputMode')
        ? h('p', { class: 'muted small' }, '지금은 주소의 ?input= 값이 적용되어 있어요. 여기서 고르면 그 값 대신 저장돼요.')
        : null),
    actions: [{ text: '닫기' }],
  });
}

export async function mount(root, params, app) {
  cleanups = [];
  root.classList.add('home-screen');

  // ---- top bar
  const chip = h('button', { type: 'button', class: 'chip input-chip', title: '입력 방식 바꾸기' });
  const updateChip = () => {
    const info = inputModeInfo(app.settings.get('inputMode'));
    chip.replaceChildren(h('span', { 'aria-hidden': 'true' }, info.icon), ` ${info.label}`);
    chip.dataset.mode = info.value;
  };
  updateChip();
  chip.addEventListener('click', () => inputModeModal(app, updateChip));

  const fsBtn = h('button', { type: 'button', class: 'btn ghost small fs-btn' });
  const updateFs = () => {
    const on = app.isFullscreen();
    fsBtn.replaceChildren(h('span', { 'aria-hidden': 'true' }, on ? '🗗' : '⛶'), h('span', { class: 'btn-label' }, on ? ' 전체화면 해제' : ' 전체화면'));
  };
  updateFs();
  fsBtn.hidden = !app.fullscreenSupported();
  fsBtn.addEventListener('click', async () => {
    await app.toggleFullscreen();
    updateFs();
  });

  const topbar = h('header', { class: 'topbar home-topbar' },
    h('div', { class: 'brand' },
      h('img', { class: 'brand-logo', src: 'icons/icon-192.png', alt: '', width: '40', height: '40' }),
      h('div', { class: 'title' }, '피아노 노래방')),
    h('div', { class: 'spacer' }),
    chip,
    h('button', { type: 'button', class: 'btn ghost small', onClick: () => app.go('calibrate') },
      h('span', { 'aria-hidden': 'true' }, '🎚️'), h('span', { class: 'btn-label' }, ' 마이크·보정')),
    h('button', { type: 'button', class: 'btn ghost small', onClick: () => app.go('settings') },
      h('span', { 'aria-hidden': 'true' }, '⚙️'), h('span', { class: 'btn-label' }, ' 설정')),
    fsBtn);

  // ---- notices
  const notices = h('div', { class: 'home-notices stack' });
  const storage = safeLocalStorage();
  let tipDismissed = false;
  try { tipDismissed = storage.getItem(TIP_KEY) === '1'; } catch { /* ignore */ }
  if (!tipDismissed) {
    const tip = h('section', { class: 'card tip-card' },
      h('div', { class: 'tip-head' }, h('span', { class: 'tip-icon', 'aria-hidden': 'true' }, '💡'), h('h2', {}, '처음 오셨나요?')),
      h('ol', { class: 'tip-list' },
        h('li', {}, '태블릿을 피아노 보면대에 세워 두세요. 마이크가 피아노를 향하면 더 정확해요.'),
        h('li', {}, '시작할 때 마이크 권한을 꼭 ', h('strong', {}, '허용'), '해 주세요.'),
        h('li', {}, '처음 한 번은 ', h('strong', {}, '마이크·보정'), '에서 타이밍(지연)을 맞춰 주세요.'),
        h('li', {}, '가로 모드와 전체화면을 추천해요. 노래방처럼 가사를 보면서 함께 불러 보세요!')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary small', onClick: () => app.go('calibrate') }, '보정하러 가기'),
        h('button', {
          type: 'button',
          class: 'btn ghost small',
          onClick: () => {
            try { storage.setItem(TIP_KEY, '1'); } catch { /* ignore */ }
            tip.remove();
          },
        }, '알겠어요')));
    notices.append(tip);
  }
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    notices.append(h('div', { class: 'card notice warn' },
      h('strong', {}, '⚠️ 마이크를 쓸 수 없는 주소예요'),
      h('p', { class: 'muted' }, 'HTTPS 주소(예: GitHub Pages)로 접속해야 마이크를 쓸 수 있어요. 지금은 터치 모드로 플레이할 수 있어요.')));
  }
  if (!app.library.persistent) {
    notices.append(h('div', { class: 'card notice' },
      h('strong', {}, 'ℹ️ 곡이 이 기기에 저장되지 않아요'),
      h('p', { class: 'muted' }, '이 브라우저에서는 저장소를 쓸 수 없어 새로고침하면 만든 곡이 사라져요. 편집 화면에서 곡 파일로 내보내 두세요.')));
  }

  // ---- song lists
  const builtinGrid = h('div', { class: 'grid song-grid' });
  const userGrid = h('div', { class: 'grid song-grid' });
  const body = h('div', { class: 'home-body' },
    notices,
    h('section', { class: 'song-section' },
      h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, '기본 곡')),
      builtinGrid),
    h('section', { class: 'song-section' },
      h('div', { class: 'section-head' },
        h('h2', { class: 'section-title' }, '내 곡'),
        h('div', { class: 'spacer' })),
      userGrid),
    h('footer', { class: 'home-footer row' },
      h('button', { type: 'button', class: 'btn primary', onClick: () => app.go('editor', {}) }, '+ 새 곡 만들기'),
      h('button', { type: 'button', class: 'btn', onClick: () => importSongs(app) }, '곡 파일 가져오기(.json)'),
      h('div', { class: 'spacer' }),
      h('span', { class: 'muted small' }, `v${app.version || ''}`)));

  root.append(topbar, body);

  async function startSong(song, mode) {
    let audioBlob = null;
    if (song.audio) {
      try { audioBlob = await app.library.getAudio(song.id); } catch { /* play without backing */ }
    }
    app.go('play', { songId: song.id, mode, audioBlob });
  }

  function card(song) {
    const isTemplate = !!song.template || !(song.notes && song.notes.length);
    const isOverride = app.library.isBuiltin(song.id) && !song.builtin;
    const record = app.scores.get(song.id);
    const best = record.best;
    const badges = [];
    if (song.template) badges.push(h('span', { class: 'badge accent' }, '템플릿'));
    else if (song.builtin) badges.push(h('span', { class: 'badge' }, '기본'));
    if (isOverride) badges.push(h('span', { class: 'badge accent' }, '내가 만든 악보'));
    if (song.audio) badges.push(h('span', { class: 'badge' }, '🎵 반주'));

    const metaParts = [];
    if (!isTemplate) {
      metaParts.push(`노트 ${song.notes.length}개`);
      metaParts.push(formatTime(songDuration(song)));
      metaParts.push(`♩ ${Math.round(song.bpm || 100)}`);
      const lyricLines = song.lyrics?.lines?.length || 0;
      metaParts.push(lyricLines ? `가사 ${lyricLines}줄` : '가사 없음');
    }

    const info = h('div', { class: 'song-info' },
      h('div', { class: 'song-title-row' }, h('h3', { class: 'song-title' }, song.title || '제목 없음'), badges),
      h('div', { class: 'song-artist muted' }, song.artist || '아티스트 미상'),
      metaParts.length ? h('div', { class: 'song-meta' }, metaParts.join(' · ')) : null,
      isTemplate && song.description ? h('p', { class: 'song-desc muted' }, song.description) : null,
      !isTemplate ? h('div', { class: 'song-best' },
        best
          ? [h('span', { class: `rank-badge rank-${best.rank}` }, best.rank),
            h('span', {}, ` 최고 ${formatNumber(best.score)}점 · ${Math.round(best.accuracy * 100)}%`)]
          : h('span', { class: 'muted' }, '아직 기록이 없어요'),
        record.plays ? h('span', { class: 'muted' }, ` · ${record.plays}회 플레이`) : null) : null);

    let actions;
    if (isTemplate) {
      actions = h('div', { class: 'song-actions' },
        h('button', { type: 'button', class: 'btn primary', onClick: () => app.go('editor', { songId: song.id }) }, '✏️ 악보 만들기'),
        h('button', { type: 'button', class: 'btn ghost', onClick: () => howToModal(app, song) }, '만드는 방법'));
    } else {
      actions = h('div', { class: 'song-actions' },
        h('button', { type: 'button', class: 'btn primary', onClick: () => startSong(song, 'play') }, '▶ 플레이'),
        h('button', { type: 'button', class: 'btn', title: '노트가 올 때까지 기다려 주는 연습 모드', onClick: () => startSong(song, 'practice') }, '연습'),
        h('button', { type: 'button', class: 'btn', onClick: () => startSong(song, 'listen') }, '듣기'),
        h('button', { type: 'button', class: 'btn ghost', 'aria-label': `${song.title} 편집`, onClick: () => app.go('editor', { songId: song.id }) }, '편집'));
    }
    return h('article', { class: ['card', 'song-card', isTemplate && 'template'], dataset: { id: song.id } },
      songArt(song), info, actions);
  }

  async function render() {
    const my = ++renderToken;
    let songs;
    try {
      songs = await app.library.list();
    } catch (err) {
      console.error(err);
      toast('곡 목록을 불러오지 못했어요.', { type: 'error' });
      return;
    }
    if (my !== renderToken) return;
    const builtins = songs.filter((s) => app.library.isBuiltin(s.id));
    const users = songs.filter((s) => !app.library.isBuiltin(s.id));
    builtinGrid.replaceChildren(...builtins.map(card));
    if (users.length) userGrid.replaceChildren(...users.map(card));
    else {
      userGrid.replaceChildren(h('div', { class: 'card empty-card' },
        h('p', {}, '아직 만든 곡이 없어요.'),
        h('p', { class: 'muted small' }, 'MIDI 파일을 가져오거나 피아노로 녹음해서 나만의 곡을 만들어 보세요.'),
        h('button', { type: 'button', class: 'btn primary small', onClick: () => app.go('editor', {}) }, '+ 새 곡 만들기')));
    }
  }

  cleanups.push(app.library.on('change', () => render()));
  cleanups.push(app.settings.on('change', (key) => {
    if (key === 'inputMode') updateChip();
  }));
  cleanups.push(listen(document, 'fullscreenchange', updateFs));
  cleanups.push(listen(document, 'webkitfullscreenchange', updateFs));
  await render();
}

export function unmount() {
  renderToken++;
  for (const fn of cleanups) {
    try { if (typeof fn === 'function') fn(); } catch { /* ignore */ }
  }
  cleanups = [];
}
