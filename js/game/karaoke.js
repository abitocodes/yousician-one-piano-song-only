// 노래방-style lyrics: two alternating line slots (top left-aligned, bottom right-aligned) with per-syllable
// progressive colour fill. The timing logic (buildKaraokeTimeline / karaokeViewAt) is pure and DOM-free.

const GAP_FOR_DOTS = 3; // s; a line preceded by a gap at least this long gets "ready" dots
const HOLD_AFTER = 1; // s a finished line lingers when a long gap follows
const DOTS = 4;
const MIN_SCALE = 0.4;

/** Normalises Line[] into sorted, non-empty lines with cached start/end/gap arrays. */
export function buildKaraokeTimeline(lines) {
  const list = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const syls = line && Array.isArray(line.syllables) ? line.syllables : [];
    const norm = [];
    for (const s of syls) {
      if (!s || typeof s.text !== 'string' || !Number.isFinite(s.t) || !s.text.trim()) continue;
      norm.push({ text: s.text, t: s.t, d: Number.isFinite(s.d) && s.d > 0 ? s.d : 0.05 });
    }
    if (norm.length) list.push(norm);
  }
  const starts = list.map((syls) => syls.reduce((m, s) => Math.min(m, s.t), Infinity));
  const order = list.map((_, i) => i).sort((a, b) => starts[a] - starts[b]);
  const sorted = order.map((i) => list[i]);
  const n = sorted.length;
  const tl = {
    lines: sorted,
    starts: new Float64Array(n),
    ends: new Float64Array(n),
    gapBefore: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    let start = Infinity;
    let end = -Infinity;
    for (const s of sorted[i]) {
      if (s.t < start) start = s.t;
      if (s.t + s.d > end) end = s.t + s.d;
    }
    tl.starts[i] = start;
    tl.ends[i] = end;
    tl.gapBefore[i] = i === 0 ? Infinity : start - tl.ends[i - 1];
  }
  return tl;
}

export function createKaraokeView() {
  return { current: -1, slots: [-1, -1], dots: [0, 0], idle: null };
}

/**
 * Which line each slot shows at `time`. Slot (i % 2) holds line i while it is the current or the next line.
 * `idle` is 'intro' | 'gap' | 'end' | 'none' when both slots are empty, else null.
 */
