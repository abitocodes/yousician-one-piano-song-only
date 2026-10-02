// Song model: creation, validation/normalization of imported JSON, and note transforms.

import { assignLyrics } from './lyrics.js';

export const SONG_FORMAT = 'piano-karaoke-song';
export const SONG_VERSION = 1;

const ERR_FORMAT = '곡 파일 형식이 올바르지 않아요.';
const DEFAULT_BPM = 100;
const DEFAULT_D = 0.1;
const MIN_LYRIC_D = 0.05;

const r3 = (x) => Math.round(x * 1000) / 1000;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const num = (x) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : NaN);

function makeId() {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return 'song-' + Date.now().toString(36) + rand;
}

function str(x, fallback, max = 500) {
  if (typeof x === 'number' && Number.isFinite(x)) x = String(x);
  if (typeof x !== 'string') return fallback;
  const s = x.trim();
  return s ? s.slice(0, max) : fallback;
}

function byTimeThenPitch(a, b) {
  return a.t - b.t || a.m - b.m;
}

function normalizeNote(n) {
  if (!isObj(n)) return null;
  const t = num(n.t);
  const m = num(n.m);
  if (!Number.isFinite(t) || !Number.isFinite(m)) return null;
  const mi = Math.round(m);
  if (mi < 0 || mi > 127) return null;
  let d = num(n.d);
  if (!Number.isFinite(d) || d <= 0) d = DEFAULT_D;
  const note = { t: r3(t), d: Math.max(0.001, r3(d)), m: mi };
  const v = num(n.v);
  if (Number.isFinite(v)) note.v = r3(clamp(v, 0, 1));
  return note;
}

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  const out = [];
  for (const line of lines) {
    const src = isObj(line) && Array.isArray(line.syllables) ? line.syllables : null;
    if (!src) continue;
    const syllables = [];
    for (const s of src) {
      if (!isObj(s)) continue;
      const t = num(s.t);
      if (!Number.isFinite(t)) continue;
      let d = num(s.d);
      if (!Number.isFinite(d) || d <= 0) d = MIN_LYRIC_D;
      const text = typeof s.text === 'string' ? s.text : s.text == null ? '' : String(s.text);
      syllables.push({ text, t: r3(t), d: Math.max(0.001, r3(d)) });
    }
    if (syllables.length) out.push({ syllables });
  }
  return out;
}

function normalizeLyrics(raw) {
  if (typeof raw === 'string') return { text: raw, source: 'notes', lines: [] };
  if (!isObj(raw)) return { text: '', source: 'notes', lines: [] };
  return {
    text: typeof raw.text === 'string' ? raw.text : '',
    source: raw.source === 'lrc' ? 'lrc' : 'notes',
    lines: normalizeLines(raw.lines),
  };
}

function normalizeAudio(raw) {
  if (!isObj(raw)) return null;
  const offset = num(raw.offset);
  const volume = num(raw.volume);
  return {
    name: str(raw.name, '반주 음원', 200),
    offset: Number.isFinite(offset) ? r3(offset) : 0,
    volume: Number.isFinite(volume) ? clamp(volume, 0, 1) : 1,
  };
}

/** Validates/coerces any parsed JSON into a Song. Throws (Korean message) on unusable input. */
export function normalizeSong(raw) {
  if (!isObj(raw) || !Array.isArray(raw.notes)) throw new Error(ERR_FORMAT);
  if (raw.format !== undefined && raw.format !== SONG_FORMAT) throw new Error(ERR_FORMAT);

  const notes = [];
  for (const n of raw.notes) {
    const note = normalizeNote(n);
    if (note) notes.push(note);
  }
  notes.sort(byTimeThenPitch);

  const bpm = num(raw.bpm);
  const bpb = num(raw.beatsPerBar);
  const offset = num(raw.offset);
  const now = Date.now();
  const createdAt = num(raw.createdAt);
  const updatedAt = num(raw.updatedAt);

  const song = {
    format: SONG_FORMAT,
    version: SONG_VERSION,
    id: str(raw.id, '', 200) || makeId(),
    title: str(raw.title, '제목 없음', 200),
    artist: str(raw.artist, '', 200),
    description: typeof raw.description === 'string' ? raw.description.slice(0, 2000) : '',
    bpm: Number.isFinite(bpm) && bpm > 0 ? r3(clamp(bpm, 30, 300)) : DEFAULT_BPM,
    beatsPerBar: Number.isFinite(bpb) && bpb >= 1 ? clamp(Math.round(bpb), 1, 16) : 4,
    offset: Number.isFinite(offset) ? r3(offset) : 0,
    notes,
    lyrics: normalizeLyrics(raw.lyrics),
    audio: normalizeAudio(raw.audio),
    createdAt: Number.isFinite(createdAt) && createdAt >= 0 ? createdAt : now,
    updatedAt: Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : now,
  };
  if (typeof raw.builtin === 'boolean') song.builtin = raw.builtin;
  if (typeof raw.template === 'boolean') song.template = raw.template;
  // Hand-written/imported files may carry lyric text without computed timing.
  const ly = song.lyrics;
  if (ly.source === 'notes' && !ly.lines.length && ly.text.trim() && notes.length) {
    ly.lines = assignLyrics(ly.text, notes).lines;
  }
  return song;
}

