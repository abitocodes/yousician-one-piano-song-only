// Standard MIDI File (SMF) parser → notes in seconds, plus melody extraction helpers.

const ERR_NOT_MIDI = 'MIDI 파일이 아니에요.';
const ERR_SMPTE = '지원하지 않는 MIDI 시간 형식이에요.';
const DEFAULT_US_PER_BEAT = 500000; // 120 BPM
const MIN_NOTE_D = 0.05;

const r3 = (x) => Math.round(x * 1000) / 1000;

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  const tag = Object.prototype.toString.call(input);
  if (input instanceof ArrayBuffer || tag === '[object ArrayBuffer]') return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return Uint8Array.from(input);
  throw new Error(ERR_NOT_MIDI);
}

const str4 = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
const u32 = (b, p) => b[p] * 0x1000000 + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const u16 = (b, p) => (b[p] << 8) | b[p + 1];

// Locates 'MThd' (plain SMF, or inside a RIFF RMID wrapper).
function findHeader(b) {
  if (b.length >= 14 && str4(b, 0) === 'MThd') return 0;
  if (b.length >= 26 && str4(b, 0) === 'RIFF' && str4(b, 8) === 'RMID') {
    const limit = Math.min(b.length - 14, 4096);
    for (let p = 12; p <= limit; p++) {
      if (b[p] === 0x4d && str4(b, p) === 'MThd') return p;
    }
  }
  return -1;
}

function decodeText(bytes) {
  if (!bytes || !bytes.length) return '';
  const attempts = [['utf-8', true], ['euc-kr', false], ['latin1', false]];
  for (const [enc, fatal] of attempts) {
    try {
      return new TextDecoder(enc, { fatal }).decode(bytes);
    } catch {
      // try the next encoding
    }
  }
  return String.fromCharCode(...bytes);
}

function cleanName(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseTrack(b, start, end) {
  let p = start;
  let tick = 0;
  let status = 0;
  let endTick = -1;
  let nameBytes = null;
  let instBytes = null;
  const notes = [];
  const open = new Map(); // ch*128+pitch → FIFO of { tick, vel }
  const tempos = [];
  const sigs = [];
  const programs = new Map();

  const readVlq = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      if (p >= end) return -1;
      const c = b[p++];
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    return v;
  };

  while (p < end) {
    const delta = readVlq();
    if (delta < 0) break;
    tick += delta;
    if (p >= end) break;
    let s = b[p];
    if (s & 0x80) {
      p++;
    } else {
      if (!status) break; // data byte without any running status: corrupt
      s = status;
    }

    if (s === 0xff) {
      if (p >= end) break;
      const type = b[p++];
      const len = readVlq();
      if (len < 0 || p + len > end) break;
      const data = b.subarray(p, p + len);
      p += len;
      if (type === 0x2f) {
        endTick = tick;
        break;
      } else if (type === 0x51 && len >= 3) {
        const us = (data[0] << 16) | (data[1] << 8) | data[2];
        if (us > 0) tempos.push({ tick, us });
      } else if (type === 0x58 && len >= 2) {
        const num = data[0];
        const den = Math.pow(2, data[1]);
        if (num >= 1 && den >= 1 && den <= 128) sigs.push({ tick, num, den });
      } else if (type === 0x03 && !nameBytes) {
        nameBytes = data;
      } else if (type === 0x04 && !instBytes) {
        instBytes = data;
      }
      continue;
    }
    if (s === 0xf0 || s === 0xf7) {
      const len = readVlq();
      if (len < 0) break;
      p += len;
      continue;
    }
    if (s > 0xf0) {
      // System common/real-time bytes are not valid in files; skip their data defensively.
      p += s === 0xf2 ? 2 : s === 0xf1 || s === 0xf3 ? 1 : 0;
      continue;
    }

    status = s;
    const kind = s & 0xf0;
    const ch = s & 0x0f;
    const need = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
    if (p + need > end) break;
    const d1 = b[p] & 0x7f;
    const d2 = need === 2 ? b[p + 1] & 0x7f : 0;
    p += need;

    if (kind === 0x90 && d2 > 0) {
      const key = ch * 128 + d1;
      let q = open.get(key);
      if (!q) open.set(key, (q = []));
      q.push({ tick, vel: d2 });
    } else if (kind === 0x80 || kind === 0x90) {
      const q = open.get(ch * 128 + d1);
      const on = q && q.shift();
      if (on) notes.push({ s: on.tick, e: tick, m: d1, vel: on.vel, ch });
    } else if (kind === 0xc0 && !programs.has(ch)) {
      programs.set(ch, d1);
    }
  }

  if (endTick < tick) endTick = tick;
  for (const [key, q] of open) {
    for (const on of q) notes.push({ s: on.tick, e: endTick, m: key % 128, vel: on.vel, ch: Math.floor(key / 128) });
  }
  const name = cleanName(decodeText(nameBytes)) || cleanName(decodeText(instBytes));
  return { name, notes, tempos, sigs, programs, endTick };
}

