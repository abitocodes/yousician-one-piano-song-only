// Results: rank, score, grade counts, timing summary and histogram, replay actions.

import { h, formatNumber } from '../ui/dom.js';
import { WINDOWS } from '../game/judge.js';

const GRADES = [
  { key: 'perfect', label: 'PERFECT' },
  { key: 'great', label: 'GREAT' },
  { key: 'good', label: 'GOOD' },
  { key: 'miss', label: 'MISS' },
];

const RANK_TEXT = {
  S: '완벽해요! 무대 체질이네요.',
  A: '훌륭해요! 거의 다 왔어요.',
  B: '좋아요! 조금만 더 연습해 봐요.',
  C: '괜찮아요. 조금씩 늘고 있어요!',
  D: '천천히, 속도를 낮춰서 다시 해 봐요.',
};

const MODE_LABEL = { play: '플레이', practice: '연습 모드', listen: '듣기', calibrate: '보정' };

let rafId = 0;

/**
 * What one judged unit is: two-hand accompaniment songs are judged per chord (onset group), others per note.
 * → { unit: '화음' | '노트', subject (with its particle), title }
 */
export function judgeUnit(song) {
  return song && song.arrangement === 'accompaniment'
    ? { unit: '화음', subject: '화음이', title: '판정 (화음 단위)' }
    : { unit: '노트', subject: '노트가', title: '판정' };
}

function timingSummary(meanDelta, count) {
  if (!count || !Number.isFinite(meanDelta)) return '타이밍 데이터가 없어요';
  const v = Math.round(meanDelta * 1000);
  if (Math.abs(v) < 5) return `평균 타이밍이 정확해요 (${v >= 0 ? '+' : ''}${v}ms)`;
  return v > 0 ? `평균 ${v}ms 늦음` : `평균 ${-v}ms 빠름`;
}

function histogram(deltas, difficulty) {
  const RANGE = 0.25;
  const BINS = 20;
  const width = (RANGE * 2) / BINS;
  const counts = new Array(BINS).fill(0);
  for (const d of deltas || []) {
    if (!Number.isFinite(d)) continue;
    const i = Math.floor((Math.max(-RANGE, Math.min(RANGE - 1e-9, d)) + RANGE) / width);
    counts[Math.max(0, Math.min(BINS - 1, i))]++;
  }
  const max = Math.max(1, ...counts);
  const w = WINDOWS[difficulty] || WINDOWS.normal;
  const bars = counts.map((c, i) => {
    const center = -RANGE + (i + 0.5) * width;
    const a = Math.abs(center);
    const grade = a <= w.perfect ? 'perfect' : a <= w.great ? 'great' : a <= w.good ? 'good' : 'miss';
    return h('div', {
      class: ['hist-bar', grade],
      style: { '--h': `${(c / max) * 100}%` },
      title: `${Math.round(center * 1000)}ms: ${c}개`,
    });
  });
  return h('div', { class: 'hist' },
    h('div', { class: 'hist-bars' }, bars, h('div', { class: 'hist-zero', 'aria-hidden': 'true' })),
    h('div', { class: 'hist-axis muted small' },
      h('span', {}, '−250ms 빠름'), h('span', {}, '0'), h('span', {}, '늦음 +250ms')));
}

