// Falling-notes highway + on-screen keyboard, drawn on a single 2D canvas.
// Static parts (highway background/lanes, white keys, black keys) are pre-rendered into offscreen layers on resize;
// each frame blits them and draws only the dynamic parts (grid, visible notes, tints, effects).
// Two-hand songs: right-hand notes (h 'R' or untagged) are cyan / violet, left-hand notes (h 'L') amber / orange;
// the sung melody (snapshot.vocal) is drawn as faint outlined bars behind the playable notes.

import { fitRange, layoutKeys } from '../core/keyboard.js';
import { noteName, pitchClass } from '../core/notes.js';

const FONT = '"Pretendard", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif';

const GRADE_INDEX = { perfect: 0, great: 1, good: 2, miss: 3, auto: 0 };
const GRADE_COLOR = ['#ffd84d', '#4ade80', '#60a5fa', '#f87171', '#ffffff'];
const GRADE_RGB = ['255,216,77', '74,222,128', '96,165,250', '248,113,113'];
const GRADE_LABEL = ['PERFECT', 'GREAT', 'GOOD', 'MISS'];
const SUB_LABEL = ['', '빠름', '느림'];

const FLASH_SEC = 0.25; // judged-note flash, real seconds
const SUSTAIN_MIN = 0.4; // notes at least this long keep a glowing tail after being hit
const KEY_FLASH_MS = 320;
const POPUP_MS = 720;
const BURST_MS = 320;
const DETECT_HOLD_MS = 140;
const FELT = 5; // red felt strip on top of the keyboard (CSS px)
const MAX_PARTICLES = 360;
const MAX_POPUPS = 24;
const MAX_BURSTS = 32;

const EXPECTED = 1;
const PRESSED = 2;
const DETECTED = 4;
const LEFT = 8; // the expected key belongs to the left hand

