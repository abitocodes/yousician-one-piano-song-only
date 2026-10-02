// Two-hand accompaniment helpers: hand tags ('R' / 'L'), merging tracks, simplifying chords per hand, stats.
// Notes are app notes { t, d, m, v?, h? } in seconds. Every function returns new note objects (inputs are
// never mutated), sorted by time then pitch. Pure module: no DOM access, importable in Node 22.

/** MIDI F2. Lower notes are display-only in accompaniment mode (tablet mics cannot hear them reliably). */
export const JUDGE_FLOOR = 41;
/** Onsets closer than this (seconds) form one chord / onset group (same value as judge.js GROUP_EPS). */
export const GROUP_EPS = 0.03;

const SAME_T = 0.001 + 1e-9; // mergeTracks: onsets within 1 ms are the same onset
const TOL = 1e-9;
const DEFAULT_SPLIT = 60;

const r3 = (x) => Math.round(x * 1000) / 1000;
const isNote = (n) => n !== null && typeof n === 'object' && Number.isFinite(n.t) && Number.isFinite(n.m);
const isHand = (h) => h === 'R' || h === 'L';
const byTimeThenPitch = (a, b) => a.t - b.t || a.m - b.m;

function copies(notes) {
  const out = [];
  for (const n of Array.isArray(notes) ? notes : []) if (isNote(n)) out.push({ ...n });
  return out;
}

const sorted = (list) => list.sort(byTimeThenPitch);

// A note's hand: its own valid tag, else by pitch (the renderer's default for untagged notes is the right hand,
// but for splitting/simplifying/stats untagged notes are divided at middle C).
const handOf = (n, split = DEFAULT_SPLIT) => (isHand(n.h) ? n.h : n.m >= split ? 'R' : 'L');

/**
 * Onset groups: notes whose onsets lie within `eps` of the group's first onset.
 * → [{ t, idx: number[] }] with indices into `notes` (time order; invalid entries skipped).
 */
export function groupOnsets(notes, eps = GROUP_EPS) {
  if (!Array.isArray(notes) || !notes.length) return [];
  const tol = (Number.isFinite(eps) && eps >= 0 ? eps : GROUP_EPS) + TOL;
  const order = [];
  for (let i = 0; i < notes.length; i++) if (isNote(notes[i])) order.push(i);
  order.sort((a, b) => notes[a].t - notes[b].t || a - b);
  const groups = [];
  let cur = null;
  for (const i of order) {
    if (cur && notes[i].t - cur.t <= tol) {
      cur.idx.push(i);
    } else {
      cur = { t: notes[i].t, idx: [i] };
      groups.push(cur);
    }
  }
  return groups;
}

/** Copies tagged with `hand` ('R' / 'L'; anything else removes the tag). */
export function tagHand(notes, hand) {
  const out = copies(notes);
  for (const n of out) {
    if (isHand(hand)) n.h = hand;
    else delete n.h;
  }
  return sorted(out);
}

/** Copies with a hand tag: an existing valid tag is kept, otherwise m >= split → 'R', else 'L'. */
export function splitHands(notes, split = DEFAULT_SPLIT) {
  const s = Number.isFinite(split) ? split : DEFAULT_SPLIT;
  const out = copies(notes);
  for (const n of out) n.h = handOf(n, s);
  return sorted(out);
}

/**
 * Merges note lists into one sorted list of copies. Notes of the same pitch starting within 1 ms are one note:
 * the longer one's end is kept and a right-hand tag wins over a left-hand one.
 */
export function mergeTracks(...lists) {
  const all = [];
  for (const list of lists) for (const n of copies(list)) all.push(n);
  sorted(all);
  const out = [];
  const lastByPitch = new Map();
  for (const n of all) {
    const prev = lastByPitch.get(n.m);
    if (prev && n.t - prev.t <= SAME_T) {
      const end = Math.max(prev.t + (prev.d || 0), n.t + (n.d || 0));
      prev.d = r3(end - prev.t);
      if (n.h === 'R' || prev.h === 'R') prev.h = 'R';
      else if (!isHand(prev.h) && isHand(n.h)) prev.h = n.h;
      if (prev.v === undefined && n.v !== undefined) prev.v = n.v;
      continue;
    }
    lastByPitch.set(n.m, n);
    out.push(n);
  }
  return out;
}

/**
 * Keeps at most `max` distinct pitches per onset group: the highest ones (keep 'top', right hand) or the lowest
 * ones (keep 'bottom', left hand). max Infinity (or not a number) keeps everything.
 */
export function simplifyHand(notes, { keep = 'top', max = 3 } = {}) {
  const list = sorted(copies(notes));
  if (!Number.isFinite(max)) return list;
  const limit = Math.max(1, Math.floor(max));
  const bottom = keep === 'bottom' || keep === 'L';
  const out = [];
  for (const g of groupOnsets(list)) {
    const members = g.idx.map((i) => list[i]).sort((a, b) => (bottom ? a.m - b.m : b.m - a.m) || b.d - a.d);
    const kept = new Set();
    for (const n of members) {
      if (kept.has(n.m)) continue;
      if (kept.size >= limit) break;
      kept.add(n.m);
      out.push(n);
    }
  }
  return sorted(out);
}

/**
 * Simplifies an accompaniment per hand: the right hand keeps its top `right` notes per chord, the left hand its
 * bottom `left` notes (Infinity = all). Untagged notes are split at middle C first, so every result note has `h`.
 */
export function simplifyAccompaniment(notes, { right = Infinity, left = Infinity } = {}) {
  const tagged = splitHands(notes);
  const rh = tagged.filter((n) => n.h === 'R');
  const lh = tagged.filter((n) => n.h === 'L');
  return mergeTracks(simplifyHand(rh, { keep: 'top', max: right }), simplifyHand(lh, { keep: 'bottom', max: left }));
}

/**
 * Counts for an accompaniment: { right, left (notes per hand; untagged split at middle C), groups (onset groups),
 * maxChord (most notes in one group), belowFloor (notes under JUDGE_FLOOR), judgeGroups (groups with at least
 * one note at/above the floor, i.e. what accompaniment judging counts) }.
 */
export function accompanimentStats(notes) {
  const list = Array.isArray(notes) ? notes : [];
  let right = 0;
  let left = 0;
  let belowFloor = 0;
  for (const n of list) {
    if (!isNote(n)) continue;
    if (handOf(n) === 'R') right++;
    else left++;
    if (n.m < JUDGE_FLOOR) belowFloor++;
  }
  const groups = groupOnsets(list);
  let maxChord = 0;
  let judgeGroups = 0;
  for (const g of groups) {
    if (g.idx.length > maxChord) maxChord = g.idx.length;
    if (g.idx.some((i) => list[i].m >= JUDGE_FLOOR)) judgeGroups++;
  }
  return { right, left, groups: groups.length, maxChord, belowFloor, judgeGroups };
}
