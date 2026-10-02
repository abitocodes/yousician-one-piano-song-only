// Settings screen: every option from DEFAULT_SETTINGS with live labels, data import/export, troubleshooting.

import { h, toast, confirmDialog, downloadFile, syncRange } from '../ui/dom.js';
import { importSongs, INPUT_MODES } from './home.js';
import { WINDOWS } from '../game/judge.js';

let cleanups = [];

const ms = (s) => Math.round(s * 1000);

function segField(app, key, label, options, hint) {
  const buttons = options.map((o) => h('button', {
    type: 'button',
    role: 'radio',
    dataset: { value: String(o.value) },
    onClick: () => app.settings.set(key, o.value),
  }, o.label));
  const hintEl = hint ? h('small', { class: 'hint' }) : null;
  const sync = () => {
    const v = String(app.settings.get(key));
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    if (hintEl) hintEl.textContent = typeof hint === 'function' ? hint(app.settings.get(key)) : hint;
  };
  sync();
  const el = h('div', { class: 'field' },
    h('span', { class: 'label' }, label),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label }, buttons),
    hintEl);
  return { el, sync };
}

function sliderField(app, key, label, { min, max, step, toUi = (v) => v, fromUi = (v) => v, format, hint }) {
  const value = h('output', { class: 'value' });
  const input = h('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(toUi(app.settings.get(key))),
    'aria-label': label,
  });
  input.addEventListener('input', () => {
    app.settings.set(key, fromUi(Number(input.value)));
    value.textContent = format(app.settings.get(key));
  });
  const sync = () => {
    const ui = toUi(app.settings.get(key));
    if (Math.abs(Number(input.value) - ui) > 1e-9) input.value = String(ui);
    syncRange(input);
    value.textContent = format(app.settings.get(key));
  };
  sync();
  const el = h('div', { class: 'field slider-field' },
    h('div', { class: 'field-head' }, h('span', { class: 'label' }, label), value),
    input,
    hint ? h('small', { class: 'hint' }, hint) : null);
  return { el, sync };
}

function switchField(app, key, label, hint) {
  const input = h('input', {
    type: 'checkbox',
    class: 'switch',
    role: 'switch',
    checked: !!app.settings.get(key),
    onChange: () => app.settings.set(key, input.checked),
  });
  const sync = () => {
    input.checked = !!app.settings.get(key);
  };
  const el = h('label', { class: 'field inline switch-field' },
    h('span', { class: 'field-text' }, h('span', { class: 'label' }, label), hint ? h('small', { class: 'hint' }, hint) : null),
    input);
  return { el, sync };
}

function group(title, icon, ...children) {
  return h('section', { class: 'card settings-group' },
    h('h2', { class: 'group-title' }, h('span', { 'aria-hidden': 'true' }, icon), ` ${title}`),
    h('div', { class: 'stack' }, children));
}

