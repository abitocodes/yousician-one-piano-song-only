// Timing/pitch judge for melody notes. Pure module (Node-importable).
import { Emitter } from '../core/emitter.js';
import { samePitch } from '../core/notes.js';

// Real-time windows (seconds). Song-time windows are these × speed.
export const WINDOWS = {
  easy: { perfect: 0.10, great: 0.18, good: 0.30 },
  normal: { perfect: 0.07, great: 0.14, good: 0.23 },
  hard: { perfect: 0.045, great: 0.09, good: 0.15 },
};

export const GRADE_FACTOR = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };

// Onsets closer than this (song s) belong to the same chord / onset group.
export const GROUP_EPS = 0.03;
// Detections closer than this (real s) to a successful hit are treated as the same physical strike
// (e.g. a harmonic or chord candidate reported by the detector at the same onset).
export const STRIKE_EPS = 0.025;
// Recent timed hits averaged into the player's timing bias (candidate ranking only).
const BIAS_SAMPLES = 8;
// Recent input() hits remembered so a later stray strike can shift them back by one note (_reassign).
const HIT_LOG = 16;
// Longest run of recent hits one stray strike may shift back.
const MAX_SHIFT = 8;

const EPS = 1e-9;
const NONE = Object.freeze([]);

export function rankFor(accuracy) {
  const a = Number(accuracy) || 0;
  if (a >= 0.95) return 'S';
  if (a >= 0.85) return 'A';
  if (a >= 0.70) return 'B';
  if (a >= 0.50) return 'C';
  return 'D';
}

// Optional numeric argument: undefined/null → NaN (Number(null) would be 0).
function optNumber(v) {
  return v === undefined || v === null ? NaN : Number(v);
}