// Piecewise-linear tick → seconds map. Later events at the same tick override earlier ones.
function buildTempoMap(tempoEvents, tpb) {
  const sorted = tempoEvents.slice().sort((a, b) => a.tick - b.tick);
  const segs = [{ tick: 0, us: DEFAULT_US_PER_BEAT, sec: 0 }];
  for (const ev of sorted) {
    const last = segs[segs.length - 1];
    if (ev.tick === last.tick) {
      last.us = ev.us;
    } else {
      segs.push({ tick: ev.tick, us: ev.us, sec: last.sec + ((ev.tick - last.tick) * last.us) / 1e6 / tpb });
    }
  }
  const toSec = (tick) => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    const sg = segs[lo];
    return sg.sec + ((tick - sg.tick) * sg.us) / 1e6 / tpb;
  };
  const firstUs = sorted.length ? segs.find((sg) => sg.tick === sorted[0].tick).us : null;
  return { toSec, firstUs };
}

function toNotes(raw, toSec) {
  const notes = raw.map((n) => {
    const t = toSec(n.s);
    let d = toSec(n.e) - t;
    if (!(d >= 0.005)) d = MIN_NOTE_D;
    return { t: r3(t), d: Math.max(0.001, r3(d)), m: n.m, v: r3(n.vel / 127) };
  });
  notes.sort((a, b) => a.t - b.t || a.m - b.m);
  return notes;
}

function mostCommonChannel(raw) {
  const counts = new Array(16).fill(0);
  for (const n of raw) counts[n.ch]++;
  let best = 0;
  for (let c = 1; c < 16; c++) if (counts[c] > counts[best]) best = c;
  return best;
}

/**
 * Parses an SMF. Channels are reported 1-based (1..16); isDrum = channel 10.
 * Only tracks containing notes are returned; `index` is the position in `tracks`, `sourceIndex` the MTrk chunk number.
 */