function infoRow(label, value, ok) {
  return h('div', { class: 'info-row' },
    h('span', { class: 'muted' }, label),
    h('span', { class: ok === false ? 'bad' : ok === true ? 'good' : '' }, value));
}

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export async function mount(root, params, app) {
  cleanups = [];
  root.classList.add('settings-screen');
  const fields = new Map();
  const add = (key, field) => {
    fields.set(key, field);
    return field.el;
  };

  const inputModeField = segField(app, 'inputMode', '입력 방식',
    INPUT_MODES.map((m) => ({ value: m.value, label: `${m.icon} ${m.label}` })),
    (v) => {
      const info = INPUT_MODES.find((m) => m.value === v);
      const over = app.settings.isOverridden?.('inputMode') ? ' (주소의 ?input= 값이 이번 세션에만 적용 중이에요)' : '';
      return `${info ? info.desc : ''}${over}`;
    });

  const windowsHint = (d) => {
    const w = WINDOWS[d] || WINDOWS.normal;
    return `판정 범위 — PERFECT ±${ms(w.perfect)}ms · GREAT ±${ms(w.great)}ms · GOOD ±${ms(w.good)}ms`;
  };

  const inputGroup = group('입력 · 마이크', '🎤',
    add('inputMode', inputModeField),
    add('sensitivity', sliderField(app, 'sensitivity', '마이크 감도', {
      min: 0, max: 1, step: 0.05,
      format: (v) => `${Math.round(v * 100)}%`,
      hint: '높을수록 작은 소리도 감지해요. 주변 소리까지 판정되면 낮춰 주세요.',
    })),
    add('latency', sliderField(app, 'latency', '입력 지연 보정', {
      min: -100, max: 500, step: 5,
      toUi: (v) => Math.round(v * 1000),
      fromUi: (v) => v / 1000,
      format: (v) => `${ms(v)} ms`,
      hint: '마이크 소리가 늦게 도착하는 만큼 빼 줘요. 보정 화면의 "자동 측정"을 추천해요.',
    })),
    add('a4', sliderField(app, 'a4', '기준음 (A4)', {
      min: 415, max: 466, step: 1,
      format: (v) => `${Math.round(v * 10) / 10} Hz`,
      hint: '피아노가 표준 음높이(440Hz)와 다르게 조율되어 있다면 맞춰 주세요.',
    })),
    add('octaveTolerant', switchField(app, 'octaveTolerant', '옥타브 무시',
      '같은 계이름이면 다른 옥타브로 쳐도 정답으로 인정해요. 마이크가 옥타브를 헷갈릴 때 켜 두세요.')),
    add('showDetected', switchField(app, 'showDetected', '감지된 음 표시', '마이크가 들은 음을 화면 건반에 표시해요.')),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', onClick: () => app.go('calibrate') }, '🎚️ 보정 화면 열기')));

  const playGroup = group('게임플레이', '🎮',
    add('difficulty', segField(app, 'difficulty', '난이도', [
      { value: 'easy', label: '쉬움' },
      { value: 'normal', label: '보통' },
      { value: 'hard', label: '어려움' },
    ], windowsHint)),
    add('speed', sliderField(app, 'speed', '재생 속도', {
      min: 0.5, max: 1.25, step: 0.05,
      format: (v) => `${Math.round(v * 100)}%`,
      hint: '느리게 연습한 다음 100%로 도전해 보세요.',
    })),
    add('lookahead', sliderField(app, 'lookahead', '노트가 보이는 시간', {
      min: 1.2, max: 5, step: 0.1,
      format: (v) => `${v.toFixed(1)}초`,
      hint: '짧을수록 노트가 빨리 떨어지고, 길수록 미리 볼 수 있어요.',
    })),
    add('labelStyle', segField(app, 'labelStyle', '노트 이름', [
      { value: 'solfege', label: '도레미' },
      { value: 'en', label: 'C4' },
      { value: 'none', label: '없음' },
    ])),
    add('showLyrics', switchField(app, 'showLyrics', '가사 표시', '노래방처럼 부를 곳의 가사 색이 바뀌어요.')),
    add('guideMelody', switchField(app, 'guideMelody', '가이드 멜로디',
      '플레이 중 멜로디를 소리로 들려줘요. 마이크가 이 소리를 들을 수 있으니 이어폰을 추천해요.')),
    add('metronome', switchField(app, 'metronome', '메트로놈', '박자에 맞춰 똑딱 소리를 내요. 마이크 모드에서는 이어폰을 추천해요.')),
    add('keepAwake', switchField(app, 'keepAwake', '화면 켜짐 유지', '플레이하는 동안 화면이 꺼지지 않게 해요.')));

  const soundGroup = group('소리', '🔊',
    add('masterVolume', sliderField(app, 'masterVolume', '전체 음량 (가이드·효과음)', {
      min: 0, max: 1, step: 0.05,
      format: (v) => `${Math.round(v * 100)}%`,
    })),
    add('backingVolume', sliderField(app, 'backingVolume', '반주 음량', {
      min: 0, max: 1, step: 0.05,
      format: (v) => `${Math.round(v * 100)}%`,
    })));

  const dataGroup = group('데이터', '💾',
    h('p', { class: 'muted small' }, '내가 만든 곡은 이 기기의 브라우저에 저장돼요. 곡 파일로 내보내 두면 다른 기기에서도 가져올 수 있어요. (반주 음원은 포함되지 않아요)'),
    h('div', { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn',
        onClick: async () => {
          try {
            const songs = await app.library.userSongs();
            if (!songs.length) {
              toast('내보낼 내 곡이 없어요.');
              return;
            }
            downloadFile(`piano-karaoke-songs-${todayStamp()}.json`, JSON.stringify(songs, null, 2));
            toast(`곡 ${songs.length}개를 내보냈어요.`, { type: 'success' });
          } catch (err) {
            toast(err?.message || '내보내기에 실패했어요.', { type: 'error' });
          }
        },
      }, '⬇️ 모든 내 곡 내보내기'),
      h('button', { type: 'button', class: 'btn', onClick: () => importSongs(app) }, '⬆️ 곡 가져오기'),
      h('button', {
        type: 'button',
        class: 'btn ghost danger-text',
        onClick: async () => {
          const ok = await confirmDialog({
            title: '플레이 기록 지우기',
            message: '모든 곡의 최고 점수와 플레이 횟수를 지울까요? 곡은 지워지지 않아요.',
            okText: '기록 지우기',
            danger: true,
          });
          if (!ok) return;
          app.scores.clear?.();
          toast('플레이 기록을 지웠어요.', { type: 'success' });
        },
      }, '기록 지우기')));

  const secure = typeof window !== 'undefined' && window.isSecureContext;
  const hasMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const hasWorklet = typeof window !== 'undefined' && typeof window.AudioWorkletNode === 'function';
  const swActive = !!(navigator.serviceWorker && navigator.serviceWorker.controller);

  const helpGroup = group('문제 해결', '🛠️',
    h('ul', { class: 'help-list' },
      h('li', {}, h('strong', {}, '판정이 잘 안 돼요: '), '마이크 감도를 올리고, 보정 화면에서 지연을 다시 측정해 보세요. 옥타브 무시를 켜면 더 너그럽게 판정해요.'),
      h('li', {}, h('strong', {}, '엉뚱한 음이 감지돼요: '), '감도를 낮추고, 가이드 멜로디·메트로놈·반주는 이어폰으로 들어 주세요.'),
      h('li', {}, h('strong', {}, '마이크 권한을 거부했어요: '), '주소창의 자물쇠(사이트 설정) → 권한 → 마이크를 허용한 뒤 새로고침해 주세요.'),
      h('li', {}, h('strong', {}, '업데이트가 반영되지 않아요: '), '아래 버튼으로 캐시를 지우고 다시 불러오세요.')),
    h('div', { class: 'info-grid' },
      infoRow('버전', `v${app.version || '-'}`),
      infoRow('보안 연결 (HTTPS)', secure ? '사용 중' : '아님 — 마이크 사용 불가', secure),
      infoRow('마이크 지원', hasMic ? '지원' : '미지원', hasMic),
      infoRow('오디오 워클릿', hasWorklet ? '지원' : '미지원 (대체 방식 사용)', hasWorklet ? true : undefined),
      infoRow('곡 저장소', app.library.persistent ? '이 기기에 저장' : '임시 (새로고침 시 사라짐)', app.library.persistent),
      infoRow('오프라인 사용', swActive ? '가능' : '준비 안 됨')),
    h('div', { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn',
        onClick: async () => {
          const ok = await confirmDialog({
            title: '앱 새로 고침',
            message: '저장된 앱 파일(캐시)을 지우고 최신 버전을 다시 불러올까요? 내 곡과 설정은 그대로 남아요.',
            okText: '새로 고침',
          });
          if (ok) app.hardReload();
        },
      }, '🔄 앱 새로 고침 (캐시 삭제)')));

  const resetBtn = h('button', {
    type: 'button',
    class: 'btn danger',
    onClick: async () => {
      const ok = await confirmDialog({
        title: '기본값으로 초기화',
        message: '모든 설정을 처음 상태로 되돌릴까요? 보정한 지연 값도 초기화돼요. 내 곡과 기록은 지워지지 않아요.',
        okText: '초기화',
        danger: true,
      });
      if (!ok) return;
      app.settings.reset();
      toast('설정을 기본값으로 되돌렸어요.', { type: 'success' });
    },
  }, '기본값으로 초기화');

  const topbar = h('header', { class: 'topbar' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': '뒤로', onClick: () => app.back() }, '←'),
    h('div', { class: 'title' }, '설정'),
    h('div', { class: 'spacer' }),
    resetBtn);

  const body = h('div', { class: 'settings-body' },
    h('div', { class: 'settings-columns' },
      h('div', { class: 'settings-col' }, inputGroup, soundGroup),
      h('div', { class: 'settings-col' }, playGroup, dataGroup, helpGroup)));

  root.append(topbar, body);

  cleanups.push(app.settings.on('change', (key) => {
    const f = fields.get(key);
    if (f) f.sync();
    if (key === 'difficulty') fields.get('difficulty')?.sync();
  }));
}

export function unmount() {
  for (const fn of cleanups) {
    try { if (typeof fn === 'function') fn(); } catch { /* ignore */ }
  }
  cleanups = [];
}