export function karaokeViewAt(tl, time, beat = 0.5, out = createKaraokeView()) {
  out.current = -1;
  out.slots[0] = -1;
  out.slots[1] = -1;
  out.dots[0] = 0;
  out.dots[1] = 0;
  out.idle = null;
  const n = tl.starts.length;
  if (!n) {
    out.idle = 'none';
    return out;
  }
  const b = beat > 0 ? beat : 0.5;
  const lead = Math.max(3, DOTS * b) + 1.5;

  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tl.starts[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  const c = lo - 1;
  const nx = c + 1;
  const nextClose = nx < n && tl.gapBefore[nx] < GAP_FOR_DOTS;

  if (c >= 0 && (time < tl.ends[c] + HOLD_AFTER || nextClose)) out.current = c;

  if (out.current >= 0) {
    out.slots[c % 2] = c;
    if (nx < n && (nextClose || tl.starts[nx] - time <= lead)) out.slots[nx % 2] = nx;
  } else if (nx < n && tl.starts[nx] - time <= lead) {
    out.slots[nx % 2] = nx;
    if (nx + 1 < n && tl.gapBefore[nx + 1] < GAP_FOR_DOTS) out.slots[(nx + 1) % 2] = nx + 1;
  }

  if (nx < n && out.slots[nx % 2] === nx && tl.gapBefore[nx] >= GAP_FOR_DOTS && (c < 0 || time >= tl.ends[c])) {
    const remain = tl.starts[nx] - time;
    out.dots[nx % 2] = remain > 0 ? Math.min(DOTS, Math.ceil(remain / b - 1e-9)) : 0;
  }

  if (out.slots[0] < 0 && out.slots[1] < 0) out.idle = c < 0 ? 'intro' : nx < n ? 'gap' : 'end';
  return out;
}

/** Fill amount of one syllable at `time`, quantised so unchanged frames compare equal. */
export function syllableProgress(t, d, time) {
  const p = (time - t) / (d > 0 ? d : 0.05);
  if (!(p > 0)) return 0;
  if (p >= 1) return 1;
  return Math.round(p * 500) / 500;
}

export class Karaoke {
  constructor(rootEl) {
    this.root = rootEl;
    rootEl.classList.add('pk-karaoke');
    rootEl.replaceChildren();
    rootEl.setAttribute('aria-live', 'off');
    this.slots = [0, 1].map((i) => {
      const el = document.createElement('div');
      el.className = `pk-kara-slot ${i === 0 ? 'is-top' : 'is-bottom'}`;
      rootEl.append(el);
      return { el, lineEl: null, dotsEl: null, dotEls: [], line: -1, dots: -1, fills: [], ts: null, ds: null, ps: null };
    });
    this.idleEl = document.createElement('div');
    this.idleEl.className = 'pk-kara-idle';
    this.idleEl.hidden = true;
    rootEl.append(this.idleEl);

    this.tl = buildKaraokeTimeline([]);
    this.beat = 0.5;
    this.idleText = '';
    this.view = createKaraokeView();
    this._idle = undefined;
    this._fontBase = 0;
    this._width = 0;
    this._ro = null;
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.refit());
      this._ro.observe(rootEl);
    }
    this.refit();
  }

  get hasLines() {
    return this.tl.lines.length > 0;
  }

  /** `bpm` paces the ready dots (one per beat, default 0.5 s); `idleText` shows before the first line. */
  setLines(lines, { bpm, idleText } = {}) {
    this.tl = buildKaraokeTimeline(lines);
    const b = Number(bpm);
    this.beat = b > 0 ? Math.min(2, Math.max(0.2, 60 / b)) : 0.5;
    if (typeof idleText === 'string') this.idleText = idleText;
    this.reset();
  }

  update(songTime) {
    if (!Number.isFinite(songTime)) return;
    const v = karaokeViewAt(this.tl, songTime, this.beat, this.view);
    for (let s = 0; s < 2; s++) {
      const slot = this.slots[s];
      const li = v.slots[s];
      if (slot.line !== li) this._show(slot, li);
      if (li < 0) continue;
      const dots = v.dots[s];
      if (dots !== slot.dots) this._setDots(slot, dots);
      this._progress(slot, songTime);
    }
    if (v.idle !== this._idle) {
      this._idle = v.idle;
      let text = '';
      if (v.idle === 'intro') text = this.idleText;
      else if (v.idle === 'gap') text = '♪ 간주 중 ♪';
      this.idleEl.textContent = text;
      this.idleEl.hidden = !text;
    }
  }

  reset() {
    for (const slot of this.slots) this._show(slot, -1);
    this._idle = undefined;
    this.idleEl.hidden = true;
  }

  /** Recomputes the base font size from the panel size and re-fits both lines. */
  refit() {
    const h = this.root.clientHeight;
    const w = this.root.clientWidth;
    if (!(h > 0 && w > 0)) return;
    const base = Math.round(Math.max(16, Math.min(66, h * 0.29, w * 0.065)));
    this._width = w;
    if (base !== this._fontBase) {
      this._fontBase = base;
      this.idleEl.style.fontSize = `${Math.round(base * 0.55)}px`;
    }
    for (const slot of this.slots) this._fit(slot);
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    this._ro = null;
    this.root.replaceChildren();
    this.root.classList.remove('pk-karaoke');
  }

  // ------------------------------------------------------------------ internals

  _show(slot, li) {
    slot.line = li;
    slot.dots = -1;
    if (slot.lineEl) slot.lineEl.remove();
    slot.lineEl = null;
    slot.dotsEl = null;
    slot.dotEls = [];
    slot.fills = [];
    if (li < 0) return;
    const syls = this.tl.lines[li];
    const n = syls.length;
    const lineEl = document.createElement('span');
    lineEl.className = 'pk-kara-line';
    const dotsEl = document.createElement('span');
    dotsEl.className = 'pk-kara-dots';
    dotsEl.hidden = true;
    dotsEl.setAttribute('aria-hidden', 'true');
    for (let k = 0; k < DOTS; k++) {
      const dot = document.createElement('i');
      dotsEl.append(dot);
      slot.dotEls.push(dot);
    }
    lineEl.append(dotsEl);
    slot.ts = new Float64Array(n);
    slot.ds = new Float64Array(n);
    slot.ps = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const s = syls[i];
      const text = s.text.replace(/\s+$/, '');
      const trailing = text.length < s.text.length;
      const syl = document.createElement('span');
      syl.className = 'syl';
      const base = document.createElement('span');
      base.className = 'base';
      base.textContent = text;
      const fill = document.createElement('span');
      fill.className = 'fill';
      fill.setAttribute('aria-hidden', 'true');
      fill.textContent = text;
      fill.style.setProperty('--p', '0');
      syl.append(base, fill);
      lineEl.append(syl);
      // Trailing whitespace lives outside the syllable so the fill sweeps glyphs only.
      if (trailing && i < n - 1) lineEl.append(document.createTextNode(' '));
      slot.fills.push(fill);
      slot.ts[i] = s.t;
      slot.ds[i] = s.d;
      slot.ps[i] = 0;
    }
    slot.lineEl = lineEl;
    slot.dotsEl = dotsEl;
    slot.el.append(lineEl);
    this._fit(slot);
  }

  _fit(slot) {
    const lineEl = slot.lineEl;
    const base = this._fontBase;
    if (!lineEl || !base) return;
    lineEl.style.fontSize = `${base}px`;
    const avail = slot.el.clientWidth;
    const need = lineEl.offsetWidth;
    if (avail > 0 && need > avail) {
      const size = Math.max(base * MIN_SCALE, Math.floor(base * (avail / need) * 0.98));
      lineEl.style.fontSize = `${size}px`;
    }
  }

  _setDots(slot, n) {
    slot.dots = n;
    if (!slot.dotsEl) return;
    slot.dotsEl.hidden = n <= 0;
    for (let k = 0; k < DOTS; k++) slot.dotEls[k].classList.toggle('off', k < DOTS - n);
  }

  _progress(slot, time) {
    const ts = slot.ts;
    const n = ts.length;
    for (let i = 0; i < n; i++) {
      const p = syllableProgress(ts[i], slot.ds[i], time);
      if (p !== slot.ps[i]) {
        slot.ps[i] = p;
        slot.fills[i].style.setProperty('--p', String(p));
      }
    }
  }
}