function sanitizeSpeed(speed) {
  const s = Number(speed);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

function buildWindows(difficulty, override) {
  const base = WINDOWS[difficulty] || WINDOWS.normal;
  const w = { ...base };
  if (override && typeof override === 'object') {
    for (const k of ['perfect', 'great', 'good']) {
      const v = Number(override[k]);
      if (Number.isFinite(v) && v >= 0) w[k] = v;
    }
  }
  // Keep the windows nested.
  w.great = Math.max(w.great, w.perfect);
  w.good = Math.max(w.good, w.great);
  return w;
}

export class Judge extends Emitter {
  constructor(notes, {
    difficulty = 'normal',
    windows,
    octaveTolerant = true,
    anyPitch = false,
    speed = 1,
    grace = 0.15,
    noMiss = false,
  } = {}) {
    super();
    this._notes = Array.isArray(notes) ? notes : [];
    this.difficulty = WINDOWS[difficulty] ? difficulty : 'normal';
    this.windows = buildWindows(this.difficulty, windows);
    this.octaveTolerant = !!octaveTolerant;
    this.anyPitch = !!anyPitch;
    this.grace = Math.max(0, Number(grace) || 0);
    this.noMiss = !!noMiss;
    this._speed = sanitizeSpeed(speed);

    const n = this._notes.length;
    // Judge in time order even if the caller's array is not sorted; results use the caller's indices.
    this._order = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => (this._notes[a].t - this._notes[b].t) || (this._notes[a].m - this._notes[b].m) || (a - b));
    this._ts = new Float64Array(n);
    for (let k = 0; k < n; k++) this._ts[k] = this._notes[this._order[k]].t;

    this._states = new Array(n);
    this._judgedAt = new Float64Array(n);
    this.reset();
  }

  get notes() { return this._notes; }
  get speed() { return this._speed; }
  get states() { return this._states; }
  get judgedAt() { return this._judgedAt; }

  setSpeed(speed) {
    this._speed = sanitizeSpeed(speed);
  }

  reset() {
    this._states.fill('pending');
    this._judgedAt.fill(NaN);
    this._cursor = 0;            // position in _order of the first possibly-pending note
    this._now = -Infinity;       // last songTime passed to update()
    this._counts = { perfect: 0, great: 0, good: 0, miss: 0 };
    this._judged = 0;
    this._factorSum = 0;
    this._combo = 0;
    this._maxCombo = 0;
    this._stray = 0;
    this._deltas = [];
    this._deltaSum = 0;
    this._lastHit = null;        // { time, t } of the last timed hit (song s)
    // Recent input() hits: { i, time, m, octaves, at, grade, delta, deltaReal, slot, extra }. `i` is the
    // note the hit currently holds, `slot` its entry in _deltas, `extra` octave copies it also hit.
    this._log = [];
    this._biasHits = [];         // recent hits whose note was unambiguous (or confirmed); feed _bias()
    this._version = 0;
    this._statsCache = null;
    this._statsVersion = -1;
  }

  stateOf(i) {
    return this._states[i];
  }

  firstPending() {
    this._advanceCursor();
    return this._cursor < this._order.length ? this._order[this._cursor] : -1;
  }

  // Indices of the earliest pending onset group (notes within GROUP_EPS of the first pending onset).
  pendingGroup() {
    this._advanceCursor();
    const out = [];
    if (this._cursor >= this._order.length) return out;
    const t0 = this._ts[this._cursor];
    for (let k = this._cursor; k < this._order.length && this._ts[k] <= t0 + GROUP_EPS + EPS; k++) {
      const i = this._order[k];
      if (this._states[i] === 'pending') out.push(i);
    }
    return out;
  }

  // `octaves`: the strike comes from a detector that reports one note per pitch class per onset (mic or
  // simulated input), so octave copies in the hit note's onset group are hit by it too. Touch input
  // leaves it off: one key, one note.
  input({ time, midi, octaves = false } = {}) {
    const tm = Number(time);
    const m = Number(midi);
    if (!Number.isFinite(tm) || !Number.isFinite(m)) return null;
    const speed = this._speed;
    const win = this.windows.good * speed;

    // A second detection from the same physical strike may only complete the same onset group.
    const last = this._lastHit;
    const sameStrike = last !== null && Math.abs(tm - last.time) <= STRIKE_EPS * speed + EPS;

    // Candidates are ranked around the player's recent (late) offset, so a consistently late strike on a
    // run of repeated pitches keeps taking the note it was meant for instead of the next one. The window
    // check and the grade still use the raw delta.
    const bias = this._bias() * speed;

    this._advanceCursor();
    let k = Math.max(this._cursor, this._lowerBound(tm - win - EPS));
    let best = -1;
    let bestRank = Infinity;
    let bestExact = false;
    let first = Infinity;   // earliest / latest candidate onset
    let latest = -Infinity;
    for (; k < this._order.length; k++) {
      const t = this._ts[k];
      if (t > tm + win + EPS) break;
      const i = this._order[k];
      if (this._states[i] !== 'pending') continue;
      if (Math.abs(tm - t) > win + EPS) continue;
      if (sameStrike && Math.abs(t - last.t) > GROUP_EPS + EPS) continue;
      const note = this._notes[i];
      if (!this._matches(note.m, m)) continue;
      if (t < first) first = t;
      if (t > latest) latest = t;
      const exact = Math.round(note.m) === Math.round(m);
      const rank = Math.abs(tm - bias - t);
      // Minimal bias-corrected |delta|; ties → exact pitch first, then earliest (iteration order).
      if (rank < bestRank - EPS || (Math.abs(rank - bestRank) <= EPS && exact && !bestExact)) {
        best = i;
        bestRank = rank;
        bestExact = exact;
      }
    }

    if (best < 0) {
      if (sameStrike) return null;
      const shifted = this._reassign(tm, m, !!octaves);
      if (shifted) return shifted;
      this._stray++;
      this._version++;
      return null;
    }

    // With candidates at different onsets the pick was a guess: it may be the wrong note, so its delta
    // stays out of the bias (a wrong pick must not train the ranking that made it).
    const sure = latest - first <= GROUP_EPS + EPS;
    return this._emitHit(this._hit(best, tm, m, !!octaves, sure), false);
  }

  update(songTime) {
    const now = Number(songTime);
    if (!Number.isFinite(now)) return [];
    if (now > this._now) this._now = now;
    const results = [];
    if (!this.noMiss) {
      const limit = (this.windows.good + this.grace) * this._speed;
      for (let k = this._cursor; k < this._order.length; k++) {
        const t = this._ts[k];
        if (!(now > t + limit + EPS)) break;
        const i = this._order[k];
        if (this._states[i] !== 'pending') continue;
        if (this._contested(i, now, limit)) continue;
        const delta = now - t;
        results.push(this._record(i, 'miss', delta, delta / this._speed, now, false));
      }
    }
    this._advanceCursor();
    return results;
  }

  // Practice/wait mode: hit the matching pending note at the earliest pending onset group.
  // Prefers an exact pitch match; otherwise the closest matching pitch. Notes duplicated at the same
  // pitch in the group are all hit together.
  // Optional `delta` (song s): strike time minus the moment the group reached the hit line. Inside the
  // good window the hit is graded and recorded by timing like input(); otherwise (or when omitted) it is a
  // fixed, untimed 'good'. Optional `at` (song s) is recorded as the judgement time (default: the onset).
  // `octaves` (see input()): octave copies of the hit pitch in the group are hit too.
  hitHeld(midi, delta, at, { octaves = false } = {}) {
    const m = Number(midi);
    if (!Number.isFinite(m)) return [];
    const group = this.pendingGroup();
    if (!group.length) return [];
    const mr = Math.round(m);
    let targetPitch = null;
    let bestDist = Infinity;
    for (const i of group) {
      const nm = Math.round(this._notes[i].m);
      if (!this._matches(nm, mr)) continue;
      const dist = Math.abs(nm - mr);
      if (dist < bestDist) {
        bestDist = dist;
        targetPitch = nm;
      }
    }
    if (targetPitch === null) return [];
    const t0 = this._ts[this._cursor];
    const d = optNumber(delta);
    const dReal = d / this._speed;
    const timed = Number.isFinite(dReal) && Math.abs(dReal) <= this.windows.good + EPS;
    const grade = timed ? this._gradeFor(Math.abs(dReal)) : 'good';
    const atNum = optNumber(at);
    const judgedAt = Number.isFinite(atNum) ? atNum : t0;
    const results = [];
    for (const i of group) {
      const nm = Math.round(this._notes[i].m);
      if (nm !== targetPitch && !(octaves && samePitch(nm, targetPitch, this.octaveTolerant))) continue;
      // One strike is one timing measurement, however many copies it hit.
      results.push(this._record(i, grade, timed ? d : 0, timed ? dReal : 0, judgedAt, timed && !results.length));
    }
    if (timed) this._pushBias({ deltaReal: dReal });
    return results;
  }

  get stats() {
    if (this._statsCache && this._statsVersion === this._version) return this._statsCache;
    const total = this._notes.length;
    const judged = this._judged;
    const accuracy = judged > 0 ? this._factorSum / judged : 0;
    const rankAcc = judged === total && total > 0 ? this._factorSum / total : accuracy;
    const deltas = this._deltas.slice();
    this._statsCache = {
      score: total > 0 ? Math.round(this._factorSum * (1e6 / total)) : 0,
      maxScore: 1000000,
      accuracy,
      combo: this._combo,
      maxCombo: this._maxCombo,
      counts: { ...this._counts },
      judged,
      total,
      stray: this._stray,
      meanDelta: deltas.length ? this._deltaSum / deltas.length : 0,
      deltas,
      rank: rankFor(rankAcc),
    };
    this._statsVersion = this._version;
    return this._statsCache;
  }

  _record(i, grade, delta, deltaReal, at, timed) {
    this._mark(i, grade, at);
    if (grade === 'miss') {
      this._combo = 0;
    } else {
      this._addCombo(1);
      if (timed) {
        this._deltas.push(deltaReal);
        this._deltaSum += deltaReal;
      }
    }
    this._version++;
    return this._emitResult(i, grade, delta, deltaReal);
  }

  // An input() hit of note i (plus its octave copies when `octaves`): one timing measurement. Returns the
  // log entry; the caller emits.
  _hit(i, tm, m, octaves, sure) {
    const e = {
      i: -1, time: tm, m, octaves,
      at: Number.isFinite(this._now) ? Math.max(tm, this._now) : tm,
      grade: 'good', delta: 0, deltaReal: 0, slot: this._deltas.length, extra: NONE,
    };
    this._addCombo(this._assign(e, i));
    this._deltas.push(e.deltaReal);
    this._deltaSum += e.deltaReal;
    this._log.push(e);
    if (this._log.length > HIT_LOG) this._log.shift();
    if (sure) this._pushBias(e);
    this._lastHit = { time: tm, t: this._notes[i].t };
    this._version++;
    return e;
  }

  // Credits hit `e` with note i (and, for a detector strike, the pending octave copies in its onset group).
  // Updates states and counts only; returns how many notes it took.
  _assign(e, i) {
    const t = this._notes[i].t;
    e.i = i;
    e.delta = e.time - t;
    e.deltaReal = e.delta / this._speed;
    e.grade = this._gradeFor(Math.abs(e.deltaReal));
    this._mark(i, e.grade, e.at);
    e.extra = NONE;
    if (e.octaves) {
      const pitch = this._notes[i].m;
      for (let k = this._lowerBound(t - GROUP_EPS - EPS); k < this._order.length && this._ts[k] <= t + GROUP_EPS + EPS; k++) {
        const x = this._order[k];
        if (this._states[x] !== 'pending' || !samePitch(this._notes[x].m, pitch, this.octaveTolerant)) continue;
        this._mark(x, e.grade, e.at);
        if (e.extra === NONE) e.extra = [];
        e.extra.push(x);
      }
    }
    return 1 + e.extra.length;
  }

  _unassign(e) {
    this._unmark(e.i);
    for (const x of e.extra) this._unmark(x);
    e.extra = NONE;
  }

  _emitHit(e, retro) {
    const result = this._emitResult(e.i, e.grade, e.delta, e.deltaReal, retro);
    for (const x of e.extra) {
      const d = e.time - this._notes[x].t;
      this._emitResult(x, e.grade, d, d / this._speed, retro);
    }
    return result;
  }

  // `retro`: a hit moved to an earlier note by a later strike (its effect was already shown once).
  _emitResult(i, grade, delta, deltaReal, retro = false) {
    const result = { index: i, note: this._notes[i], grade, delta, deltaReal };
    if (retro) result.retro = true;
    this.emit('judge', result);
    return result;
  }

  _mark(i, grade, at) {
    this._states[i] = grade;
    this._judgedAt[i] = at;
    this._counts[grade]++;
    this._judged++;
    this._factorSum += GRADE_FACTOR[grade];
  }

  _unmark(i) {
    const grade = this._states[i];
    this._states[i] = 'pending';
    this._judgedAt[i] = NaN;
    this._counts[grade]--;
    this._judged--;
    this._factorSum -= GRADE_FACTOR[grade];
  }

  _addCombo(n) {
    this._combo = Math.max(0, this._combo + n);
    if (this._combo > this._maxCombo) this._maxCombo = this._combo;
  }

  _matches(noteMidi, midi) {
    return this.anyPitch || samePitch(noteMidi, midi, this.octaveTolerant);
  }

  // A strike (tm, m) found no pending note. If recent hits look like a late player's strikes that each took
  // the NEXT same-pitch note (all early) while an older one is still pending, the stray is the proof:
  // shift those hits back one note each and give this strike the note the latest of them held. One miss
  // and one stray become two hits; the timings become consistent (and train the bias).
  _reassign(tm, m, octaves) {
    const log = this._log;
    const win = this.windows.good * this._speed;
    const failed = new Set();
    for (let a = log.length - 1; a >= 0; a--) {
      const e = log[a];
      const x = this._notes[e.i];
      if (!(e.delta < -EPS) || !this._matches(x.m, m) || Math.abs(tm - x.t) > win + EPS) continue;
      const moves = this._shiftBack(a, win, 1, failed);
      if (moves) return this._applyShift(moves, e.i, tm, m, octaves);
    }
    return null;
  }

  // Moves for log[a] onto an earlier note: a pending one (end of the chain) or the note of another early
  // hit, which then moves on in turn. Closest first; null when no chain ends at a pending note.
  _shiftBack(a, win, depth, failed) {
    const e = this._log[a];
    const before = this._notes[e.i].t - GROUP_EPS - EPS;   // strictly an earlier onset
    const opts = [];
    for (let k = this._lowerBound(e.time - win - EPS); k < this._order.length && this._ts[k] < before; k++) {
      const i = this._order[k];
      if (this._states[i] !== 'pending' || Math.abs(e.time - this._ts[k]) > win + EPS) continue;
      if (this._matches(this._notes[i].m, e.m)) opts.push({ dist: Math.abs(e.time - this._ts[k]), i, b: -1 });
    }
    if (depth < MAX_SHIFT) {
      for (let b = a - 1; b >= 0; b--) {
        const f = this._log[b];
        const y = this._notes[f.i];
        if (failed.has(b) || !(f.delta < -EPS) || !(y.t < before) || Math.abs(e.time - y.t) > win + EPS) continue;
        if (this._matches(y.m, e.m)) opts.push({ dist: Math.abs(e.time - y.t), i: f.i, b });
      }
    }
    opts.sort((p, q) => p.dist - q.dist);
    for (const o of opts) {
      if (o.b < 0) return [{ e, to: o.i }];
      const rest = this._shiftBack(o.b, win, depth + 1, failed);
      if (rest) return [{ e, to: o.i }, ...rest];
      failed.add(o.b);
    }
    return null;
  }

  _applyShift(moves, vacated, tm, m, octaves) {
    const judged = this._judged;
    for (const { e } of moves) {
      this._unassign(e);
      this._deltaSum -= this._deltas[e.slot];
    }
    for (const { e, to } of moves) {
      this._assign(e, to);
      this._deltas[e.slot] = e.deltaReal;
      this._deltaSum += e.deltaReal;
      // Confirmed by the stray: now a trustworthy timing sample.
      if (!this._biasHits.includes(e)) this._pushBias(e);
    }
    this._addCombo(this._judged - judged);
    const hit = this._hit(vacated, tm, m, octaves, true);
    for (let k = moves.length - 1; k >= 0; k--) this._emitHit(moves[k].e, true);
    return this._emitHit(hit, false);
  }

  // Note i passed its deadline while a recent early hit inside its window took a later same-pitch note (the
  // pattern of a late player, see _reassign). Keep it pending until that note's own deadline, so the strike
  // meant for that note, which arrives only after the input latency, can still shift the early hit back.
  _contested(i, now, limit) {
    const p = this._notes[i];
    const win = this.windows.good * this._speed;
    for (const e of this._log) {
      const x = this._notes[e.i];
      if (!(e.delta < -EPS) || x.t <= p.t + GROUP_EPS + EPS || now > x.t + limit + EPS) continue;
      if (Math.abs(e.time - p.t) <= win + EPS && this._matches(p.m, e.m)) return true;
    }
    return false;
  }

  _gradeFor(absReal) {
    const w = this.windows;
    return absReal <= w.perfect + EPS ? 'perfect' : absReal <= w.great + EPS ? 'great' : 'good';
  }

  _pushBias(e) {
    this._biasHits.push(e);
    if (this._biasHits.length > BIAS_SAMPLES) this._biasHits.shift();
  }

  // Mean of the recent trustworthy timed deltas (real s), clamped to [0, great]. Never negative, so an
  // early mis-assignment cannot reinforce itself; a fresh judge ranks by plain |delta|.
  _bias() {
    const h = this._biasHits;
    if (!h.length) return 0;
    let sum = 0;
    for (const e of h) sum += e.deltaReal;
    return Math.min(this.windows.great, Math.max(0, sum / h.length));
  }

  _advanceCursor() {
    const order = this._order;
    while (this._cursor < order.length && this._states[order[this._cursor]] !== 'pending') this._cursor++;
  }

  // First position in _order with t >= x.
  _lowerBound(x) {
    let lo = 0;
    let hi = this._ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._ts[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