export function parseMidi(arrayBufferOrUint8Array) {
  const b = toBytes(arrayBufferOrUint8Array);
  const h = findHeader(b);
  if (h < 0) throw new Error(ERR_NOT_MIDI);
  const hlen = u32(b, h + 4);
  if (hlen < 6 || h + 8 + hlen > b.length) throw new Error(ERR_NOT_MIDI);
  let format = u16(b, h + 8);
  const division = u16(b, h + 12);
  if (division & 0x8000) throw new Error(ERR_SMPTE);
  if (division === 0) throw new Error(ERR_NOT_MIDI);
  if (format > 2) format = 1;
  const tpb = division;

  const rawTracks = [];
  let pos = h + 8 + hlen;
  while (pos + 8 <= b.length) {
    const type = str4(b, pos);
    const len = u32(b, pos + 4);
    const start = pos + 8;
    const end = Math.min(start + len, b.length);
    if (type === 'MTrk') rawTracks.push(parseTrack(b, start, end));
    pos = start + len;
  }

  const allTempos = [];
  const allSigs = [];
  for (const tr of rawTracks) {
    allTempos.push(...tr.tempos);
    allSigs.push(...tr.sigs);
  }

  const globalMap = buildTempoMap(allTempos, tpb);
  const mapFor = (i) => (format === 2 ? buildTempoMap(rawTracks[i].tempos, tpb) : globalMap);

  let firstUs = globalMap.firstUs;
  if (format === 2) {
    const tr = rawTracks.find((x) => x.tempos.length);
    firstUs = tr ? buildTempoMap(tr.tempos, tpb).firstUs : null;
  }
  const bpm = firstUs ? Math.round((60e6 / firstUs) * 100) / 100 : 120;
  allSigs.sort((a, b2) => a.tick - b2.tick);
  const timeSignature = allSigs.length ? { num: allSigs[0].num, den: allSigs[0].den } : { num: 4, den: 4 };

  const tracks = [];
  let duration = 0;
  let trackEndMax = 0;
  rawTracks.forEach((tr, i) => {
    const { toSec } = mapFor(i);
    trackEndMax = Math.max(trackEndMax, toSec(tr.endTick));
    if (!tr.notes.length) return;
    const channels = [...new Set(tr.notes.map((n) => n.ch))].sort((a, c) => a - c);
    const groups = format === 0 && channels.length > 1
      ? channels.map((ch) => ({ ch, raw: tr.notes.filter((n) => n.ch === ch), name: `Channel ${ch + 1}` }))
      : [{ ch: mostCommonChannel(tr.notes), raw: tr.notes, name: tr.name || `트랙 ${i + 1}` }];
    for (const g of groups) {
      const notes = toNotes(g.raw, toSec);
      for (const n of notes) if (n.t + n.d > duration) duration = n.t + n.d;
      tracks.push({
        index: tracks.length,
        sourceIndex: i,
        name: g.name,
        channel: g.ch + 1,
        program: tr.programs.has(g.ch) ? tr.programs.get(g.ch) : 0,
        isDrum: g.ch === 9,
        notes,
      });
    }
  });
  if (!tracks.length) duration = trackEndMax;

  return { format, ticksPerBeat: tpb, bpm, timeSignature, duration: r3(duration), tracks };
}

/** Skyline melody: keep the highest note of each onset group, then trim overlaps to make it monophonic. */
export function extractMelody(notes, { eps = 0.03 } = {}) {
  const tol = (Number.isFinite(eps) && eps >= 0 ? eps : 0.03) + 1e-9;
  const src = (Array.isArray(notes) ? notes : [])
    .filter((n) => n && Number.isFinite(n.t) && Number.isFinite(n.m))
    .slice()
    .sort((a, b) => a.t - b.t || b.m - a.m);
  const picked = [];
  let groupT = -Infinity;
  for (const n of src) {
    const d = Number.isFinite(n.d) && n.d > 0 ? n.d : MIN_NOTE_D;
    const copy = { ...n, d };
    if (picked.length && n.t - groupT <= tol) {
      const cur = picked[picked.length - 1];
      if (copy.m > cur.m || (copy.m === cur.m && copy.d > cur.d)) picked[picked.length - 1] = copy;
    } else {
      picked.push(copy);
      groupT = n.t;
    }
  }
  for (let i = 0; i < picked.length - 1; i++) {
    const a = picked[i];
    const next = picked[i + 1];
    if (a.t + a.d > next.t) a.d = Math.max(MIN_NOTE_D, next.t - a.t);
  }
  for (const n of picked) {
    n.t = r3(n.t);
    n.d = Math.max(0.001, r3(n.d));
  }
  return picked;
}

export function midiTracksSummary(parsed) {
  const tracks = parsed && Array.isArray(parsed.tracks) ? parsed.tracks : [];
  return tracks.map((tr) => {
    let min = null;
    let max = null;
    for (const n of tr.notes) {
      if (min === null || n.m < min) min = n.m;
      if (max === null || n.m > max) max = n.m;
    }
    return { index: tr.index, name: tr.name, count: tr.notes.length, min, max, channel: tr.channel, isDrum: tr.isDrum };
  });
}
