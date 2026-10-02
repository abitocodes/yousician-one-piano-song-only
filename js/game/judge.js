// Timing/pitch judge for melody notes, or (groupMode) for the chords of a two-hand accompaniment.
// Pure module (Node-importable).
//
// Internally the judge works on "units": a unit is one note, or in groupMode one onset group (the judgeable
// notes within GROUP_EPS of its first onset). A group is hit as a whole by any one of its notes and counts once
// in the stats. Notes below `floor` (groupMode only) are display-only: never judged or counted, they turn 'auto'
// once update() passes their onset.
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
// groupMode: detections up to this long (real s) from the strike that hit a chord may be more notes of that
// chord (fingers landing one after another, the other hand, a rolled chord) rather than strikes of their own.
export const CHORD_SPREAD = 0.12;
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
    groupMode = false,
    floor = 0,
  } = {}) {
    super();
    this._notes = Array.isArray(notes) ? notes : [];
    this.difficulty = WINDOWS[difficulty] ? difficulty : 'normal';
    this.windows = buildWindows(this.difficulty, windows);
    this.octaveTolerant = !!octaveTolerant;
    this.anyPitch = !!anyPitch;
    this.grace = Math.max(0, Number(grace) || 0);
    this.noMiss = !!noMiss;
    this.groupMode = !!groupMode;
    const fl = Number(floor);
    this.floor = this.groupMode && Number.isFinite(fl) ? fl : -Infinity;
    this._speed = sanitizeSpeed(speed);

    const n = this._notes.length;
    // Judge in time order even if the caller's array is not sorted; results use the caller's indices.
    const byTime = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => (this._notes[a].t - this._notes[b].t) || (this._notes[a].m - this._notes[b].m) || (a - b));
    this._states = new Array(n);
    this._judgedAt = new Float64Array(n);
    this._members = null;        // groupMode: note indices of each group, in time order
    this._top = null;            // groupMode: highest note of each group
    this._gt = null;             // groupMode: onset of each group
    this._auto = NONE;           // groupMode: below-floor note indices, in time order
    this._autoTs = null;

    if (!this.groupMode) {
      // Units are the notes: _order holds note indices and the unit states are the note states.
      this._order = byTime;
      this._ustates = this._states;
    } else {
      const groups = [];
      const auto = [];
      let cur = null;
      let t0 = 0;
      for (const i of byTime) {
        const note = this._notes[i];
        if (!(Number(note.m) >= this.floor)) {
          auto.push(i);
        } else if (cur && note.t <= t0 + GROUP_EPS + EPS) {
          cur.push(i);
        } else {
          cur = [i];
          t0 = note.t;
          groups.push(cur);
        }
      }
      this._members = groups;
      this._gt = new Float64Array(groups.length);
      this._top = new Array(groups.length);
      groups.forEach((idx, g) => {
        this._gt[g] = this._notes[idx[0]].t;
        let top = idx[0];
        for (const i of idx) if (this._notes[i].m > this._notes[top].m) top = i;
        this._top[g] = top;
      });
      this._auto = auto;
      this._autoTs = new Float64Array(auto.length);
      auto.forEach((i, k) => { this._autoTs[k] = this._notes[i].t; });
      this._order = groups.map((_, g) => g);
      this._ustates = new Array(groups.length);
    }
    this._ts = new Float64Array(this._order.length);
    for (let k = 0; k < this._order.length; k++) this._ts[k] = this._tOf(this._order[k]);
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
    this._ustates.fill('pending');
    this._judgedAt.fill(NaN);
    this._cursor = 0;            // position in _order of the first possibly-pending unit
    this._autoCursor = 0;        // groupMode: next below-floor note to turn 'auto'
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
    this._heldHit = null;        // groupMode: { time, u } of the last hitHeld() hit (song s)
    this._version = 0;
    this._statsCache = null;
    this._statsVersion = -1;
  }

  stateOf(i) {
    return this._states[i];
  }

  // Index of the earliest pending note (groupMode: the first note of the earliest pending group; below-floor
  // notes never count). -1 when everything is judged.
  firstPending() {
    this._advanceCursor();
    if (this._cursor >= this._order.length) return -1;
    const u = this._order[this._cursor];
    return this.groupMode ? this._members[u][0] : u;
  }

  // Indices of the earliest pending onset group (notes within GROUP_EPS of the first pending onset).
  // groupMode: the judgeable notes of the earliest pending group.
  pendingGroup() {
    this._advanceCursor();
    const out = [];
    if (this._cursor >= this._order.length) return out;
    if (this.groupMode) return this._members[this._order[this._cursor]].slice();
    const t0 = this._ts[this._cursor];
    for (let k = this._cursor; k < this._order.length && this._ts[k] <= t0 + GROUP_EPS + EPS; k++) {
      const i = this._order[k];
      if (this._states[i] === 'pending') out.push(i);
    }
    return out;
  }

  // `octaves`: the strike comes from a detector that reports one note per pitch class per onset (mic or
  // simulated input), so octave copies in the hit note's onset group are hit by it too. Touch input
  // leaves it off: one key, one note. groupMode: the strike hits a whole pending group when it matches any of
  // its notes (by pitch class with octave tolerance or `octaves`); one result per group.
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
      if (this._ustates[i] !== 'pending') continue;
      if (Math.abs(tm - t) > win + EPS) continue;
      if (sameStrike && Math.abs(t - last.t) > GROUP_EPS + EPS) continue;
      if (!this._unitMatches(i, m, octaves)) continue;
      if (t < first) first = t;
      if (t > latest) latest = t;
      const exact = this._unitExact(i, m);
      const rank = Math.abs(tm - bias - t);
      // Minimal bias-corrected |delta|; ties → exact pitch first, then earliest (iteration order).
      if (rank < bestRank - EPS || (Math.abs(rank - bestRank) <= EPS && exact && !bestExact)) {
        best = i;
        bestRank = rank;
        bestExact = exact;
      }
    }

    // groupMode: a strike right after the one that hit a chord, nearer that chord than any pending match, is another
    // note of the same chord (one group = one strike): neither a stray nor an early hit of the next chord.
    if (this.groupMode && this._hitRank(tm, m, octaves, bias) < (best < 0 ? Infinity : bestRank - EPS)) return null;

    // groupMode: a strike nearer a matching below-floor (display-only) note is that note being played: neither a
    // stray nor an early hit of the next group.
    if (this._auto.length && !(best < 0 && sameStrike)) {
      const autoRank = this._autoRank(tm, m, win, bias, octaves);
      if (autoRank < Infinity && (best < 0 || autoRank < bestRank - EPS)) return null;
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
    if (this._auto.length) this._advanceAuto();
    const results = [];
    if (!this.noMiss) {
      const limit = (this.windows.good + this.grace) * this._speed;
      for (let k = this._cursor; k < this._order.length; k++) {
        const t = this._ts[k];
        if (!(now > t + limit + EPS)) break;
        const i = this._order[k];
        if (this._ustates[i] !== 'pending') continue;
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
  // groupMode: any note of the earliest pending group (by pitch class with octave tolerance or `octaves`) hits
  // the whole group; returns its one result.
  hitHeld(midi, delta, at, { octaves = false } = {}) {
    const m = Number(midi);
    if (!Number.isFinite(m)) return [];
    if (this.groupMode) return this._hitHeldGroup(m, delta, at, octaves);
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

  // groupMode: every figure is per group (total = number of judgeable groups).
  get stats() {
    if (this._statsCache && this._statsVersion === this._version) return this._statsCache;
    const total = this._order.length;
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

  _hitHeldGroup(m, delta, at, octaves) {
    this._advanceCursor();
    if (this._cursor >= this._order.length) return [];
    const g = this._order[this._cursor];
    if (!this._unitMatches(g, m, octaves)) return [];
    const d = optNumber(delta);
    const dReal = d / this._speed;
    const timed = Number.isFinite(dReal) && Math.abs(dReal) <= this.windows.good + EPS;
    const grade = timed ? this._gradeFor(Math.abs(dReal)) : 'good';
    const atNum = optNumber(at);
    const judgedAt = Number.isFinite(atNum) ? atNum : this._gt[g];
    const result = this._record(g, grade, timed ? d : 0, timed ? dReal : 0, judgedAt, timed);
    if (timed) this._pushBias({ deltaReal: dReal });
    // The song waits at the group, so the strike lands at its onset: more notes of the chord follow from there.
    this._heldHit = { time: this._gt[g], u: g };
    return [result];
  }

  // An input() hit of unit i (plus its octave copies when `octaves`): one timing measurement. Returns the
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
    this._lastHit = { time: tm, t: this._tOf(i) };
    this._version++;
    return e;
  }

  // Credits hit `e` with unit i (and, for a detector strike outside groupMode, the pending octave copies in its
  // onset group). Updates states and counts only; returns how many units it took.
  _assign(e, i) {
    const t = this._tOf(i);
    e.i = i;
    e.delta = e.time - t;
    e.deltaReal = e.delta / this._speed;
    e.grade = this._gradeFor(Math.abs(e.deltaReal));
    this._mark(i, e.grade, e.at);
    e.extra = NONE;
    if (e.octaves && !this.groupMode) {
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
  // groupMode: one result per group, for its top note, listing every note of the group in `indices`.
  _emitResult(i, grade, delta, deltaReal, retro = false) {
    let result;
    if (this.groupMode) {
      const top = this._top[i];
      result = { index: top, indices: this._members[i].slice(), note: this._notes[top], grade, delta, deltaReal };
    } else {
      result = { index: i, note: this._notes[i], grade, delta, deltaReal };
    }
    if (retro) result.retro = true;
    this.emit('judge', result);
    return result;
  }

  _mark(i, grade, at) {
    this._ustates[i] = grade;
    if (this.groupMode) {
      for (const x of this._members[i]) {
        this._states[x] = grade;
        this._judgedAt[x] = at;
      }
    } else {
      this._judgedAt[i] = at;
    }
    this._counts[grade]++;
    this._judged++;
    this._factorSum += GRADE_FACTOR[grade];
  }

  _unmark(i) {
    const grade = this._ustates[i];
    this._ustates[i] = 'pending';
    if (this.groupMode) {
      for (const x of this._members[i]) {
        this._states[x] = 'pending';
        this._judgedAt[x] = NaN;
      }
    } else {
      this._judgedAt[i] = NaN;
    }
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

  // Onset of unit u.
  _tOf(u) {
    return this.groupMode ? this._gt[u] : this._notes[u].t;
  }

  // Whether pitch `midi` can hit unit u. groupMode: any note of the group, by pitch class with octave tolerance
  // or for a detector strike (`octaves`: one note per pitch class, possibly reported in another octave).
  _unitMatches(u, midi, octaves = false) {
    if (!this.groupMode) return this._matches(this._notes[u].m, midi);
    if (this.anyPitch) return true;
    const tol = this.octaveTolerant || !!octaves;
    for (const i of this._members[u]) if (samePitch(this._notes[i].m, midi, tol)) return true;
    return false;
  }

  _unitExact(u, midi) {
    const r = Math.round(midi);
    if (!this.groupMode) return Math.round(this._notes[u].m) === r;
    for (const i of this._members[u]) if (Math.round(this._notes[i].m) === r) return true;
    return false;
  }

  // groupMode: bias-corrected distance from the strike (tm, m) to the nearest matching below-floor note inside
  // the good window; Infinity when there is none.
  _autoRank(tm, m, win, bias, octaves) {
    const ts = this._autoTs;
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ts[mid] < tm - win - EPS) lo = mid + 1;
      else hi = mid;
    }
    const tol = this.octaveTolerant || !!octaves;
    let best = Infinity;
    for (let k = lo; k < ts.length && ts[k] <= tm + win + EPS; k++) {
      if (!this.anyPitch && !samePitch(this._notes[this._auto[k]].m, m, tol)) continue;
      const rank = Math.abs(tm - bias - ts[k]);
      if (rank < best) best = rank;
    }
    return best;
  }

  // groupMode: bias-corrected distance from the strike (tm, m) to the nearest matching group that a strike at most
  // CHORD_SPREAD away already hit (input() hits still in the log, or the last hitHeld() hit); Infinity when none.
  // A stray a whole beat after an early hit stays a stray, so _reassign can still shift that hit back.
  _hitRank(tm, m, octaves, bias) {
    const spread = CHORD_SPREAD * this._speed + EPS;
    let best = Infinity;
    const consider = (time, u) => {
      if (Math.abs(tm - time) > spread) return;
      const st = this._ustates[u];
      if (st === 'pending' || st === 'miss' || !this._unitMatches(u, m, octaves)) return;
      const rank = Math.abs(tm - bias - this._gt[u]);
      if (rank < best) best = rank;
    };
    for (const e of this._log) consider(e.time, e.i);
    if (this._heldHit) consider(this._heldHit.time, this._heldHit.u);
    return best;
  }

  // groupMode: below-floor notes turn 'auto' once the song passes their onset.
  _advanceAuto() {
    const auto = this._auto;
    while (this._autoCursor < auto.length && this._autoTs[this._autoCursor] <= this._now) {
      const i = auto[this._autoCursor++];
      this._states[i] = 'auto';
      this._judgedAt[i] = this._notes[i].t;
    }
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
      if (!(e.delta < -EPS) || !this._unitMatches(e.i, m, octaves) || Math.abs(tm - this._tOf(e.i)) > win + EPS) continue;
      const moves = this._shiftBack(a, win, 1, failed);
      if (moves) return this._applyShift(moves, e.i, tm, m, octaves);
    }
    return null;
  }

  // Moves for log[a] onto an earlier note: a pending one (end of the chain) or the note of another early
  // hit, which then moves on in turn. Closest first; null when no chain ends at a pending note.
  _shiftBack(a, win, depth, failed) {
    const e = this._log[a];
    const before = this._tOf(e.i) - GROUP_EPS - EPS;   // strictly an earlier onset
    const opts = [];
    for (let k = this._lowerBound(e.time - win - EPS); k < this._order.length && this._ts[k] < before; k++) {
      const i = this._order[k];
      if (this._ustates[i] !== 'pending' || Math.abs(e.time - this._ts[k]) > win + EPS) continue;
      if (this._unitMatches(i, e.m, e.octaves)) opts.push({ dist: Math.abs(e.time - this._ts[k]), i, b: -1 });
    }
    if (depth < MAX_SHIFT) {
      for (let b = a - 1; b >= 0; b--) {
        const f = this._log[b];
        const yt = this._tOf(f.i);
        if (failed.has(b) || !(f.delta < -EPS) || !(yt < before) || Math.abs(e.time - yt) > win + EPS) continue;
        if (this._unitMatches(f.i, e.m, e.octaves)) opts.push({ dist: Math.abs(e.time - yt), i: f.i, b });
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
    const pt = this._tOf(i);
    const win = this.windows.good * this._speed;
    for (const e of this._log) {
      const xt = this._tOf(e.i);
      if (!(e.delta < -EPS) || xt <= pt + GROUP_EPS + EPS || now > xt + limit + EPS) continue;
      if (Math.abs(e.time - pt) <= win + EPS && this._unitMatches(i, e.m, e.octaves)) return true;
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
    while (this._cursor < order.length && this._ustates[order[this._cursor]] !== 'pending') this._cursor++;
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