const AUTO_GRADE = 4; // display-only notes in a judged run fade in a neutral colour (GRADE_COLOR[4])
const VOCAL_STROKE = 'rgba(255,255,255,0.35)';
const VOCAL_ACTIVE_STROKE = 'rgba(255,255,255,0.7)';
const VOCAL_ACTIVE_FILL = 'rgba(255,255,255,0.08)';

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function roundRectPath(ctx, x, y, w, h, r) {
  if (r > w / 2) r = w / 2;
  if (r > h / 2) r = h / 2;
  if (r < 0) r = 0;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Rectangle with rounded bottom corners only (piano keys).
function keyPath(ctx, x, y, w, h, r) {
  if (r > w / 2) r = w / 2;
  if (r > h / 2) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.closePath();
}

// First index with notes[i].t >= t (notes sorted by t).
function lowerBound(notes, t) {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// fitRange over the playable notes and the sung melody.
function songRange(notes, vocal) {
  return fitRange(vocal.length ? notes.concat(vocal) : notes);
}

function makeLayer(prev, w, h) {
  const c = prev || document.createElement('canvas');
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}

export class HighwayRenderer {
  constructor(canvas, { labelStyle = 'solfege', showDetected = true, showVocal = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
    this.labelStyle = labelStyle;
    this.showDetected = showDetected !== false;
    this.showVocal = showVocal !== false;

    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.kbH = 0;
    this.hitY = 0;
    this.blackH = 0;
    this.lo = 48;
    this.hi = 84;
    this.layout = null;
    this.whiteKeys = [];
    this.blackKeys = [];
    this.whiteW = 0;
    this.blackW = 0;

    this.bpm = 100;
    this.beatsPerBar = 4;
    this.offset = 0;

    this.notes = [];
    this.maxDur = 0;
    this.noteX = new Float32Array(0);
    this.noteW = new Float32Array(0);
    this.noteBlack = new Uint8Array(0);
    this.noteLeft = new Uint8Array(0);
    this.labels = [];

    this.vocal = [];
    this.vocalMaxDur = 0;
    this.vocalX = new Float32Array(0);
    this.vocalW = new Float32Array(0);

    this._vis = new Int32Array(256);
    this._visYb = new Float32Array(256);
    this._visYt = new Float32Array(256);
    this._flags = new Uint8Array(128);
    this._keyFlashT = new Float64Array(128).fill(-1e9);
    this._keyFlashC = new Uint8Array(128);

    this._pX = new Float32Array(MAX_PARTICLES);
    this._pY = new Float32Array(MAX_PARTICLES);
    this._pVX = new Float32Array(MAX_PARTICLES);
    this._pVY = new Float32Array(MAX_PARTICLES);
    this._pLife = new Float32Array(MAX_PARTICLES);
    this._pMax = new Float32Array(MAX_PARTICLES);
    this._pC = new Uint8Array(MAX_PARTICLES);
    this._pN = 0;

    this._popX = new Float32Array(MAX_POPUPS);
    this._popY = new Float32Array(MAX_POPUPS);
    this._popT = new Float64Array(MAX_POPUPS);
    this._popG = new Uint8Array(MAX_POPUPS);
    this._popSub = new Uint8Array(MAX_POPUPS);
    this._popN = 0;

    this._bX = new Float32Array(MAX_BURSTS);
    this._bW = new Float32Array(MAX_BURSTS);
    this._bT = new Float64Array(MAX_BURSTS);
    this._bG = new Uint8Array(MAX_BURSTS);
    this._bN = 0;

    this._lastNow = 0;
    this._lastEffect = -1e9;
    this._detM = -1;
    this._detT = -1e9;
    this._detShifted = false;

    this._bg = null;
    this._kbWhite = null;
    this._kbBlack = null;
    this._kbYDev = 0;
  }

  setSong(song) {
    const notes = song && Array.isArray(song.notes) ? song.notes : [];
    const vocal = song && Array.isArray(song.vocal) ? song.vocal : [];
    const bpm = Number(song && song.bpm);
    this.bpm = bpm >= 20 && bpm <= 400 ? bpm : 100;
    const bpb = Math.round(Number(song && song.beatsPerBar));
    this.beatsPerBar = bpb >= 1 && bpb <= 16 ? bpb : 4;
    const off = Number(song && song.offset);
    this.offset = Number.isFinite(off) ? off : 0;
    const range = songRange(notes, vocal);
    this.lo = range.lo;
    this.hi = range.hi;
    this._setNotes(notes);
    this._setVocal(vocal);
    if (this.w > 0 && this.h > 0) this._build();
    else this.resize();
  }

  setOptions({ labelStyle, showDetected, showVocal } = {}) {
    let rebuild = false;
    if (labelStyle && labelStyle !== this.labelStyle) {
      this.labelStyle = labelStyle;
      this._setNotes(this.notes);
      rebuild = true;
    }
    if (typeof showDetected === 'boolean') this.showDetected = showDetected;
    if (typeof showVocal === 'boolean') this.showVocal = showVocal;
    if (rebuild && this.layout) this._build();
  }

  /** Re-reads the canvas CSS size. Returns true when the backing store or layout changed. */
  resize() {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!(cw > 0 && ch > 0)) return false;
    const dprRaw = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const dpr = clamp(dprRaw, 1, 2);
    if (cw === this.w && ch === this.h && dpr === this.dpr && this.layout) return false;
    this.w = cw;
    this.h = ch;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cw * dpr));
    this.canvas.height = Math.max(1, Math.round(ch * dpr));
    this._build();
    return true;
  }

  get keyboardTop() {
    return this.hitY;
  }

  get keyboardHeight() {
    return this.kbH;
  }

  /** True while transient effects (particles, popups, flashes) still need frames. */
  get animating() {
    if (this._pN > 0 || this._popN > 0 || this._bN > 0) return true;
    return performance.now() - this._lastEffect < KEY_FLASH_MS + 40;
  }

  clearEffects() {
    this._pN = 0;
    this._popN = 0;
    this._bN = 0;
    this._keyFlashT.fill(-1e9);
    this._lastEffect = -1e9;
    this._detM = -1;
  }

  keyAt(clientX, clientY) {
    if (!this.layout || !this.w) return null;
    const r = this.canvas.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    const x = (clientX - r.left) * (this.w / r.width);
    const y = (clientY - r.top) * (this.h / r.height);
    if (y < this.hitY || y > this.h || x < 0 || x >= this.w) return null;
    if (y < this.hitY + this.blackH) {
      for (let i = 0; i < this.blackKeys.length; i++) {
        const k = this.blackKeys[i];
        if (x >= k.x && x < k.x + k.w) return k.m;
      }
    }
    const idx = clamp(Math.floor(x / this.whiteW), 0, this.whiteKeys.length - 1);
    const key = this.whiteKeys[idx];
    return key ? key.m : null;
  }

  // A chord result (judge groupMode: `indices` lists its notes) gets one popup, at its top note, and a burst and
  // key flash on every key of the chord.
  addJudgeEffect(result) {
    if (!result || !result.note || !this.layout) return;
    const key = this.layout.byMidi.get(Math.round(result.note.m));
    if (!key) return;
    const gi = GRADE_INDEX[result.grade] ?? 3;
    const now = performance.now();
    const cx = key.x + key.w / 2;
    this._lastEffect = now;
    // Chord members are looked up in this.notes only when it is the array the result indexes.
    if (Array.isArray(result.indices) && this.notes[result.index] === result.note) {
      const seen = new Set([key.m]);
      for (const i of result.indices) {
        const n = this.notes[i];
        const k = n ? this.layout.byMidi.get(Math.round(n.m)) : null;
        if (!k || seen.has(k.m)) continue;
        seen.add(k.m);
        this._addBurst(k.x, k.w, gi, now);
        if (gi !== 3) {
          this._keyFlashT[k.m] = now;
          this._keyFlashC[k.m] = gi;
          this._spawnParticles(k.x + k.w / 2, this.hitY - 2, gi, gi === 0 ? 6 : 4, k.w * 0.6);
        }
      }
    }

    // One popup per chord: skip when a same-grade popup was just spawned nearby.
    let dup = false;
    for (let i = 0; i < this._popN; i++) {
      if (this._popG[i] === gi && now - this._popT[i] < 50 && Math.abs(this._popX[i] - cx) < 90) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      let sub = 0;
      if ((gi === 1 || gi === 2) && Number.isFinite(result.deltaReal)) sub = result.deltaReal < 0 ? 1 : 2;
      this._addPopup(cx, this.hitY - Math.min(46, this.hitY * 0.12), gi, sub, now);
    }
    this._addBurst(key.x, key.w, gi, now);
    if (gi !== 3) {
      const m = key.m;
      this._keyFlashT[m] = now;
      this._keyFlashC[m] = gi;
      this._spawnParticles(cx, this.hitY - 2, gi, gi === 0 ? 18 : gi === 1 ? 12 : 8, key.w * 0.6);
    }
  }

  render(snap, lookahead = 2.5) {
    const ctx = this.ctx;
    if (!ctx || !this.layout || !this.w || !snap) return;
    const now = performance.now();
    let dt = (now - this._lastNow) / 1000;
    if (!(dt > 0)) dt = 0;
    else if (dt > 0.05) dt = 0.05;
    this._lastNow = now;

    if (snap.notes && snap.notes !== this.notes) {
      this._setNotes(snap.notes);
      this._layoutNotes();
    }
    if (Array.isArray(snap.vocal) && snap.vocal !== this.vocal) {
      this._setVocal(snap.vocal);
      this._layoutVocal();
    }

    const songTime = Number.isFinite(snap.songTime) ? snap.songTime : 0;
    const look = clamp(Number(lookahead) || 2.5, 0.5, 10);
    const speed = snap.speed > 0 ? snap.speed : 1;
    const pps = this.hitY / look;
    const state = snap.state;
    const holding = state === 'holding';
    const pulse = 0.5 + 0.5 * Math.sin(now / 160);

    const flags = this._flags;
    flags.fill(0);
    if (snap.expectedKeys) for (const m of snap.expectedKeys) if (m >= 0 && m < 128) flags[m] |= EXPECTED;
    if (snap.expectedLeft) for (const m of snap.expectedLeft) if (m >= 0 && m < 128) flags[m] |= LEFT;
    if (snap.pressedKeys) for (const m of snap.pressedKeys) if (m >= 0 && m < 128) flags[m] |= PRESSED;
    this._updateDetected(snap.detected, now);
    if (this._detM >= 0) flags[this._detM] |= DETECTED;

    const dpr = this.dpr;
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this._bg, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this._drawLaneHighlights(flags, holding, pulse);
    this._drawGrid(songTime, look, pps);
    this._drawNotes(snap, songTime, look, pps, speed);
    ctx.fillStyle = this._topFade;
    ctx.fillRect(0, 0, this.w, this._topFadeH);
    this._drawKeyboard(flags, now, holding, pulse);
    this._drawHitLine(songTime, state);
    this._drawEffects(now, dt);
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ setup

  _setNotes(notes) {
    this.notes = Array.isArray(notes) ? notes : [];
    const n = this.notes.length;
    this.noteX = new Float32Array(n);
    this.noteW = new Float32Array(n);
    this.noteBlack = new Uint8Array(n);
    this.noteLeft = new Uint8Array(n);
    this.labels = new Array(n);
    const cache = new Map();
    let maxDur = 0;
    for (let i = 0; i < n; i++) {
      const note = this.notes[i];
      const d = note && note.d > 0 ? note.d : 0;
      if (d > maxDur) maxDur = d;
      if (note && note.h === 'L') this.noteLeft[i] = 1;
      const m = Math.round(note ? note.m : 0);
      let label = cache.get(m);
      if (label === undefined) {
        label = this.labelStyle === 'none' ? '' : noteName(m, this.labelStyle === 'en' ? 'en' : 'solfege');
        cache.set(m, label);
      }
      this.labels[i] = label;
    }
    this.maxDur = maxDur;
    if (this._vis.length < n) {
      const cap = Math.max(n, this._vis.length * 2);
      this._vis = new Int32Array(cap);
      this._visYb = new Float32Array(cap);
      this._visYt = new Float32Array(cap);
    }
  }

  _setVocal(vocal) {
    this.vocal = Array.isArray(vocal) ? vocal : [];
    const n = this.vocal.length;
    this.vocalX = new Float32Array(n);
    this.vocalW = new Float32Array(n);
    let maxDur = 0;
    for (const note of this.vocal) {
      const d = note && note.d > 0 ? note.d : 0;
      if (d > maxDur) maxDur = d;
    }
    this.vocalMaxDur = maxDur;
  }

  // Vocal guide bars span (almost) the whole lane, so they frame a playable note in the same lane.
  _layoutVocal() {
    if (!this.layout) return;
    const byMidi = this.layout.byMidi;
    for (let i = 0; i < this.vocal.length; i++) {
      const note = this.vocal[i];
      const key = note ? byMidi.get(Math.round(note.m)) : null;
      if (!key) {
        this.vocalW[i] = 0;
        continue;
      }
      const inset = key.black ? 0.5 : 1;
      this.vocalX[i] = key.x + inset;
      this.vocalW[i] = Math.max(2, key.w - inset * 2);
    }
  }

  _layoutNotes() {
    if (!this.layout) return;
    const byMidi = this.layout.byMidi;
    for (let i = 0; i < this.notes.length; i++) {
      const key = byMidi.get(Math.round(this.notes[i].m));
      if (!key) {
        this.noteW[i] = 0;
        continue;
      }
      if (key.black) {
        this.noteX[i] = key.x + (key.w - this.noteBW) / 2;
        this.noteW[i] = this.noteBW;
        this.noteBlack[i] = 1;
      } else {
        this.noteX[i] = key.x + (key.w - this.noteWW) / 2;
        this.noteW[i] = this.noteWW;
        this.noteBlack[i] = 0;
      }
    }
  }

  _build() {
    const ctx = this.ctx;
    if (!ctx || !(this.w > 0 && this.h > 0)) return;
    const W = this.w;
    const H = this.h;
    let kb = clamp(H * 0.2, 90, 190);
    if (kb > H * 0.45) kb = H * 0.45;
    this.kbH = kb;
    this.hitY = H - kb;
    this.blackH = kb * 0.62;

    this.layout = layoutKeys(this.lo, this.hi, W);
    this.whiteKeys = this.layout.keys.filter((k) => !k.black).sort((a, b) => a.m - b.m);
    this.blackKeys = this.layout.keys.filter((k) => k.black);
    this.whiteW = this.layout.whiteW || W;
    this.blackW = this.blackKeys.length ? this.blackKeys[0].w : this.whiteW * 0.58;
    this.noteWW = Math.max(4, this.whiteW * 0.76);
    this.noteBW = Math.max(3, this.blackW * 0.9);
    this._layoutNotes();
    this._layoutVocal();

    const hitY = this.hitY;
    // Right hand (and untagged notes): cyan on white keys, violet on black keys. Left hand: amber / orange.
    this._gradWhiteNote = this._noteGradient(this.noteWW, '#0e7490', '#22d3ee', '#a5f3fc');
    this._gradBlackNote = this._noteGradient(this.noteBW, '#5b21b6', '#8b5cf6', '#ddd6fe');
    this._gradWhiteNoteL = this._noteGradient(this.noteWW, '#b45309', '#fbbf24', '#fef3c7');
    this._gradBlackNoteL = this._noteGradient(this.noteBW, '#9a3412', '#f97316', '#fed7aa');

    this._glowH = Math.min(hitY, Math.max(80, hitY * 0.32));
    this._laneCyan = this._verticalGlow(hitY - this._glowH, hitY, '34,211,238', 0.3);
    this._laneViolet = this._verticalGlow(hitY - this._glowH, hitY, '167,139,250', 0.38);
    this._laneAmber = this._verticalGlow(hitY - this._glowH, hitY, '251,191,36', 0.3);
    this._laneOrange = this._verticalGlow(hitY - this._glowH, hitY, '249,115,22', 0.38);
    this._lanePressed = this._verticalGlow(hitY - this._glowH * 0.7, hitY, '124,92,255', 0.22);
    this._burstH = Math.min(hitY, 150);
    this._burstGrad = GRADE_RGB.map((rgb) => this._verticalGlow(hitY - this._burstH, hitY, rgb, 0.55));
    const hg = ctx.createLinearGradient(0, hitY - 28, 0, hitY + 3);
    hg.addColorStop(0, 'rgba(34,211,238,0)');
    hg.addColorStop(0.75, 'rgba(34,211,238,0.2)');
    hg.addColorStop(1, 'rgba(165,243,252,0.55)');
    this._hitGlow = hg;
    this._topFadeH = Math.min(70, hitY * 0.16);
    const tf = ctx.createLinearGradient(0, 0, 0, this._topFadeH);
    tf.addColorStop(0, 'rgba(5,7,15,1)');
    tf.addColorStop(1, 'rgba(5,7,15,0)');
    this._topFade = tf;

    const fw = Math.round(clamp(this.noteWW * 0.36, 10, 18));
    const fb = Math.round(clamp(this.noteBW * 0.46, 9, 15));
    this._fontNoteW = `700 ${fw}px ${FONT}`;
    this._fontNoteB = `700 ${fb}px ${FONT}`;
    this._labelW = fw;
    this._labelB = fb;
    this._popSize = Math.round(clamp(this.whiteW * 0.3, 16, 26));
    this._fontPopup = `italic 900 ${this._popSize}px ${FONT}`;
    this._fontSub = `700 ${Math.round(this._popSize * 0.55)}px ${FONT}`;

    this._buildLayers();
  }

  // Horizontal note gradient: dark edges, base colour, light centre.
  _noteGradient(w, edge, base, light) {
    const g = this.ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, edge);
    g.addColorStop(0.2, base);
    g.addColorStop(0.5, light);
    g.addColorStop(0.8, base);
    g.addColorStop(1, edge);
    return g;
  }

  _verticalGlow(y0, y1, rgb, alpha) {
    const g = this.ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, `rgba(${rgb},0)`);
    g.addColorStop(1, `rgba(${rgb},${alpha})`);
    return g;
  }

  _buildLayers() {
    const dpr = this.dpr;
    const W = this.w;
    const wDev = this.canvas.width;
    const hitDev = Math.max(1, Math.round(this.hitY * dpr));
    const kbDev = Math.max(1, this.canvas.height - hitDev);
    this._kbYDev = hitDev;
    this._bg = makeLayer(this._bg, wDev, hitDev);
    this._kbWhite = makeLayer(this._kbWhite, wDev, kbDev);
    this._kbBlack = makeLayer(this._kbBlack, wDev, kbDev);
    this._drawBackgroundLayer(this._bg.getContext('2d'), W, this.hitY, dpr);
    this._drawWhiteLayer(this._kbWhite.getContext('2d'), W, this.kbH, dpr);
    this._drawBlackLayer(this._kbBlack.getContext('2d'), W, this.kbH, dpr);
  }

  _drawBackgroundLayer(c, W, H, dpr) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#05070f');
    g.addColorStop(0.55, '#0a0e24');
    g.addColorStop(1, '#141a46');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    // Subtle alternating octave bands.
    for (const k of this.whiteKeys) {
      if (Math.floor(k.m / 12) % 2 === 0) {
        c.fillStyle = 'rgba(255,255,255,0.016)';
        c.fillRect(k.x, 0, k.w, H);
      }
    }
    // Black-key lanes are darker.
    c.fillStyle = 'rgba(0,0,0,0.3)';
    for (const k of this.blackKeys) c.fillRect(k.x, 0, k.w, H);
    c.fillStyle = 'rgba(255,255,255,0.025)';
    for (const k of this.blackKeys) {
      c.fillRect(k.x, 0, 1, H);
      c.fillRect(k.x + k.w - 1, 0, 1, H);
    }
    // White-lane separators; C (octave) lines brighter.
    for (const k of this.whiteKeys) {
      const pc = pitchClass(k.m);
      if (pc === 0) c.fillStyle = 'rgba(150,165,255,0.2)';
      else if (pc === 5) c.fillStyle = 'rgba(255,255,255,0.07)';
      else c.fillStyle = 'rgba(255,255,255,0.04)';
      c.fillRect(Math.round(k.x), 0, 1, H);
    }
    // Faint octave captions just above the hit line.
    const size = Math.round(clamp(this.whiteW * 0.22, 9, 13));
    c.font = `600 ${size}px ${FONT}`;
    c.textAlign = 'left';
    c.textBaseline = 'bottom';
    c.fillStyle = 'rgba(170,180,255,0.28)';
    for (const k of this.whiteKeys) {
      if (pitchClass(k.m) === 0) c.fillText(noteName(k.m, 'en'), k.x + 4, H - 8);
    }
  }

  _drawWhiteLayer(c, W, H, dpr) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#16171f';
    c.fillRect(0, 0, W, H);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#cfd2de');
    g.addColorStop(0.07, '#f4f5fa');
    g.addColorStop(0.6, '#ffffff');
    g.addColorStop(0.9, '#eceef5');
    g.addColorStop(1, '#c4c7d4');
    const r = Math.min(6, this.whiteW * 0.12);
    for (const k of this.whiteKeys) {
      c.fillStyle = g;
      keyPath(c, k.x + 0.75, 0, k.w - 1.5, H - 1, r);
      c.fill();
      c.fillStyle = 'rgba(0,0,0,0.07)';
      c.fillRect(k.x + 0.75, H - 9, k.w - 1.5, 3);
    }
    // Felt strip + shadow under it.
    c.fillStyle = '#6b1424';
    c.fillRect(0, 0, W, FELT);
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(0, FELT - 1, W, 1);
    const sh = c.createLinearGradient(0, FELT, 0, FELT + 14);
    sh.addColorStop(0, 'rgba(0,0,0,0.32)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = sh;
    c.fillRect(0, FELT, W, 14);

    // Key labels: every white key for 도레미, C keys emphasised.
    const size = Math.round(clamp(this.whiteW * 0.25, 9, 15));
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const y = H - 20;
    for (const k of this.whiteKeys) {
      const isC = pitchClass(k.m) === 0;
      let text = '';
      if (this.labelStyle === 'solfege') text = noteName(k.m, isC ? 'solfege-octave' : 'solfege');
      else if (this.labelStyle === 'en') text = isC ? noteName(k.m, 'en') : noteName(k.m, 'en').replace(/-?\d+$/, '');
      else if (isC) text = noteName(k.m, 'en');
      if (!text) continue;
      c.font = `${isC ? 800 : 600} ${size}px ${FONT}`;
      c.fillStyle = isC ? '#3d4466' : '#9aa0bd';
      c.fillText(text, k.x + k.w / 2, y);
    }
  }

  _drawBlackLayer(c, W, H, dpr) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const bh = this.blackH;
    const g = c.createLinearGradient(0, 0, 0, bh);
    g.addColorStop(0, '#2c2d38');
    g.addColorStop(0.12, '#15161d');
    g.addColorStop(0.86, '#0c0c11');
    g.addColorStop(0.9, '#3a3b48');
    g.addColorStop(1, '#22232c');
    const r = Math.min(4, this.blackW * 0.14);
    for (const k of this.blackKeys) {
      c.fillStyle = 'rgba(0,0,0,0.28)';
      c.fillRect(k.x + 2, 0, k.w, bh + 4);
      c.fillStyle = g;
      keyPath(c, k.x, 0, k.w, bh, r);
      c.fill();
      c.fillStyle = 'rgba(255,255,255,0.08)';
      c.fillRect(k.x + k.w * 0.2, FELT + 2, Math.max(1, k.w * 0.1), bh * 0.7);
    }
    c.fillStyle = '#6b1424';
    c.fillRect(0, 0, W, FELT);
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(0, FELT - 1, W, 1);
  }

  // ------------------------------------------------------------------ per-frame drawing

  _updateDetected(det, now) {
    let m = -1;
    if (this.showDetected && det && det.gateOpen && det.pitch && det.pitch.clarity >= 0.7
      && Number.isFinite(det.pitch.midi)) {
      m = Math.round(det.pitch.midi);
    }
    if (m < 0) {
      if (now - this._detT > DETECT_HOLD_MS) this._detM = -1;
      return;
    }
    let shifted = false;
    let guard = 0;
    while (m < this.lo && guard++ < 12) {
      m += 12;
      shifted = true;
    }
    while (m > this.hi && guard++ < 24) {
      m -= 12;
      shifted = true;
    }
    if (m < this.lo || m > this.hi || !this.layout.byMidi.has(m)) {
      if (now - this._detT > DETECT_HOLD_MS) this._detM = -1;
      return;
    }
    this._detM = m;
    this._detShifted = shifted;
    this._detT = now;
  }

  _drawLaneHighlights(flags, holding, pulse) {
    const ctx = this.ctx;
    const keys = this.layout.keys;
    const top = this.hitY - this._glowH;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const f = flags[k.m];
      if (!(f & (EXPECTED | PRESSED))) continue;
      if (f & EXPECTED) {
        ctx.globalAlpha = holding ? 0.55 + 0.45 * pulse : 1;
        if (f & LEFT) ctx.fillStyle = k.black ? this._laneOrange : this._laneAmber;
        else ctx.fillStyle = k.black ? this._laneViolet : this._laneCyan;
        ctx.fillRect(k.x, top, k.w, this._glowH);
      } else {
        ctx.globalAlpha = 1;
        ctx.fillStyle = this._lanePressed;
        ctx.fillRect(k.x, this.hitY - this._glowH * 0.7, k.w, this._glowH * 0.7);
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawGrid(songTime, look, pps) {
    const ctx = this.ctx;
    const beat = 60 / this.bpm;
    const W = this.w;
    const hitY = this.hitY;
    const bpb = this.beatsPerBar;
    let k0 = Math.ceil((songTime - this.offset) / beat - 1e-6);
    const k1 = Math.floor((songTime + look - this.offset) / beat);
    if (k1 - k0 > 600) k0 = k1 - 600;
    const showBeats = beat * pps >= 10;
    if (showBeats) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      for (let k = k0; k <= k1; k++) {
        if (((k % bpb) + bpb) % bpb === 0) continue;
        const y = hitY - (this.offset + k * beat - songTime) * pps;
        ctx.fillRect(0, y - 0.5, W, 1);
      }
    }
    ctx.fillStyle = 'rgba(190,200,255,0.15)';
    for (let k = k0; k <= k1; k++) {
      if (((k % bpb) + bpb) % bpb !== 0) continue;
      const y = hitY - (this.offset + k * beat - songTime) * pps;
      ctx.fillRect(0, y - 1, W, 2);
    }
  }

  // The sung melody: outlined bars in their lanes, behind the playable notes; the note being sung is brighter.
  _drawVocal(songTime, tEnd, pps) {
    const vocal = this.vocal;
    if (!this.showVocal || !vocal.length) return;
    const ctx = this.ctx;
    const hitY = this.hitY;
    ctx.lineWidth = 2;
    for (let i = lowerBound(vocal, songTime - this.vocalMaxDur - 0.05); i < vocal.length; i++) {
      const note = vocal[i];
      const t = note.t;
      if (t > tEnd) break;
      const w = this.vocalW[i];
      if (!(w > 0)) continue;
      const end = t + note.d;
      if (end < songTime - 0.01) continue;
      const yb = hitY - (t - songTime) * pps;
      let yt = hitY - (end - songTime) * pps;
      if (yb - yt < 10) yt = yb - 10;
      const x = this.vocalX[i];
      const r = Math.min(6, w * 0.25);
      const active = songTime >= t && songTime < end;
      roundRectPath(ctx, x + 1, yt + 1, w - 2, yb - yt - 2, r);
      if (active) {
        ctx.fillStyle = VOCAL_ACTIVE_FILL;
        ctx.fill();
      }
      ctx.strokeStyle = active ? VOCAL_ACTIVE_STROKE : VOCAL_STROKE;
      ctx.stroke();
    }
  }

  _drawNotes(snap, songTime, look, pps, speed) {
    const notes = this.notes;
    const n = notes.length;
    if (!n && !(this.showVocal && this.vocal.length)) return;
    const ctx = this.ctx;
    const dpr = this.dpr;
    const W = this.w;
    const hitY = this.hitY;
    const states = snap.states;
    const judgedAt = snap.judgedAt;
    // Display-only notes of a judged run fade neutrally; listen mode keeps its own look.
    const autoGrade = snap.mode === 'listen' ? GRADE_INDEX.auto : AUTO_GRADE;
    const tEnd = songTime + look + 0.05;
    const vis = this._vis;
    const visYb = this._visYb;
    const visYt = this._visYt;
    let vc = 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, hitY);
    ctx.clip();
    this._drawVocal(songTime, tEnd, pps);
    ctx.lineWidth = 1;

    for (let i = lowerBound(notes, songTime - this.maxDur - 0.05); i < n; i++) {
      const note = notes[i];
      const t = note.t;
      if (t > tEnd) break;
      const w = this.noteW[i];
      if (!(w > 0)) continue;
      const end = t + note.d;
      if (end < songTime - 0.01) continue;
      const yb = hitY - (t - songTime) * pps;
      let yt = hitY - (end - songTime) * pps;
      if (yb - yt < 10) yt = yb - 10;
      else if (yb - yt > 16) yt += 1.5;
      const hgt = yb - yt;
      const x = this.noteX[i];
      const black = this.noteBlack[i] === 1;
      const left = this.noteLeft[i] === 1;
      const r = Math.min(7, w * 0.3);
      const st = states ? states[i] : 'pending';

      if (st === undefined || st === null || st === 'pending') {
        ctx.setTransform(dpr, 0, 0, dpr, dpr * x, 0);
        if (left) ctx.fillStyle = black ? this._gradBlackNoteL : this._gradWhiteNoteL;
        else ctx.fillStyle = black ? this._gradBlackNote : this._gradWhiteNote;
        roundRectPath(ctx, 0, yt, w, hgt, r);
        ctx.fill();
        if (left) ctx.strokeStyle = black ? 'rgba(255,237,213,0.55)' : 'rgba(254,243,199,0.6)';
        else ctx.strokeStyle = black ? 'rgba(237,233,254,0.55)' : 'rgba(207,250,254,0.6)';
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(3, yb - 4.5, w - 6, 2.5);
        if (vc < vis.length) {
          vis[vc] = i;
          visYb[vc] = yb;
          visYt[vc] = yt;
          vc++;
        }
      } else if (st === 'miss') {
        ctx.setTransform(dpr, 0, 0, dpr, dpr * x, 0);
        ctx.fillStyle = 'rgba(92,52,66,0.75)';
        roundRectPath(ctx, 0, yt, w, hgt, r);
        ctx.fill();
        ctx.strokeStyle = 'rgba(248,113,113,0.45)';
        ctx.stroke();
      } else {
        const auto = st === 'auto';
        const gi = auto ? autoGrade : GRADE_INDEX[st] ?? 0;
        const dim = auto && gi === AUTO_GRADE ? 0.5 : 1;
        let jt = judgedAt ? judgedAt[i] : NaN;
        if (!Number.isFinite(jt)) jt = t;
        const age = Math.max(0, (songTime - jt) / speed);
        ctx.setTransform(dpr, 0, 0, dpr, dpr * x, 0);
        if (note.d >= SUSTAIN_MIN && yt < hitY - 2) {
          // Held tail keeps glowing until it slides into the keyboard.
          ctx.globalAlpha = 0.3 * dim;
          ctx.fillStyle = GRADE_COLOR[gi];
          roundRectPath(ctx, 0, yt, w, Math.min(yb, hitY + r) - yt, r);
          ctx.fill();
        }
        if (age < FLASH_SEC) {
          const a = (1 - age / FLASH_SEC) * dim;
          ctx.fillStyle = GRADE_COLOR[gi];
          ctx.globalAlpha = a * 0.3;
          roundRectPath(ctx, -5, yt - 5, w + 10, hgt + 10, r + 5);
          ctx.fill();
          ctx.globalAlpha = a;
          roundRectPath(ctx, 0, yt, w, hgt, r);
          ctx.fill();
          ctx.globalAlpha = a * 0.75;
          ctx.fillStyle = '#ffffff';
          roundRectPath(ctx, w * 0.22, yt + 2, w * 0.56, Math.max(2, hgt - 4), r);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Labels: one pass per font to avoid font switching per note (left-hand white notes use a dark brown).
    if (vc > 0 && this.labelStyle !== 'none') {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let pass = 0; pass < 2; pass++) {
        const black = pass === 1;
        const size = black ? this._labelB : this._labelW;
        ctx.font = black ? this._fontNoteB : this._fontNoteW;
        let shade = -1;
        for (let k = 0; k < vc; k++) {
          const i = vis[k];
          if ((this.noteBlack[i] === 1) !== black) continue;
          const left = !black && this.noteLeft[i] === 1 ? 1 : 0;
          if (left !== shade) {
            shade = left;
            ctx.fillStyle = black ? '#ffffff' : left ? '#451a03' : '#053340';
          }
          const label = this.labels[i];
          if (!label) continue;
          const yt = visYt[k];
          const ly = Math.min(visYb[k], hitY) - size * 0.95;
          if (ly - size * 0.6 < yt || ly < 0) continue;
          ctx.fillText(label, this.noteX[i] + this.noteW[i] / 2, ly);
        }
      }
    }
    ctx.restore();
  }

  _drawKeyboard(flags, now, holding, pulse) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const hitY = this.hitY;
    const kbH = this.kbH;
    const flashT = this._keyFlashT;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this._kbWhite, 0, this._kbYDev);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const whiteTop = hitY + FELT;
    const whiteH = kbH - FELT - 1;
    for (let i = 0; i < this.whiteKeys.length; i++) {
      const k = this.whiteKeys[i];
      const f = flags[k.m];
      const age = now - flashT[k.m];
      if (!f && age > KEY_FLASH_MS) continue;
      const x = k.x + 1;
      const w = k.w - 2;
      if (f & PRESSED) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#7c5cff';
        ctx.fillRect(x, whiteTop, w, whiteH);
      }
      if (f & EXPECTED) {
        ctx.globalAlpha = holding ? 0.3 + 0.3 * pulse : 0.34;
        ctx.fillStyle = f & LEFT ? '#fbbf24' : '#22d3ee';
        ctx.fillRect(x, whiteTop, w, whiteH);
        ctx.globalAlpha = 0.95;
        ctx.fillRect(x, whiteTop, w, 4);
      }
      if (f & DETECTED) {
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = '#fb923c';
        ctx.fillRect(x, whiteTop, w, whiteH);
      }
      if (age <= KEY_FLASH_MS) {
        ctx.globalAlpha = 0.75 * (1 - age / KEY_FLASH_MS);
        ctx.fillStyle = GRADE_COLOR[this._keyFlashC[k.m]];
        ctx.fillRect(x, whiteTop, w, whiteH);
      }
    }
    ctx.globalAlpha = 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this._kbBlack, 0, this._kbYDev);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const blackTop = hitY + FELT;
    const blackH = this.blackH - FELT - 1;
    for (let i = 0; i < this.blackKeys.length; i++) {
      const k = this.blackKeys[i];
      const f = flags[k.m];
      const age = now - flashT[k.m];
      if (!f && age > KEY_FLASH_MS) continue;
      const x = k.x + 1;
      const w = k.w - 2;
      if (f & PRESSED) {
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = '#7c5cff';
        ctx.fillRect(x, blackTop, w, blackH);
      }
      if (f & EXPECTED) {
        const left = (f & LEFT) !== 0;
        ctx.globalAlpha = holding ? 0.45 + 0.35 * pulse : 0.6;
        ctx.fillStyle = left ? '#f97316' : '#a78bfa';
        ctx.fillRect(x, blackTop, w, blackH);
        ctx.globalAlpha = 1;
        ctx.fillStyle = left ? '#fed7aa' : '#ddd6fe';
        ctx.fillRect(x, blackTop, w, 3);
      }
      if (f & DETECTED) {
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#fb923c';
        ctx.fillRect(x, blackTop, w, blackH);
      }
      if (age <= KEY_FLASH_MS) {
        ctx.globalAlpha = 0.85 * (1 - age / KEY_FLASH_MS);
        ctx.fillStyle = GRADE_COLOR[this._keyFlashC[k.m]];
        ctx.fillRect(x, blackTop, w, blackH);
      }
    }
    ctx.globalAlpha = 1;

    // Detected pitch: marker dot on the key + a short bar on the hit line.
    if (this._detM >= 0) {
      const key = this.layout.byMidi.get(this._detM);
      if (key) {
        const cx = key.x + key.w / 2;
        const rad = clamp(key.w * 0.16, 3.5, 8);
        const cy = key.black ? hitY + this.blackH - rad * 2.2 : hitY + kbH - 38 - rad;
        ctx.fillStyle = '#fb923c';
        ctx.fillRect(key.x + 2, hitY - 4, key.w - 4, 4);
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        if (this._detShifted) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#fb923c';
          ctx.stroke();
        } else {
          ctx.fill();
        }
      }
    }
  }

  _drawHitLine(songTime, state) {
    const ctx = this.ctx;
    const W = this.w;
    const hitY = this.hitY;
    let beatPulse = 0;
    if (state === 'playing' || state === 'resuming') {
      const beat = 60 / this.bpm;
      let ph = ((songTime - this.offset) / beat) % 1;
      if (ph < 0) ph += 1;
      beatPulse = (1 - ph) * (1 - ph) * (1 - ph);
    }
    ctx.globalAlpha = 0.7 + 0.3 * beatPulse;
    ctx.fillStyle = this._hitGlow;
    ctx.fillRect(0, hitY - 28, W, 31);
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(34,211,238,0.35)';
    ctx.fillRect(0, hitY - 3, W, 6);
    ctx.fillStyle = 'rgba(165,243,252,0.95)';
    ctx.fillRect(0, hitY - 1.5, W, 3);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, hitY - 0.5, W, 1);
  }

  _drawEffects(now, dt) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const hitY = this.hitY;

    // Lane bursts.
    for (let i = 0; i < this._bN; i++) {
      const age = now - this._bT[i];
      if (age > BURST_MS) {
        this._removeBurst(i);
        i--;
        continue;
      }
      const a = 1 - age / BURST_MS;
      const g = this._bG[i];
      const x = this._bX[i];
      const w = this._bW[i];
      const grow = (1 - a) * 8;
      ctx.globalAlpha = a * (g === 3 ? 0.5 : 1);
      ctx.fillStyle = this._burstGrad[g];
      ctx.fillRect(x - grow / 2, hitY - this._burstH, w + grow, this._burstH);
      ctx.fillStyle = GRADE_COLOR[g];
      ctx.globalAlpha = a * 0.9;
      ctx.fillRect(x - 4 - grow, hitY - 3, w + 8 + grow * 2, 6);
    }

    // Particles: integrate, then draw grouped by colour.
    const pX = this._pX;
    const pY = this._pY;
    const pVX = this._pVX;
    const pVY = this._pVY;
    const pL = this._pLife;
    const pM = this._pMax;
    const pC = this._pC;
    if (dt > 0) {
      const drag = Math.max(0, 1 - 2.2 * dt);
      for (let i = 0; i < this._pN; i++) {
        pL[i] -= dt;
        if (pL[i] <= 0) {
          const last = --this._pN;
          pX[i] = pX[last]; pY[i] = pY[last]; pVX[i] = pVX[last]; pVY[i] = pVY[last];
          pL[i] = pL[last]; pM[i] = pM[last]; pC[i] = pC[last];
          i--;
          continue;
        }
        pVY[i] += 820 * dt;
        pVX[i] *= drag;
        pX[i] += pVX[i] * dt;
        pY[i] += pVY[i] * dt;
      }
    }
    if (this._pN > 0) {
      for (let c = 0; c < 5; c++) {
        ctx.fillStyle = GRADE_COLOR[c];
        for (let i = 0; i < this._pN; i++) {
          if (pC[i] !== c) continue;
          const life = pL[i] / pM[i];
          const s = 1.5 + 3.5 * life;
          ctx.globalAlpha = life;
          ctx.fillRect(pX[i] - s / 2, pY[i] - s / 2, s, s);
        }
      }
    }

    // Grade popups.
    if (this._popN > 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      const size = this._popSize;
      const half = size * 2.4;
      for (let i = 0; i < this._popN; i++) {
        const age = now - this._popT[i];
        if (age > POPUP_MS) {
          this._removePopup(i);
          i--;
          continue;
        }
        const t = age / POPUP_MS;
        const scale = age < 90 ? 1.35 - 0.35 * (age / 90) : 1;
        const rise = 24 * (1 - (1 - t) * (1 - t));
        const alpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
        const g = this._popG[i];
        const x = clamp(this._popX[i], half, this.w - half);
        const y = this._popY[i] - rise;
        ctx.globalAlpha = alpha;
        ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);
        ctx.font = this._fontPopup;
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(5,7,18,0.85)';
        ctx.strokeText(GRADE_LABEL[g], 0, 0);
        ctx.fillStyle = GRADE_COLOR[g];
        ctx.fillText(GRADE_LABEL[g], 0, 0);
        const sub = this._popSub[i];
        if (sub) {
          ctx.font = this._fontSub;
          ctx.lineWidth = 3;
          ctx.strokeText(SUB_LABEL[sub], 0, size * 0.85);
          ctx.fillStyle = '#e6e9ff';
          ctx.fillText(SUB_LABEL[sub], 0, size * 0.85);
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ effect pools

  _addPopup(x, y, g, sub, now) {
    // The newest judgement replaces older popups it would overlap.
    const minGap = this._popSize * 4.6;
    for (let i = 0; i < this._popN; i++) {
      if (Math.abs(this._popX[i] - x) < minGap) {
        this._removePopup(i);
        i--;
      }
    }
    if (this._popN >= MAX_POPUPS) this._removePopup(0);
    const i = this._popN++;
    this._popX[i] = x;
    this._popY[i] = y;
    this._popT[i] = now;
    this._popG[i] = g;
    this._popSub[i] = sub;
  }

  _removePopup(i) {
    const last = --this._popN;
    if (i === last) return;
    this._popX[i] = this._popX[last];
    this._popY[i] = this._popY[last];
    this._popT[i] = this._popT[last];
    this._popG[i] = this._popG[last];
    this._popSub[i] = this._popSub[last];
  }

  _addBurst(x, w, g, now) {
    if (this._bN >= MAX_BURSTS) this._removeBurst(0);
    const i = this._bN++;
    this._bX[i] = x;
    this._bW[i] = w;
    this._bT[i] = now;
    this._bG[i] = g;
  }

  _removeBurst(i) {
    const last = --this._bN;
    if (i === last) return;
    this._bX[i] = this._bX[last];
    this._bW[i] = this._bW[last];
    this._bT[i] = this._bT[last];
    this._bG[i] = this._bG[last];
  }

  _spawnParticles(cx, y, g, count, spread) {
    for (let k = 0; k < count && this._pN < MAX_PARTICLES; k++) {
      const i = this._pN++;
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.95;
      const sp = 170 + Math.random() * 280;
      this._pX[i] = cx + (Math.random() - 0.5) * spread;
      this._pY[i] = y;
      this._pVX[i] = Math.cos(ang) * sp;
      this._pVY[i] = Math.sin(ang) * sp;
      const life = 0.4 + Math.random() * 0.4;
      this._pLife[i] = life;
      this._pMax[i] = life;
      this._pC[i] = Math.random() < 0.25 ? 4 : g;
    }
  }
}
