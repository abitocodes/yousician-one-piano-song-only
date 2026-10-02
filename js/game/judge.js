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

const EPS = 1e-9;

export function rankFor(accuracy) {
  const a = Number(accuracy) || 0;
  if (a >= 0.95) return 'S';
  if (a >= 0.85) return 'A';
  if (a >= 0.70) return 'B';
  if (a >= 0.50) return 'C';
  return 'D';
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

  input({ time, midi } = {}) {
    const tm = Number(time);
    const m = Number(midi);
    if (!Number.isFinite(tm) || !Number.isFinite(m)) return null;
    const speed = this._speed;
    const win = this.windows.good * speed;

    // A second detection from the same physical strike may only complete the same onset group.
    const last = this._lastHit;
    const sameStrike = last !== null && Math.abs(tm - last.time) <= STRIKE_EPS * speed + EPS;

    this._advanceCursor();
    let k = Math.max(this._cursor, this._lowerBound(tm - win - EPS));
    let best = -1;
    let bestAbs = Infinity;
    let bestExact = false;
    for (; k < this._order.length; k++) {
      const t = this._ts[k];
      if (t > tm + win + EPS) break;
      const i = this._order[k];
      if (this._states[i] !== 'pending') continue;
      const abs = Math.abs(tm - t);
      if (abs > win + EPS) continue;
      if (sameStrike && Math.abs(t - last.t) > GROUP_EPS + EPS) continue;
      const note = this._notes[i];
      if (!this.anyPitch && !samePitch(note.m, m, this.octaveTolerant)) continue;
      const exact = Math.round(note.m) === Math.round(m);
      // Minimal |delta|; ties → exact pitch first, then earliest (iteration order).
      if (abs < bestAbs - EPS || (Math.abs(abs - bestAbs) <= EPS && exact && !bestExact)) {
        best = i;
        bestAbs = abs;
        bestExact = exact;
      }
    }

    if (best < 0) {
      if (!sameStrike) {
        this._stray++;
        this._version++;
      }
      return null;
    }

    const note = this._notes[best];
    const delta = tm - note.t;
    const deltaReal = delta / speed;
    const absReal = Math.abs(deltaReal);
    const w = this.windows;
    const grade = absReal <= w.perfect + EPS ? 'perfect' : absReal <= w.great + EPS ? 'great' : 'good';
    this._lastHit = { time: tm, t: note.t };
    const at = Number.isFinite(this._now) ? Math.max(tm, this._now) : tm;
    return this._record(best, grade, delta, deltaReal, at, true);
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
  hitHeld(midi) {
    const m = Number(midi);
    if (!Number.isFinite(m)) return [];
    const group = this.pendingGroup();
    if (!group.length) return [];
    const mr = Math.round(m);
    let targetPitch = null;
    let bestDist = Infinity;
    for (const i of group) {
      const nm = Math.round(this._notes[i].m);
      if (!this.anyPitch && !samePitch(nm, mr, this.octaveTolerant)) continue;
      const dist = Math.abs(nm - mr);
      if (dist < bestDist) {
        bestDist = dist;
        targetPitch = nm;
      }
    }
    if (targetPitch === null) return [];
    const t0 = this._ts[this._cursor];
    const results = [];
    for (const i of group) {
      if (Math.round(this._notes[i].m) !== targetPitch) continue;
      results.push(this._record(i, 'good', 0, 0, t0, false));
    }
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
    this._states[i] = grade;
    this._judgedAt[i] = at;
    this._counts[grade]++;
    this._judged++;
    this._factorSum += GRADE_FACTOR[grade];
    if (grade === 'miss') {
      this._combo = 0;
    } else {
      this._combo++;
      if (this._combo > this._maxCombo) this._maxCombo = this._combo;
      if (timed) {
        this._deltas.push(deltaReal);
        this._deltaSum += deltaReal;
      }
    }
    this._version++;
    const result = { index: i, note: this._notes[i], grade, delta, deltaReal };
    this.emit('judge', result);
    return result;
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