export function createSong(partial = {}) {
  const p = {};
  if (isObj(partial)) {
    for (const [k, v] of Object.entries(partial)) if (v !== undefined) p[k] = v;
  }
  const now = Date.now();
  return normalizeSong({
    title: '새 곡',
    createdAt: now,
    updatedAt: now,
    ...p,
    format: SONG_FORMAT,
    notes: Array.isArray(p.notes) ? p.notes : [],
  });
}

export function songDuration(song) {
  let end = 0;
  if (!song) return 0;
  for (const n of Array.isArray(song.notes) ? song.notes : []) {
    const e = n.t + n.d;
    if (Number.isFinite(e) && e > end) end = e;
  }
  const lines = song.lyrics && Array.isArray(song.lyrics.lines) ? song.lyrics.lines : [];
  for (const line of lines) {
    for (const s of (line && line.syllables) || []) {
      const e = s.t + s.d;
      if (Number.isFinite(e) && e > end) end = e;
    }
  }
  return end;
}

export function noteRange(notes) {
  if (!Array.isArray(notes) || !notes.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const n of notes) {
    if (!n || !Number.isFinite(n.m)) continue;
    if (n.m < min) min = n.m;
    if (n.m > max) max = n.m;
  }
  return min === Infinity ? null : { min, max };
}

export function isPlayable(song) {
  return Boolean(song) && Array.isArray(song.notes) && song.notes.length > 0;
}

export function transposeNotes(notes, semis) {
  const s = Number.isFinite(semis) ? Math.round(semis) : 0;
  return (notes || []).map((n) => ({ ...n, m: clamp(Math.round(n.m + s), 21, 108) }));
}

// Shifts by `sec`; notes ending at/before 0 are dropped, notes straddling 0 are cut to start at 0.
export function shiftNotes(notes, sec) {
  const s = Number.isFinite(sec) ? sec : 0;
  const out = [];
  for (const n of notes || []) {
    const end = n.t + n.d + s;
    if (!(end > 0)) continue;
    const t = Math.max(0, n.t + s);
    const d = r3(end - t);
    if (d < 0.001) continue;
    out.push({ ...n, t: r3(t), d });
  }
  out.sort(byTimeThenPitch);
  return out;
}

// Snaps starts and ends to a grid of (60/bpm)/division seconds anchored at `offset`; min length one grid step.
// Notes of the same pitch that collapse onto the same start are merged (the longer one wins).
export function quantizeNotes(notes, bpm, offset, division) {
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM;
  const off = Number.isFinite(offset) ? offset : 0;
  const div = Number.isFinite(division) && division > 0 ? division : 2;
  const grid = 60 / tempo / div;
  const snap = (x) => off + Math.round((x - off) / grid) * grid;
  const out = [];
  const seen = new Map();
  for (const n of notes || []) {
    const t = snap(n.t);
    const end = snap(n.t + n.d);
    const q = { ...n, t: r3(t), d: r3(Math.max(grid, end - t)) };
    const key = `${q.t}|${q.m}`;
    const prev = seen.get(key);
    if (prev) {
      if (q.d > prev.d) prev.d = q.d;
      continue;
    }
    seen.set(key, q);
    out.push(q);
  }
  out.sort(byTimeThenPitch);
  return out;
}

export function serializeSong(song) {
  return JSON.stringify(song, null, 2);
}

export function cloneSong(song) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(song);
    } catch {
      // fall through to JSON (e.g. objects holding functions)
    }
  }
  return JSON.parse(JSON.stringify(song));
}