function animateNumber(el, target, durationMs = 900) {
  cancelAnimationFrame(rafId);
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || target <= 0) {
    el.textContent = formatNumber(target);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = formatNumber(target * eased);
    if (p < 1) rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

export async function mount(root, params, app) {
  root.classList.add('results-screen');
  const { song, stats, mode = 'play', isBest = false, previousBest = null } = params || {};

  const topbar = h('header', { class: 'topbar' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': '곡 목록으로', onClick: () => app.go('home') }, '←'),
    h('div', { class: 'title' }, '결과'),
    h('div', { class: 'spacer' }));

  if (!song || !stats) {
    root.append(topbar, h('div', { class: 'results-body' },
      h('div', { class: 'card empty-card' },
        h('p', {}, '표시할 결과가 없어요.'),
        h('button', { type: 'button', class: 'btn primary', onClick: () => app.go('home') }, '곡 목록으로'))));
    return;
  }

  const counts = stats.counts || { perfect: 0, great: 0, good: 0, miss: 0 };
  const total = stats.total || GRADES.reduce((a, g) => a + (counts[g.key] || 0), 0);
  const rank = ['S', 'A', 'B', 'C', 'D'].includes(stats.rank) ? stats.rank : 'D';
  const accuracyPct = Math.round((stats.accuracy || 0) * 1000) / 10;
  const deltas = Array.isArray(stats.deltas) ? stats.deltas : [];
  const meanMs = Math.round((stats.meanDelta || 0) * 1000);
  const difficulty = app.settings.get('difficulty');

  // Replay: prefer the stored song when it is unchanged, otherwise replay the exact song object we were given.
  let stored = null;
  try { stored = await app.library.get(song.id); } catch { /* ignore */ }
  const sameAsStored = stored && (stored.updatedAt || 0) === (song.updatedAt || 0);
  let audioBlob = null;
  if (song.audio) {
    try { audioBlob = await app.library.getAudio(song.id); } catch { /* ignore */ }
  }
  const replay = (m) => {
    const p = sameAsStored ? { songId: song.id, mode: m } : { song, mode: m };
    if (audioBlob) p.audioBlob = audioBlob;
    if (params.returnTo) {
      p.returnTo = params.returnTo;
      p.returnParams = params.returnParams;
    }
    app.go('play', p);
  };

  const scoreEl = h('div', { class: 'score-value' }, '0');
  const hero = h('section', { class: ['card', 'results-hero', `rank-${rank}`] },
    h('div', { class: 'rank-wrap' },
      h('div', { class: `rank-letter rank-${rank}`, 'aria-label': `랭크 ${rank}` }, rank),
      isBest ? h('div', { class: 'best-badge' }, '🏆 최고 기록!') : null),
    h('div', { class: 'hero-info' },
      h('div', { class: 'song-title' }, song.title || '제목 없음'),
      h('div', { class: 'muted' }, `${song.artist || ''}${song.artist ? ' · ' : ''}${MODE_LABEL[mode] || mode}`),
      scoreEl,
      h('div', { class: 'score-sub' },
        h('span', { class: 'accuracy' }, `정확도 ${accuracyPct}%`),
        h('span', { class: 'muted' }, ` · 최대 콤보 ${stats.maxCombo || 0}`)),
      h('p', { class: 'rank-text' }, RANK_TEXT[rank]),
      mode === 'practice'
        ? h('p', { class: 'note muted small' }, '연습 모드 기록은 최고점에 반영되지 않아요.')
        : previousBest && !isBest
          ? h('p', { class: 'muted small' }, `최고 기록 ${formatNumber(previousBest.score)}점 (${previousBest.rank})`)
          : previousBest && isBest
            ? h('p', { class: 'muted small' }, `이전 최고 ${formatNumber(previousBest.score)}점 → +${formatNumber(stats.score - previousBest.score)}점`)
            : null));

  const gradeRows = GRADES.map((g) => {
    const c = counts[g.key] || 0;
    const pct = total ? (c / total) * 100 : 0;
    return h('div', { class: ['grade-row', g.key] },
      h('span', { class: 'grade-name' }, g.label),
      h('div', { class: 'grade-bar' }, h('div', { class: 'grade-fill', style: { '--w': `${pct}%` } })),
      h('span', { class: 'grade-count' }, String(c)));
  });

  const unit = judgeUnit(song);
  const countsCard = h('section', { class: 'card results-counts' },
    h('h2', { class: 'group-title' }, unit.title),
    h('div', { class: 'stack' }, gradeRows),
    unit.unit === '화음'
      ? h('p', { class: 'muted small unit-note' }, '양손 반주는 같은 박의 화음을 하나로 세요. 아주 낮은 음은 판정하지 않아요.')
      : null,
    h('div', { class: 'info-grid' },
      h('div', { class: 'info-row' }, h('span', { class: 'muted' }, `판정한 ${unit.unit}`), h('span', {}, `${stats.judged ?? total} / ${total}`)),
      h('div', { class: 'info-row' }, h('span', { class: 'muted' }, '최대 콤보'), h('span', {}, String(stats.maxCombo || 0))),
      h('div', { class: 'info-row' }, h('span', { class: 'muted' }, '노트 밖 입력'), h('span', {}, `${stats.stray || 0}회`))));

  const latencyHint = Math.abs(meanMs) >= 40 && deltas.length >= 4 && app.settings.get('inputMode') === 'mic'
    ? h('div', { class: 'notice row' },
      h('span', { class: 'muted small' }, `타이밍이 한쪽으로 ${Math.abs(meanMs)}ms 치우쳐 있어요. 지연 보정을 다시 해 보세요.`),
      h('button', { type: 'button', class: 'btn small', onClick: () => app.go('calibrate') }, '보정하기'))
    : null;

  const timingCard = h('section', { class: 'card results-timing' },
    h('h2', { class: 'group-title' }, '타이밍'),
    h('div', { class: 'timing-summary' }, timingSummary(stats.meanDelta, deltas.length)),
    deltas.length ? histogram(deltas, difficulty) : h('p', { class: 'muted small' }, `맞힌 ${unit.subject} 없어서 타이밍 그래프를 그릴 수 없어요.`),
    latencyHint);

  const otherMode = mode === 'practice' ? 'play' : 'practice';
  const actions = h('div', { class: 'results-actions row' },
    h('button', { type: 'button', class: 'btn primary big', onClick: () => replay(mode) }, '↻ 다시하기'),
    h('button', { type: 'button', class: 'btn big', onClick: () => replay(otherMode) }, otherMode === 'play' ? '▶ 플레이로 도전' : '연습 모드로'),
    params.returnTo
      ? h('button', { type: 'button', class: 'btn big ghost', onClick: () => app.go(params.returnTo, params.returnParams || {}) }, '돌아가기')
      : null,
    h('button', { type: 'button', class: 'btn big ghost', onClick: () => app.go('home') }, '곡 목록'));

  root.append(topbar, h('div', { class: 'results-body' },
    hero,
    h('div', { class: 'results-grid' }, countsCard, timingCard),
    actions));

  animateNumber(scoreEl, Math.round(stats.score || 0));
}

export function unmount() {
  cancelAnimationFrame(rafId);
  rafId = 0;
}
