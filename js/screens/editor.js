// 곡 편집 화면: 멜로디(노트)·가사·반주 음원을 만들고 저장한다.
import {
  createSong, normalizeSong, transposeNotes, shiftNotes, quantizeNotes, serializeSong, cloneSong,
  noteRange, songDuration, isPlayable,
} from '../core/song.js';
import { parseMidi, extractMelody, midiTracksSummary } from '../core/midi.js';
import { parseNotation, notesToNotation } from '../core/notation.js';
import {
  assignLyrics, solfegeLyricText, parseLRC, toLRC, lyricsPlainText, lineStart, parseLyricText, groupNoteEvents,
} from '../core/lyrics.js';
import { noteName, isBlackKey } from '../core/notes.js';
import { unlockAudio, audioNow, getAudioContext } from '../audio/engine.js';
import { Synth } from '../audio/synth.js';
import { confirmDialog, modal, downloadFile, pickFile, syncRange } from '../ui/dom.js';
import { micErrorMessage } from './calibrate.js';

const RECOVERY_KEY = 'pk.editorRecovery';
const UNDO_LIMIT = 40;
const BEATS_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 9, 12];
const ZOOMS = [1, 2, 4, 8];
const MAX_REC_SEC = 900;
const NUDGE_SEC = 0.05;
const LRC_STAMP_RE = /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/;
const MELODY_NAME_RE = /melody|vocal|voice|lead|sing|solo|멜로디|보컬|노래|주선율|가창/i;

// 악보 파일 가져오기: 안드로이드는 모르는 확장자를 회색으로 막는 경우가 많아 */*까지 허용하고 내용으로 판별한다.
const SCORE_ACCEPT = [
  '.mid', '.midi', '.kar', '.musicxml', '.xml', '.mxl',
  'audio/midi', 'audio/x-midi', 'audio/mid',
  'application/vnd.recordare.musicxml+xml', 'application/vnd.recordare.musicxml',
  'application/xml', 'text/xml', 'application/zip', '*/*',
].join(',');
const MAX_MIDI_BYTES = 8 * 1024 * 1024;
const MAX_SCORE_BYTES = 40 * 1024 * 1024;
const MIDI_EXT_RE = /\.(mid|midi|kar|rmi)$/i;
const SCORE_EXT_RE = /\.(musicxml|xml|mxl)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i;

// 악보 보고 입력(스텝 입력): 한 박 = 48틱. 점(×1.5)·셋잇단(×2/3)을 곱해도 틱이 정수로 떨어진다.
export const STEP_TPB = 48;
export const STEP_VALUES = [
  { value: 4, label: '온음표', short: '온' },
  { value: 2, label: '2분음표', short: '2분' },
  { value: 1, label: '4분음표', short: '4분' },
  { value: 0.5, label: '8분음표', short: '8분' },
  { value: 0.25, label: '16분음표', short: '16분' },
];
const STEP_MAX_ENTRIES = 4000;
const STEP_RESUME_GRID = 4; // 이어서 입력할 때 시작 위치를 1/12박(4틱) 격자에 맞춘다

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 녹음/텍스트 입력의 기준 시각: 첫 박(offset). 음수면 0 이상인 첫 마디 경계. */
export function gridStart(offset, bpm, beatsPerBar) {
  const off = Number.isFinite(offset) ? offset : 0;
  if (off >= 0) return round3(off);
  const bar = (60 / (bpm > 0 ? bpm : 100)) * (beatsPerBar > 0 ? beatsPerBar : 4);
  return round3(off + Math.ceil(-off / bar - 1e-9) * bar);
}

/** 기존 노트 뒤에 이어 붙일 시각: 마지막 노트가 끝난 뒤의 첫 마디 경계. */
export function appendStartTime(notes, { bpm = 100, beatsPerBar = 4, offset = 0 } = {}) {
  if (!notes || !notes.length) return gridStart(offset, bpm, beatsPerBar);
  const bar = (60 / (bpm > 0 ? bpm : 100)) * (beatsPerBar > 0 ? beatsPerBar : 4);
  let end = 0;
  for (const n of notes) end = Math.max(end, n.t + n.d);
  const off = Number.isFinite(offset) ? offset : 0;
  const k = Math.ceil((end - off) / bar - 1e-6);
  return Math.max(0, round3(off + k * bar));
}

/**
 * 마이크로 감지한 NoteEvent들 → Note[] (녹음 시작 = 0초).
 * t = time − latency − start, 30 ms 안의 동시 타건은 가장 센 음 하나만, d = min(다음 음까지, 2 s), 마지막 음은 1박.
 */
export function recordedEventsToNotes(events, { start = 0, latency = 0, bpm = 100, mergeWindow = 0.03, maxDur = 2 } = {}) {
  const evs = [];
  for (const e of events || []) {
    if (!e || !Number.isFinite(e.time) || !Number.isFinite(e.midi)) continue;
    const m = Math.round(e.midi);
    if (m < 21 || m > 108) continue;
    const t = e.time - latency - start;
    if (t < -0.25) continue;
    evs.push({ t: Math.max(0, t), m, s: Number.isFinite(e.strength) ? e.strength : 0 });
  }
  evs.sort((a, b) => a.t - b.t);
  const groups = [];
  for (const e of evs) {
    const g = groups[groups.length - 1];
    if (g && e.t - g.t <= mergeWindow) {
      if (e.s > g.best.s) g.best = e;
    } else {
      groups.push({ t: e.t, best: e });
    }
  }
  const beat = 60 / (bpm > 0 ? bpm : 100);
  const notes = groups.map((g) => ({
    t: round3(g.t), d: 0, m: g.best.m, v: round3(clamp(0.35 + 0.65 * g.best.s, 0.1, 1)),
  }));
  for (let i = 0; i < notes.length; i++) {
    const next = notes[i + 1];
    const d = next ? Math.min(next.t - notes[i].t, maxDur) : beat;
    notes[i].d = Math.max(0.05, round3(d));
  }
  return notes;
}

/** MIDI 트랙 요약 → 멜로디일 가능성이 가장 높은 트랙 index (없으면 −1). */
export function recommendMelodyTrack(tracks) {
  const list = (tracks || []).filter((t) => t && t.count > 0);
  const cands = list.filter((t) => !t.isDrum);
  if (!cands.length) return list.length ? list[0].index : -1;
  const named = cands.find((t) => MELODY_NAME_RE.test(t.name || ''));
  if (named) return named.index;
  const maxCount = Math.max(...cands.map((t) => t.count));
  const pool = cands.filter((t) => t.count >= Math.max(8, maxCount * 0.15));
  const ranked = (pool.length ? pool : cands).slice()
    .sort((a, b) => ((b.min + b.max) - (a.min + a.max)) || (b.count - a.count));
  return ranked[0].index;
}

export function validateBasics({ title, bpm, beatsPerBar, offset } = {}) {
  const errors = {};
  if (!String(title == null ? '' : title).trim()) errors.title = '제목을 입력해 주세요.';
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) errors.bpm = 'BPM은 30~300 사이로 입력해 주세요.';
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 16) errors.beatsPerBar = '박자는 1~16 사이여야 해요.';
  if (!Number.isFinite(offset) || Math.abs(offset) > 3600) errors.offset = '첫 박 위치를 초 단위 숫자로 입력해 주세요.';
  return errors;
}

/** 붙여넣은 가사가 LRC(시간 표시) 형식인지. */
export function looksLikeLrc(text) {
  let n = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (LRC_STAMP_RE.test(line) && ++n >= 2) return true;
  }
  return false;
}

function mapLyricTimes(lyrics, fn) {
  return {
    ...lyrics,
    lines: (lyrics.lines || []).map((line) => ({
      syllables: line.syllables.map((y) => ({ ...y, ...fn(y) })),
    })),
  };
}

/** BPM을 바꾸면서 노트·첫 박·LRC 가사 시간을 같은 비율로 늘이거나 줄인다. */
export function scaleTempo(song, newBpm) {
  const f = song.bpm / newBpm;
  return {
    bpm: newBpm,
    offset: round3((song.offset || 0) * f),
    notes: song.notes.map((n) => ({ ...n, t: round3(n.t * f), d: Math.max(0.01, round3(n.d * f)) })),
    lyrics: song.lyrics && song.lyrics.source === 'lrc'
      ? mapLyricTimes(song.lyrics, (y) => ({ t: round3(y.t * f), d: Math.max(0.01, round3(y.d * f)) }))
      : song.lyrics,
  };
}

/** 첫 노트가 0초가 되도록 전체(노트·첫 박·음원 오프셋·LRC 가사)를 함께 당긴다. 이미 0이면 null. */
export function trimLeadingSilence(song) {
  const notes = song.notes || [];
  if (!notes.length) return null;
  let first = Infinity;
  for (const n of notes) first = Math.min(first, n.t);
  if (!(first > 0.0005)) return null;
  const sh = -first;
  return {
    shift: sh,
    notes: shiftNotes(notes, sh),
    offset: round3((song.offset || 0) + sh),
    audio: song.audio ? { ...song.audio, offset: round3((song.audio.offset || 0) + sh) } : song.audio,
    lyrics: song.lyrics && song.lyrics.source === 'lrc'
      ? mapLyricTimes(song.lyrics, (y) => ({ t: round3(Math.max(0, y.t + sh)) }))
      : song.lyrics,
  };
}

// --- 악보 파일 판별 -----------------------------------------------------------

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(0);
}

/**
 * 파일 내용(앞부분 바이트)과 이름으로 종류를 판별한다. 내용이 확장자보다 우선한다.
 * → 'midi' | 'musicxml' | 'pdf' | 'image' | 'json' | null
 * MIDI: 'MThd' 또는 RIFF/RMID. MusicXML: 'PK' 압축(.mxl) 또는 '<'로 시작하는 XML(BOM·UTF-16·공백 허용).
 */
export function detectScoreFileKind(data, name = '') {
  const b = asBytes(data);
  const has = (at, sig) => {
    if (b.length < at + sig.length) return false;
    for (let k = 0; k < sig.length; k++) if (b[at + k] !== sig.charCodeAt(k)) return false;
    return true;
  };
  if (has(0, 'MThd')) return 'midi';
  if (has(0, 'RIFF')) {
    if (has(8, 'RMID')) return 'midi';
    if (has(8, 'WEBP')) return 'image';
    return null; // WAV 같은 다른 RIFF 파일
  }
  if (has(0, 'PK\x03\x04') || has(0, 'PK\x05\x06')) return 'musicxml';
  if (has(0, '%PDF')) return 'pdf';
  if (has(0, '\x89PNG') || (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || has(0, 'GIF8')
    || has(4, 'ftypheic') || has(4, 'ftypheix') || has(4, 'ftypmif1')) return 'image';

  const fileName = String(name || '').trim();
  let i = 0;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  else if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) i = 2;
  const limit = Math.min(b.length, i + 1024);
  for (; i < limit; i++) {
    const c = b[i];
    if (c === 0x00 || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c === 0x3c) return 'musicxml'; // '<'
    if (c === 0x7b || (c === 0x5b && /\.json$/i.test(fileName))) return 'json'; // '{' / '['
    break;
  }

  if (MIDI_EXT_RE.test(fileName)) return 'midi';
  if (SCORE_EXT_RE.test(fileName)) return 'musicxml';
  if (/\.pdf$/i.test(fileName)) return 'pdf';
  if (IMAGE_EXT_RE.test(fileName)) return 'image';
  if (/\.json$/i.test(fileName)) return 'json';
  return null;
}

// --- 악보 보고 입력 (스텝 입력) ----------------------------------------------------
// 입력 항목: { kind: 'note', m, ticks } | { kind: 'rest', ticks } | { kind: 'tie', ticks } (tie = 앞 음 늘이기)

/** 음표 길이(박) × 점(1.5) × 셋잇단(2/3) → 틱 (정수). */
export function stepTicks(value, { dotted = false, triplet = false } = {}) {
  const v = Number(value);
  if (!(v > 0)) return 0;
  return Math.round(v * STEP_TPB * (dotted ? 1.5 : 1) * (triplet ? 2 / 3 : 1));
}

/** 음표 길이(박) × 점 × 셋잇단 → 박. */
export function stepValueBeats(value, opts = {}) {
  return stepTicks(value, opts) / STEP_TPB;
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

/** 박 수 표기: 2 → '2', 1.5 → '1.5', 0.25 → '1/4', 2/3 → '2/3' (텍스트 입력 문법으로 다시 읽을 수 있다). */
export function formatStepBeats(beats) {
  if (!Number.isFinite(beats)) return '0';
  if (Math.abs(beats - Math.round(beats)) < 1e-9) return String(Math.round(beats));
  if (Math.abs(beats * 2 - Math.round(beats * 2)) < 1e-9) return String(Math.round(beats * 2) / 2);
  for (const den of [4, 3, 6, 8, 12, 16, 24, 48]) {
    const num = Math.round(beats * den);
    if (Math.abs(beats * den - num) < 1e-9) {
      const g = gcd(num, den);
      return `${num / g}/${den / g}`;
    }
  }
  return String(round3(beats));
}

/** 커서 위치(박, 0부터) → { bar, beat, text: '마디 M · 박 B' } (마디·박은 1부터). */
export function stepCursor(beat, beatsPerBar = 4) {
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4;
  const b = Number.isFinite(beat) && beat > 0 ? beat : 0;
  const bar = Math.floor(b / bpb + 1e-6);
  let inBar = b - bar * bpb;
  if (inBar < 1e-6) inBar = 0;
  const beatNo = Math.round((1 + inBar) * 100) / 100;
  return { bar: bar + 1, beat: beatNo, text: `마디 ${bar + 1} · 박 ${beatNo}` };
}

export function stepTotalTicks(entries) {
  let sum = 0;
  for (const e of entries || []) sum += e && e.ticks > 0 ? e.ticks : 0;
  return sum;
}

/** 이음줄(앞 음 늘이기)은 바로 앞이 음(또는 이미 늘인 음)일 때만 쓸 수 있다. */
export function stepCanTie(entries) {
  const last = entries && entries.length ? entries[entries.length - 1] : null;
  return Boolean(last) && (last.kind === 'note' || last.kind === 'tie');
}

export function stepNoteCount(entries) {
  let n = 0;
  for (const e of entries || []) if (e && e.kind === 'note') n++;
  return n;
}

/** 이음줄을 앞 음에 합친 음 목록: [{ m, tick, ticks }] (tick = startTick부터의 위치). 쉼표는 { rest: true }. */
function stepItems(entries, startTick = 0) {
  const items = [];
  let pos = startTick;
  let last = null;
  for (const e of entries || []) {
    if (!e || !(e.ticks > 0)) continue;
    if (e.kind === 'note') {
      last = { m: e.m, tick: pos, ticks: e.ticks };
      items.push(last);
    } else if (e.kind === 'tie') {
      if (last) last.ticks += e.ticks;
    } else {
      last = null;
      items.push({ rest: true, tick: pos, ticks: e.ticks });
    }
    pos += e.ticks;
  }
  return items;
}

/** 입력 항목 → Note[] (초). origin = 박 격자의 0박 시각, startTick = 입력을 시작한 위치. */
export function stepEntriesToNotes(entries, { bpm = 100, origin = 0, startTick = 0, velocity = 0.8 } = {}) {
  const spt = 60 / (bpm > 0 ? bpm : 100) / STEP_TPB;
  const base = Number.isFinite(origin) ? origin : 0;
  return stepItems(entries, startTick)
    .filter((it) => !it.rest)
    .map((it) => ({ t: round3(base + it.tick * spt), d: Math.max(0.01, round3(it.ticks * spt)), m: it.m, v: velocity }));
}

/** 입력 항목 → 텍스트 입력 문법 ('도4 레4:1/2 R | 미4:2'). 마디 경계에서 시작하는 항목 앞에 ' | '. */
export function stepEntriesText(entries, { beatsPerBar = 4, startTick = 0 } = {}) {
  const barTicks = (beatsPerBar > 0 ? beatsPerBar : 4) * STEP_TPB;
  let out = '';
  for (const it of stepItems(entries, startTick)) {
    const name = it.rest ? 'R' : noteName(it.m, 'solfege-octave');
    const beats = it.ticks / STEP_TPB;
    const tok = beats === 1 ? name : `${name}:${formatStepBeats(beats)}`;
    if (out) out += it.tick % barTicks === 0 ? ' | ' : ' ';
    out += tok;
  }
  return out;
}

/**
 * 기존 노트 바로 뒤에서 이어 입력할 위치(틱, origin 기준). 1/12박 격자로 올림.
 * 노트 시간은 1 ms 단위로 반올림돼 저장되므로 격자에서 2 ms 안쪽이면 그 격자로 본다.
 */
export function stepResumeTick(notes, { bpm = 100, origin = 0 } = {}) {
  if (!notes || !notes.length) return 0;
  let end = -Infinity;
  for (const n of notes) if (Number.isFinite(n.t) && Number.isFinite(n.d)) end = Math.max(end, n.t + n.d);
  if (!Number.isFinite(end)) return 0;
  const secPerGrid = (60 / (bpm > 0 ? bpm : 100) / STEP_TPB) * STEP_RESUME_GRID;
  const g = (end - (Number.isFinite(origin) ? origin : 0)) / secPerGrid;
  const near = Math.round(g);
  const k = Math.abs(g - near) * secPerGrid <= 0.002 ? near : Math.ceil(g);
  return Math.max(0, k * STEP_RESUME_GRID);
}

/**
 * 가사 텍스트에서 index번째 노트 이벤트부터 count개 토큰의 표시 글자.
 * 음절 → 글자, '~'(앞 글자 늘임) → '~', '_'(건너뛰기) → '_'. 가사가 모자라면 그만큼 짧다.
 */
export function lyricTokensAt(text, index, count = 4) {
  const out = [];
  if (!String(text || '').trim() || !(count > 0)) return out;
  let k = 0;
  for (const line of parseLyricText(String(text))) {
    for (const tk of line.tokens) {
      if (k++ < index) continue;
      out.push(tk.type === 'syl' ? tk.text.trim() : tk.type === 'ext' ? '~' : '_');
      if (out.length >= count) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small DOM / format helpers
// ---------------------------------------------------------------------------

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  let value;
  let checked;
  if (props) {
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v == null || v === false) continue;
      if (key === 'class') node.className = v;
      else if (key === 'text') node.textContent = v;
      else if (key === 'style') node.style.cssText = v;
      else if (key === 'dataset') Object.assign(node.dataset, v);
      else if (key === 'value') value = v;
      else if (key === 'checked') checked = v;
      else if (key.startsWith('on') && typeof v === 'function') node.addEventListener(key.slice(2).toLowerCase(), v);
      else if (key === 'disabled' || key === 'hidden' || key === 'readOnly' || key === 'open') node[key] = Boolean(v);
      else node.setAttribute(key, v === true ? '' : String(v));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  if (value !== undefined) node.value = String(value);
  if (checked !== undefined) node.checked = Boolean(checked);
  return node;
}

/** replaceChildren that skips null/false (conditional children). */
function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

function btn(label, onClick, cls = '', extra = {}) {
  return el('button', { class: `btn ${cls}`.trim(), type: 'button', onClick, ...extra }, label);
}

function checkbox(checked, onChange) {
  return el('input', { type: 'checkbox', checked, onChange: (e) => onChange(Boolean(e.target.checked)) });
}

function seg(options, value, onChange, label) {
  const root = el('div', { class: 'seg small ed-seg', role: 'radiogroup', 'aria-label': label || null });
  const set = (v) => {
    for (const b of root.children) {
      const on = b.dataset.value === String(v);
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  };
  for (const o of options) {
    root.append(el('button', {
      type: 'button', role: 'radio', dataset: { value: String(o.value) },
      onClick: () => { set(o.value); onChange(o.value); },
    }, o.label));
  }
  set(value);
  root.setValue = set;
  return root;
}

function parseNum(str) {
  const t = String(str == null ? '' : str).trim().replace(',', '.');
  return t === '' ? NaN : Number(t);
}

function fmtClock(sec, dec = 0) {
  if (!Number.isFinite(sec)) return '-';
  const p = 10 ** dec;
  const neg = sec < 0;
  const v = Math.round(Math.abs(sec) * p) / p;
  const m = Math.floor(v / 60);
  const r = v - m * 60;
  const [ip, fp] = r.toFixed(dec).split('.');
  return `${neg ? '-' : ''}${m}:${ip.padStart(2, '0')}${fp ? `.${fp}` : ''}`;
}

function fmtSec(v) {
  const r = Math.round(v * 100) / 100;
  return `${r > 0 ? '+' : ''}${r.toFixed(2)}초`;
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function fmtDate(ms) {
  try {
    return new Date(ms).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function noteLabel(m) {
  return `${noteName(m, 'solfege-octave')} (${noteName(m, 'en')})`;
}

function rangeText(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '-';
  return min === max ? noteName(min, 'en') : `${noteName(min, 'en')}–${noteName(max, 'en')}`;
}

function fileBase(title) {
  const base = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 60);
  return base || 'song';
}

function sortNotes(notes) {
  return notes.sort((a, b) => a.t - b.t || a.m - b.m);
}

function copyNotes(notes) {
  return notes.map((n) => ({ ...n }));
}

function copyLyrics(lyrics) {
  return JSON.parse(JSON.stringify(lyrics || { text: '', source: 'notes', lines: [] }));
}

// ---------------------------------------------------------------------------
// Recovery (unsaved draft survives tab kills / accidental navigation)
// ---------------------------------------------------------------------------

function readRecovery() {
  try {
    const raw = localStorage.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && v.draft && typeof v.draft === 'object' ? v : null;
  } catch {
    return null;
  }
}

function writeRecovery(s) {
  if (!s.draft) return;
  try {
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({
      id: s.draft.id, isNew: !s.stored, savedAt: Date.now(), draft: s.draft,
    }));
  } catch {
    // 저장 공간 부족·사생활 보호 모드: 복구 기능만 포기
  }
}

function clearRecovery() {
  try {
    localStorage.removeItem(RECOVERY_KEY);
  } catch {
    // ignore
  }
}

function newSong() {
  const song = createSong({ artist: '' });
  song.title = '';
  return song;
}

/** normalizeSong + 빈 제목 유지 (normalizeSong은 빈 제목을 '제목 없음'으로 채운다). */
function normalizeSafe(raw) {
  try {
    const song = normalizeSong(cloneSong(raw));
    if (raw && typeof raw.title === 'string' && !raw.title.trim()) song.title = '';
    return song;
  } catch (err) {
    console.error(err);
    return newSong();
  }
}

// ---------------------------------------------------------------------------
// Screen lifecycle
// ---------------------------------------------------------------------------

let S = null;

export async function mount(root, params = {}, app) {
  unmount();
  const s = {
    root,
    app,
    draft: null,
    stored: null,
    templateDesc: '',
    audioBlob: null,
    audioChanged: false,
    audioMissing: false,
    audioEl: null,
    audioUrl: '',
    audioDuration: NaN,
    dirty: false,
    saving: false,
    undo: [],
    sel: null,
    zoom: 1,
    notationText: '',
    lyricResult: null,
    synth: null,
    player: null,
    offs: [],
    modals: new Set(),
    lyricTimer: 0,
    recoveryTimer: 0,
    rollRaf: 0,
    rollGeo: null,
    ro: null,
    colors: null,
    startedMic: false,
    rec: null,
    tapTimes: [],
    errors: {},
    disposed: false,
    ui: {},
  };
  S = s;
  params = params || {};
  root.append(el('div', { class: 'ed-wrap ed-loading' }, el('p', { class: 'muted' }, '불러오는 중…')));

  try {
    await load(s, params);
  } catch (err) {
    console.error(err);
    app.toast('곡을 불러오지 못했어요.', 'error');
  }
  if (S !== s) return;
  if (!s.draft) s.draft = newSong();

  fill(root);
  build(s);
  refreshLyrics(s);
  renderAll(s, true);
  attachGlobal(s);
}

/** 안드로이드 뒤로 버튼: 저장하지 않은 변경이 있으면 확인 창을 띄우고 이동을 막는다. */
export function onBack() {
  const s = S;
  if (!s || s.disposed) return false;
  if (s.modals.size) return true;
  if (!s.dirty) return false;
  leave(s);
  return true;
}

export function unmount() {
  const s = S;
  if (!s) return;
  S = null;
  s.disposed = true;
  stopRecorder(s);
  for (const m of [...s.modals]) {
    try { m.close(); } catch (err) { console.error(err); }
  }
  for (const off of s.offs) {
    try { off(); } catch (err) { console.error(err); }
  }
  s.offs.length = 0;
  clearTimeout(s.lyricTimer);
  clearTimeout(s.recoveryTimer);
  if (s.rollRaf) cancelAnimationFrame(s.rollRaf);
  if (s.ro) s.ro.disconnect();
  stopPlayer(s);
  if (s.synth) {
    try { s.synth.stopAll(); } catch (err) { console.error(err); }
  }
  disposeAudioEl(s);
  if (s.dirty) writeRecovery(s);
  if (s.startedMic) {
    try {
      const input = s.app.getInput();
      if (s.app.settings.get('inputMode') !== 'mic' && input.mode === 'mic') input.stop();
    } catch (err) {
      console.error(err);
    }
  }
}

async function load(s, params) {
  const { app } = s;
  if (params.draft) {
    // 미리듣기에서 돌아옴
    s.draft = normalizeSafe(params.draft);
    s.audioBlob = params.audioBlob instanceof Blob ? params.audioBlob : null;
    s.dirty = Boolean(params.dirty);
    s.audioChanged = params.audioChanged != null ? Boolean(params.audioChanged) : Boolean(s.draft.audio && s.audioBlob);
    s.audioMissing = Boolean(s.draft.audio && !s.audioBlob);
    const ui = params.editorUi || {};
    if (typeof ui.notationText === 'string') s.notationText = ui.notationText;
    if (ZOOMS.includes(ui.zoom)) s.zoom = ui.zoom;
    if (typeof ui.templateDesc === 'string') s.templateDesc = ui.templateDesc;
    if (Array.isArray(ui.undo)) s.undo = ui.undo.slice(-UNDO_LIMIT);
  } else {
    let song = null;
    if (params.songId) {
      try {
        song = await app.library.get(params.songId);
      } catch (err) {
        console.error(err);
      }
      if (!song) app.toast('곡을 찾지 못해서 새 곡으로 시작해요.', 'error');
    }
    s.draft = song ? normalizeSafe(song) : newSong();
    if (song && song.template) {
      s.templateDesc = song.description || '';
      s.draft.description = '';
    }

    const rec = readRecovery();
    if (rec) {
      const matches = song
        ? rec.id === s.draft.id && Number(rec.savedAt) > (Number(song.updatedAt) || 0)
        : rec.isNew === true;
      if (matches) {
        // 창을 그냥 닫으면(null) 복구본을 남겨 두고 다음에 다시 묻는다.
        const choice = await choose(s, {
          title: '저장하지 않은 편집 내용이 있어요',
          message: `${fmtDate(rec.savedAt)}에 편집하던 "${rec.draft.title || '제목 없음'}" 내용을 복구할까요?`,
          options: [
            { value: 'restore', label: '복구하기', cls: 'primary' },
            { value: 'discard', label: '버리고 새로 시작', cls: 'danger' },
          ],
        });
        if (S !== s) return;
        if (choice === 'restore') {
          s.draft = normalizeSafe(rec.draft);
          s.dirty = true;
        } else if (choice === 'discard') {
          clearRecovery();
        }
      }
    }

    if (s.draft.audio) {
      try {
        s.audioBlob = (await app.library.getAudio(s.draft.id)) || null;
      } catch (err) {
        console.error(err);
        s.audioBlob = null;
      }
      // 복구한 초안이 다른 음원을 가리키면 저장된 파일은 쓸 수 없다
      if (s.audioBlob && song && song.audio && song.audio.name !== s.draft.audio.name) s.audioBlob = null;
      s.audioMissing = !s.audioBlob;
    }
  }
  try {
    s.stored = (await app.library.get(s.draft.id)) || null;
  } catch (err) {
    console.error(err);
    s.stored = null;
  }
  if (S !== s) return;
  if (s.audioBlob) setupAudioEl(s, s.audioBlob);
}

function attachGlobal(s) {
  const onKey = (e) => {
    if (s.modals.size) return;
    const t = e.target;
    const tag = t && t.tagName ? t.tagName : '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
    const mod = e.ctrlKey || e.metaKey;
    const key = String(e.key || '').toLowerCase();
    if (mod && key === 's') {
      e.preventDefault();
      save(s);
      return;
    }
    if (typing) return;
    if (mod && key === 'z') {
      e.preventDefault();
      undo(s);
    } else if (s.sel && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      editSel(s, 'delete');
    } else if (s.sel && e.key === 'Escape') {
      selectNote(s, null);
    }
  };
  const onBeforeUnload = (e) => {
    if (!s.dirty) return;
    writeRecovery(s);
    e.preventDefault();
    e.returnValue = '';
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden' && s.dirty) writeRecovery(s);
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('visibilitychange', onVisibility);
  s.offs.push(() => window.removeEventListener('keydown', onKey));
  s.offs.push(() => window.removeEventListener('beforeunload', onBeforeUnload));
  s.offs.push(() => document.removeEventListener('visibilitychange', onVisibility));

  if (typeof ResizeObserver === 'function') {
    s.ro = new ResizeObserver(() => scheduleRoll(s));
    s.ro.observe(s.ui.rollWrap);
  } else {
    const onResize = () => scheduleRoll(s);
    window.addEventListener('resize', onResize);
    s.offs.push(() => window.removeEventListener('resize', onResize));
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function build(s) {
  const { ui } = s;

  ui.sub = el('span', { class: 'ed-sub' });
  ui.dirtyBadge = el('span', { class: 'badge ed-dirty', hidden: true }, '● 저장 안 됨');
  ui.undoBtn = btn('↶ 되돌리기', () => undo(s), 'small ghost', { title: '되돌리기 (Ctrl+Z)' });
  const topbar = el('header', { class: 'topbar ed-topbar' },
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': '뒤로', title: '뒤로', onClick: () => leave(s) }, '←'),
    el('div', { class: 'title ed-title' }, el('span', { class: 'ed-title-main' }, '곡 편집'), ui.sub),
    ui.dirtyBadge,
    el('div', { class: 'spacer' }),
    ui.undoBtn,
    btn('JSON 가져오기', () => importJson(s), 'small ghost', { title: '곡 파일(.json)을 불러와 지금 편집 중인 곡에 덮어써요' }),
  );

  ui.guide = buildGuide(s);
  const body = el('div', { class: 'ed-body' },
    ui.guide,
    el('div', { class: 'ed-cols' },
      el('div', { class: 'ed-col' }, buildBasics(s), buildNotes(s)),
      el('div', { class: 'ed-col' }, buildLyrics(s), buildAudio(s)),
    ),
  );
  ui.body = body;

  ui.previewBtn = btn('▶ 미리듣기', () => preview(s, 'listen'), '', { title: '자동 연주로 들어보기' });
  ui.practiceBtn = btn('🎹 연습해보기', () => preview(s, 'practice'), '', { title: '맞는 음을 칠 때까지 기다려 주는 연습 모드' });
  ui.exportBtn = btn('내보내기 (.json)', () => exportJson(s), 'ghost');
  ui.deleteBtn = btn('삭제', () => deleteOrReset(s), 'ghost danger');
  ui.saveBtn = btn('💾 저장', () => save(s), 'primary');
  const actions = el('footer', { class: 'ed-actions' },
    ui.previewBtn, ui.practiceBtn, el('div', { class: 'spacer' }), ui.exportBtn, ui.deleteBtn, ui.saveBtn);

  s.root.append(el('div', { class: 'ed-wrap' }, topbar, body, actions));
}

function card(title, ...children) {
  return el('section', { class: 'card ed-card' }, el('h2', { class: 'ed-h' }, title), ...children);
}

let idSeq = 0;

function field(label, control, errKey, s, hint) {
  const err = errKey ? el('div', { class: 'ed-err', hidden: true, role: 'alert' }) : null;
  if (errKey) s.ui[`err_${errKey}`] = err;
  const target = control.matches('input, select, textarea') ? control : control.querySelector('input, select, textarea');
  if (target && !target.id) target.id = `ed-f${++idSeq}`;
  return el('div', { class: 'field ed-field' },
    el('label', { class: 'ed-label', for: target ? target.id : null }, label),
    control,
    hint ? el('div', { class: 'ed-hint muted' }, hint) : null,
    err,
  );
}

function buildGuide(s) {
  return el('section', { class: 'card ed-guide', hidden: true },
    el('h2', { class: 'ed-h' }, '이렇게 만들어 보세요'),
    s.templateDesc ? el('p', { class: 'ed-guide-desc' }, s.templateDesc) : null,
    el('ol', { class: 'ed-guide-steps' },
      el('li', null, el('b', null, '멜로디'), ' — 「악보 파일 가져오기」(MIDI·MusicXML), 「악보 보고 입력」, 피아노를 직접 쳐서 「피아노로 녹음」, '
        + '또는 「텍스트로 입력」으로 노트를 만들어요.'),
      el('li', null, el('b', null, '가사'), ' — 가사를 붙여넣고 「노트에 자동 배치」를 누르면 한 글자마다 노트 하나씩 연결돼요. '
        + 'MusicXML 악보에 가사가 있으면 함께 들어와요.'),
      el('li', null, el('b', null, '확인'), ' — 「미리듣기」와 「연습해보기」로 확인한 뒤 「저장」하세요.'),
    ),
    el('div', { class: 'ed-guide-sheet' },
      el('h3', { class: 'ed-h3' }, '📑 종이/PDF 악보가 있다면'),
      sheetHelpList(),
      sheetHelpNote(),
    ),
  );
}

/** 종이/PDF 악보를 게임에 넣는 방법 (안내 카드와 멜로디 노트 칸에서 함께 쓴다). */
function sheetHelpList() {
  return el('ol', { class: 'ed-sheet-steps' },
    el('li', null, el('b', null, '악보 파일로 바꿔서 가져오기 (추천)'),
      ' — 무료 프로그램 MuseScore의 「PDF 가져오기」나 Audiveris 같은 악보 인식(OMR) 프로그램으로 PDF를 MusicXML(',
      el('code', null, '.mxl'), '·', el('code', null, '.musicxml'), ') 파일로 바꾼 뒤 「악보 파일 가져오기」를 누르세요. '
      + '가사도 함께 들어와요. 잘못 인식된 음은 피아노 롤에서 노트를 눌러 고치면 돼요.'),
    el('li', null, el('b', null, '「악보 보고 입력」'),
      ' — 악보를 보면서 음표 길이를 고르고 화면 건반을 눌러 한 음씩 입력해요.'),
    el('li', null, el('b', null, '「피아노로 녹음」'), ' — 멜로디를 피아노로 직접 쳐서 넣어요.'),
  );
}

function sheetHelpNote() {
  return el('p', { class: 'ed-hint muted' },
    '🔒 가져온 악보와 만든 곡은 이 기기에만 저장돼요(기기에만 저장). 어디에도 올라가지 않아요.');
}

// --- 1. 기본 정보 ------------------------------------------------------------

function buildBasics(s) {
  const { ui } = s;
  ui.title = el('input', {
    type: 'text', class: 'ed-input', maxlength: 100, placeholder: '곡 제목', enterkeyhint: 'next', autocomplete: 'off',
    onInput: (e) => {
      s.draft.title = e.target.value;
      if (e.target.value.trim()) setError(s, 'title', '');
      markDirty(s);
      renderHeader(s);
    },
  });
  ui.artist = el('input', {
    type: 'text', class: 'ed-input', maxlength: 100, placeholder: '아티스트 (선택)', enterkeyhint: 'next', autocomplete: 'off',
    onInput: (e) => { s.draft.artist = e.target.value; markDirty(s); },
  });
  ui.bpm = el('input', {
    type: 'number', class: 'ed-input ed-num', min: 30, max: 300, step: 1, inputmode: 'decimal', 'aria-label': 'BPM',
    onInput: () => onBpmInput(s, false),
    onChange: () => onBpmInput(s, true),
  });
  ui.tapBtn = btn('탭', () => tapTempo(s), 'small ed-tap', { title: '박자에 맞춰 여러 번 눌러서 BPM 찾기' });
  const bpmCtl = el('div', { class: 'ed-stepper' },
    btn('−', () => stepBpm(s, -1), 'small', { 'aria-label': 'BPM 1 줄이기' }),
    ui.bpm,
    btn('+', () => stepBpm(s, 1), 'small', { 'aria-label': 'BPM 1 늘리기' }),
    ui.tapBtn,
  );
  ui.beats = el('select', {
    class: 'ed-input', 'aria-label': '한 마디의 박 수',
    onChange: (e) => {
      s.draft.beatsPerBar = Number(e.target.value);
      setError(s, 'beatsPerBar', '');
      markDirty(s);
      scheduleRoll(s);
    },
  }, BEATS_OPTIONS.map((n) => el('option', { value: n }, `${n}박 (${n}/4)`)));
  ui.offset = el('input', {
    type: 'number', class: 'ed-input ed-num', step: 0.01, inputmode: 'decimal', 'aria-label': '첫 박 위치(초)',
    onInput: () => onOffsetInput(s, false),
    onChange: () => onOffsetInput(s, true),
  });
  const offsetCtl = el('div', { class: 'ed-stepper' },
    ui.offset,
    btn('첫 노트', () => offsetToFirstNote(s), 'small', { title: '첫 박을 첫 노트 위치에 맞추기' }),
  );
  ui.desc = el('input', {
    type: 'text', class: 'ed-input', maxlength: 200, placeholder: '곡 카드에 보일 짧은 설명 (선택)', autocomplete: 'off',
    onInput: (e) => { s.draft.description = e.target.value; markDirty(s); },
  });

  return card('기본 정보',
    el('div', { class: 'ed-grid2' },
      field('제목 *', ui.title, 'title', s),
      field('아티스트', ui.artist, null, s),
    ),
    el('div', { class: 'ed-grid3' },
      field('빠르기 (BPM)', bpmCtl, 'bpm', s),
      field('박자', ui.beats, 'beatsPerBar', s),
      field('첫 박 위치 (초)', offsetCtl, 'offset', s),
    ),
    el('p', { class: 'ed-hint muted' },
      'BPM·박자·첫 박은 박자선, 메트로놈, 녹음 카운트인, 텍스트 입력과 박자 맞춤(양자화)에 쓰여요. 이미 있는 노트의 시간은 바뀌지 않아요. '
      + '노트까지 함께 빠르게/느리게 하려면 「빠르기 바꾸기」를 쓰세요.'),
    field('설명', ui.desc, null, s),
  );
}

/** show=false: 입력 중에는 오류를 기록만 하고(이미 보이던 오류는 갱신) 칸을 벗어날 때 보여준다. */
function setError(s, key, msg, show = true) {
  if (msg) s.errors[key] = msg;
  else delete s.errors[key];
  const node = s.ui[`err_${key}`];
  if (!node) return;
  const visible = Boolean(msg) && (show || !node.hidden);
  node.textContent = visible ? msg : '';
  node.hidden = !visible;
  const ctl = { title: s.ui.title, bpm: s.ui.bpm, beatsPerBar: s.ui.beats, offset: s.ui.offset }[key];
  if (ctl) ctl.classList.toggle('invalid', visible);
}

function onBpmInput(s, commit = false) {
  const v = parseNum(s.ui.bpm.value);
  if (Number.isFinite(v) && v >= 30 && v <= 300) {
    const bpm = Math.round(v * 100) / 100;
    setError(s, 'bpm', '');
    if (bpm === s.draft.bpm) return;
    s.draft.bpm = bpm;
    markDirty(s);
    scheduleRoll(s);
  } else {
    setError(s, 'bpm', 'BPM은 30~300 사이로 입력해 주세요.', commit);
  }
}

function stepBpm(s, d) {
  const cur = Number.isFinite(parseNum(s.ui.bpm.value)) ? parseNum(s.ui.bpm.value) : s.draft.bpm;
  const v = clamp(Math.round(cur) + d, 30, 300);
  s.ui.bpm.value = String(v);
  onBpmInput(s, true);
}

function tapTempo(s) {
  const now = performance.now();
  const taps = s.tapTimes;
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now);
  if (taps.length > 8) taps.shift();
  if (taps.length >= 3) {
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    const bpm = Math.round(60000 / avg);
    if (bpm >= 30 && bpm <= 300) {
      s.ui.bpm.value = String(bpm);
      onBpmInput(s, true);
    }
    s.ui.tapBtn.textContent = `탭 ${bpm}`;
  } else {
    s.ui.tapBtn.textContent = `탭 ${'•'.repeat(taps.length)}`;
  }
}

function onOffsetInput(s, commit = false) {
  const v = parseNum(s.ui.offset.value);
  if (Number.isFinite(v) && Math.abs(v) <= 3600) {
    const off = round3(v);
    setError(s, 'offset', '');
    if (off === s.draft.offset) return;
    s.draft.offset = off;
    markDirty(s);
    scheduleRoll(s);
  } else {
    setError(s, 'offset', '첫 박 위치를 초 단위 숫자로 입력해 주세요.', commit);
  }
}

function offsetToFirstNote(s) {
  const n = s.draft.notes[0];
  if (!n) {
    s.app.toast('노트가 없어요.');
    return;
  }
  s.draft.offset = round3(n.t);
  s.ui.offset.value = String(s.draft.offset);
  setError(s, 'offset', '');
  markDirty(s);
  scheduleRoll(s);
  s.app.toast(`첫 박을 첫 노트(${fmtClock(n.t, 2)})에 맞췄어요.`);
}

// --- 2. 멜로디 노트 ----------------------------------------------------------

function buildNotes(s) {
  const { ui } = s;
  ui.noteSummary = el('div', { class: 'ed-summary' });
  ui.zoomSeg = seg(ZOOMS.map((z) => ({ value: z, label: z === 1 ? '전체' : `${z}×` })), s.zoom, (z) => {
    s.zoom = Number(z);
    scheduleRoll(s);
  }, '확대');
  ui.canvas = el('canvas', { class: 'ed-roll', onClick: (e) => onRollTap(s, e) });
  ui.rollWrap = el('div', { class: 'ed-roll-wrap' }, ui.canvas);

  ui.selInfo = el('span', { class: 'ed-sel-info' });
  ui.selBar = el('div', { class: 'ed-selbar', hidden: true },
    ui.selInfo,
    el('div', { class: 'ed-selbar-btns' },
      btn('▼ 반음', () => editSel(s, 'down'), 'small'),
      btn('▲ 반음', () => editSel(s, 'up'), 'small'),
      btn('◀', () => editSel(s, 'earlier'), 'small', { title: '16분음표만큼 앞으로', 'aria-label': '앞으로' }),
      btn('▶', () => editSel(s, 'later'), 'small', { title: '16분음표만큼 뒤로', 'aria-label': '뒤로' }),
      btn('짧게', () => editSel(s, 'shorter'), 'small'),
      btn('길게', () => editSel(s, 'longer'), 'small'),
      btn('삭제', () => editSel(s, 'delete'), 'small danger'),
      btn('✕', () => selectNote(s, null), 'small ghost', { 'aria-label': '선택 해제' }),
    ),
  );

  const tools = el('div', { class: 'ed-tools' },
    el('div', { class: 'ed-tool-group' },
      el('span', { class: 'ed-tool-label' }, '음높이'),
      btn('반음 −', () => toolTranspose(s, -1), 'small'),
      btn('반음 +', () => toolTranspose(s, 1), 'small'),
      btn('옥타브 −', () => toolTranspose(s, -12), 'small'),
      btn('옥타브 +', () => toolTranspose(s, 12), 'small'),
    ),
    el('div', { class: 'ed-tool-group' },
      el('span', { class: 'ed-tool-label' }, '시간'),
      btn(`−${NUDGE_SEC}초`, () => toolShift(s, -NUDGE_SEC), 'small', { title: '노트 전체를 앞으로' }),
      btn(`+${NUDGE_SEC}초`, () => toolShift(s, NUDGE_SEC), 'small', { title: '노트 전체를 뒤로' }),
      btn('앞 공백 제거', () => toolTrim(s), 'small', { title: '첫 노트가 0초가 되도록 전체를 당겨요' }),
      btn('빠르기 바꾸기…', () => openTempoDialog(s), 'small'),
    ),
    el('div', { class: 'ed-tool-group' },
      el('span', { class: 'ed-tool-label' }, '정리'),
      btn('박자 맞춤…', () => openQuantizeDialog(s), 'small', { title: '노트 시작을 박자 격자에 맞춰요' }),
      btn('모두 지우기', () => toolClear(s), 'small danger'),
    ),
  );

  const sources = el('div', { class: 'ed-sources' },
    btn('🎹 피아노로 녹음', () => openRecorder(s), 'primary'),
    btn('📄 악보 파일 가져오기', () => openScoreImport(s), '', {
      title: 'MIDI(.mid) 또는 MusicXML(.musicxml·.mxl) 악보 파일을 가져와요',
    }),
    btn('🎼 악보 보고 입력', () => openStepEntry(s), '', {
      title: '악보를 보면서 화면 건반으로 한 음씩 입력해요',
    }),
  );

  const sheetHelp = el('details', { class: 'ed-details ed-sheet-help' },
    el('summary', null, '📑 종이/PDF 악보가 있다면'),
    el('div', { class: 'ed-help' }, sheetHelpList(), sheetHelpNote()),
  );

  return card('멜로디 노트',
    el('div', { class: 'ed-summary-row' }, ui.noteSummary, ui.zoomSeg),
    ui.rollWrap,
    el('div', { class: 'ed-roll-legend muted' },
      el('span', { class: 'ed-lg ed-lg-white' }, '흰 건반'),
      el('span', { class: 'ed-lg ed-lg-black' }, '검은 건반'),
      el('span', { class: 'ed-lg ed-lg-lyric' }, '가사 줄 시작'),
      el('span', null, '노트를 누르면 소리를 듣고 고칠 수 있어요'),
    ),
    ui.selBar,
    sources,
    sheetHelp,
    tools,
    buildNotation(s),
  );
}

function buildNotation(s) {
  const { ui } = s;
  ui.notation = el('textarea', {
    class: 'ed-input ed-mono', rows: 5, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off',
    placeholder: 'C4 D4 E4:2 | 도4 레4 미4:2 | R:1',
    'aria-label': '노트 텍스트',
    onInput: (e) => { s.notationText = e.target.value; },
  });
  ui.notation.value = s.notationText;
  ui.notationErrs = el('div', { class: 'ed-errbox', hidden: true });
  ui.notationBox = el('details', { class: 'ed-details ed-notation' },
    el('summary', null, '⌨ 텍스트로 입력'),
    el('div', { class: 'ed-help' },
      el('p', null, '예) ', el('code', null, 'C4 D4 E4:2 | 도4 레4 미4:2 | R:1')),
      el('ul', null,
        el('li', null, '음 이름: ', el('code', null, 'C D E F G A B'), ' 또는 ', el('code', null, '도 레 미 파 솔 라 시'),
          ' + 옥타브 숫자 (', el('code', null, 'C4'), ' = 가운데 도, 숫자를 빼면 4옥타브)'),
        el('li', null, '샵·플랫: ', el('code', null, 'C#4'), ' ', el('code', null, 'Db4'), ' ', el('code', null, '솔#3')),
        el('li', null, '길이: 음 뒤에 ', el('code', null, ':박'), ' — ', el('code', null, 'C4:2'), ' (2박), ',
          el('code', null, 'E4:0.5'), ' 또는 ', el('code', null, 'E4:1/2'), ' (반 박). 생략하면 1박'),
        el('li', null, '쉼표: ', el('code', null, 'R'), ' 또는 ', el('code', null, '쉼'), ' (', el('code', null, 'R:2'), ' = 2박 쉬기)'),
        el('li', null, el('code', null, '|'), ' 와 ', el('code', null, ','), ' 는 보기 좋게 나누는 용도라 무시돼요. ',
          el('code', null, '#'), '으로 시작하는 줄은 메모예요.'),
        el('li', null, '「적용」은 첫 박 위치부터, 「뒤에 추가」는 마지막 노트 다음 마디부터 채워요.'),
      ),
    ),
    ui.notation,
    el('div', { class: 'ed-row' },
      btn('적용 (교체)', () => applyNotation(s, 'replace'), 'primary small'),
      btn('뒤에 추가', () => applyNotation(s, 'append'), 'small'),
      btn('현재 노트를 텍스트로', () => notesToText(s), 'small ghost'),
    ),
    ui.notationErrs,
  );
  if (s.notationText) ui.notationBox.open = true;
  return ui.notationBox;
}

// --- 3. 가사 -----------------------------------------------------------------

function buildLyrics(s) {
  const { ui } = s;
  ui.lyricSource = el('span', { class: 'badge ed-src' });
  ui.lrcBanner = el('div', { class: 'ed-banner', hidden: true },
    el('span', null, 'LRC 파일의 시간 정보로 가사를 보여주고 있어요. 노트와 상관없이 정해진 시간에 색이 바뀌어요.'),
    btn('노트 기준으로 바꾸기', () => switchToNotes(s), 'small'),
  );
  ui.pasteBanner = el('div', { class: 'ed-banner', hidden: true },
    el('span', null, '시간 표시([00:12.34])가 있는 LRC 가사 같아요.'),
    btn('시간 정보로 가져오기', () => applyLrcText(s, ui.lyrics.value, '붙여넣은 LRC'), 'small primary'),
  );
  ui.lyrics = el('textarea', {
    class: 'ed-input ed-lyrics', rows: 10, spellcheck: 'false', autocomplete: 'off', 'aria-label': '가사',
    placeholder: '예)\n[1절]\n손끝으로 톡톡 톡\n소리가 피~어나\n_ 천천히 한 걸음씩',
    onInput: (e) => onLyricsInput(s, e.target.value),
  });
  ui.lyricStats = el('div', { class: 'ed-lstats muted' });
  ui.lyricWarn = el('ul', { class: 'ed-warns', hidden: true });
  ui.lyricPreview = el('ol', { class: 'ed-lpreview' });
  ui.lyricPreviewBox = el('div', { class: 'ed-lpreview-box', hidden: true },
    el('div', { class: 'ed-lpreview-head muted' }, '줄별 미리보기 (시작 시간 · 가사)'),
    ui.lyricPreview,
  );

  const help = el('details', { class: 'ed-details ed-lhelp' },
    el('summary', null, '가사 입력 방법'),
    el('ul', { class: 'ed-help' },
      el('li', null, '한 줄이 노래방 화면의 한 줄이 돼요.'),
      el('li', null, '한글은 ', el('b', null, '한 글자 = 노트 하나'), '예요. 동시에 치는 화음은 노트 하나로 세요.'),
      el('li', null, '영어는 단어 하나가 노트 하나예요. ', el('code', null, 'twin-kle'), '처럼 ', el('code', null, '-'), '로 나누면 여러 노트가 돼요.'),
      el('li', null, el('code', null, '~'), ' 앞 글자를 다음 노트까지 길게 늘여요. 예) ', el('code', null, '사~랑해'), ' → "사"가 노트 2개'),
      el('li', null, el('code', null, '_'), ' 가사 없이 노트 하나를 건너뛰어요. (전주·간주 음)'),
      el('li', null, el('code', null, '[1절]'), ' ', el('code', null, '[후렴]'), ' 같은 줄, ', el('code', null, '#'),
        '으로 시작하는 줄, 빈 줄은 무시돼요.'),
      el('li', null, '쉼표·마침표 같은 문장부호는 앞 글자에 붙어서 노트를 쓰지 않아요.'),
      el('li', null, '가사가 남거나 노트가 남으면 아래에 알려 줘요. 줄별 미리보기의 시간을 보며 맞춰 보세요.'),
    ),
  );

  return card(el('span', { class: 'ed-h-inner' }, '가사', ui.lyricSource),
    help,
    ui.lrcBanner,
    ui.pasteBanner,
    ui.lyrics,
    ui.lyricStats,
    el('div', { class: 'ed-row ed-wrap-row' },
      btn('노트에 자동 배치', () => autoPlaceLyrics(s), 'primary small'),
      btn('계이름으로 채우기', () => fillSolfege(s), 'small'),
      btn('LRC 가져오기', () => importLrc(s), 'small'),
      btn('LRC 내보내기', () => exportLrc(s), 'small ghost'),
    ),
    ui.lyricWarn,
    ui.lyricPreviewBox,
  );
}

// --- 4. 반주 음원 -------------------------------------------------------------

function buildAudio(s) {
  s.ui.audioBody = el('div', { class: 'ed-audio' });
  return card('반주 음원 (선택)',
    el('p', { class: 'ed-hint muted' },
      '반주(MR)를 함께 틀 수 있어요. 마이크로 연주할 때는 스피커 소리가 마이크에 섞이니 ', el('b', null, '이어폰'), '을 권장해요. '
      + '음원 파일은 이 기기에만 저장되고 JSON 내보내기에는 포함되지 않아요.'),
    s.ui.audioBody,
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll(s, force = false) {
  renderHeader(s);
  renderBasics(s, force);
  renderNotesSummary(s);
  renderSelection(s);
  renderLyrics(s, force);
  renderAudio(s);
  renderActions(s);
  renderGuide(s);
  scheduleRoll(s);
}

function renderHeader(s) {
  const { ui, draft } = s;
  ui.sub.textContent = draft.title.trim() || '새 곡';
  ui.dirtyBadge.hidden = !s.dirty;
  ui.undoBtn.disabled = s.undo.length === 0;
  ui.undoBtn.title = s.undo.length ? `되돌리기: ${s.undo[s.undo.length - 1].label} (Ctrl+Z)` : '되돌릴 작업이 없어요';
}

function renderBasics(s, force = false) {
  const { ui, draft } = s;
  const setVal = (input, v) => {
    if ((force || document.activeElement !== input) && input.value !== String(v)) input.value = String(v);
  };
  setVal(ui.title, draft.title);
  setVal(ui.artist, draft.artist || '');
  setVal(ui.desc, draft.description || '');
  setVal(ui.bpm, draft.bpm);
  setVal(ui.offset, draft.offset);
  if (![...ui.beats.options].some((o) => Number(o.value) === draft.beatsPerBar)) {
    ui.beats.append(el('option', { value: draft.beatsPerBar }, `${draft.beatsPerBar}박`));
  }
  ui.beats.value = String(draft.beatsPerBar);
  if (force) {
    setError(s, 'bpm', '');
    setError(s, 'offset', '');
    setError(s, 'beatsPerBar', '');
  }
}

function renderGuide(s) {
  s.ui.guide.hidden = s.draft.notes.length > 0;
}

function renderNotesSummary(s) {
  const notes = s.draft.notes;
  if (!notes.length) {
    s.ui.noteSummary.textContent = '노트가 아직 없어요';
    return;
  }
  const r = noteRange(notes);
  const dur = songDuration({ ...s.draft, lyrics: { ...s.draft.lyrics, lines: [] } });
  fill(s.ui.noteSummary,
    el('b', null, `노트 ${notes.length}개`),
    ` · 음역 ${r ? rangeText(r.min, r.max) : '-'} · 길이 ${fmtClock(dur)}`,
  );
}

function renderActions(s) {
  const { ui, app } = s;
  const has = s.draft.notes.length > 0;
  ui.previewBtn.disabled = !has;
  ui.practiceBtn.disabled = !has;
  ui.saveBtn.disabled = s.saving;
  ui.saveBtn.textContent = s.saving ? '저장 중…' : '💾 저장';

  const id = s.draft.id;
  let builtin = false;
  try { builtin = app.library.isBuiltin(id); } catch { builtin = false; }
  if (builtin) {
    const override = hasOverride(s);
    ui.deleteBtn.textContent = '초기화';
    ui.deleteBtn.disabled = !override;
    ui.deleteBtn.title = override ? '저장한 편집 내용을 지우고 기본 곡으로 되돌려요' : '아직 저장한 편집 내용이 없어요';
  } else if (s.stored) {
    ui.deleteBtn.textContent = '삭제';
    ui.deleteBtn.disabled = false;
    ui.deleteBtn.title = '이 곡을 삭제해요';
  } else {
    ui.deleteBtn.textContent = '버리기';
    ui.deleteBtn.disabled = false;
    ui.deleteBtn.title = '저장하지 않고 이 곡을 버려요';
  }
}

function renderSelection(s) {
  const n = s.sel;
  const { ui } = s;
  if (!n || !s.draft.notes.includes(n)) {
    s.sel = null;
    ui.selBar.hidden = true;
    return;
  }
  ui.selBar.hidden = false;
  fill(ui.selInfo,
    el('b', null, noteLabel(n.m)),
    ` · ${fmtClock(n.t, 2)} · ${n.d.toFixed(2)}초`,
  );
}

function markDirty(s) {
  if (s.disposed) return;
  s.dirty = true;
  renderHeader(s);
  clearTimeout(s.recoveryTimer);
  s.recoveryTimer = setTimeout(() => {
    if (!s.disposed && s.dirty) writeRecovery(s);
  }, 1000);
}

/** 노트가 바뀐 뒤 공통 처리. */
function notesChanged(s, { keepSel = false } = {}) {
  if (!keepSel) s.sel = null;
  refreshLyrics(s);
  renderNotesSummary(s);
  renderSelection(s);
  renderLyrics(s);
  renderActions(s);
  renderGuide(s);
  markDirty(s);
  scheduleRoll(s);
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

function pushUndo(s, label, { basics = false } = {}) {
  const d = s.draft;
  s.undo.push({
    label,
    notes: copyNotes(d.notes),
    lyrics: copyLyrics(d.lyrics),
    audioOffset: d.audio ? d.audio.offset : null,
    basics: basics ? {
      title: d.title, artist: d.artist, description: d.description,
      bpm: d.bpm, beatsPerBar: d.beatsPerBar, offset: d.offset,
    } : null,
  });
  if (s.undo.length > UNDO_LIMIT) s.undo.shift();
  renderHeader(s);
}

function undo(s) {
  const snap = s.undo.pop();
  if (!snap) {
    s.app.toast('되돌릴 작업이 없어요.');
    return;
  }
  const d = s.draft;
  d.notes = snap.notes;
  d.lyrics = snap.lyrics;
  if (d.audio && snap.audioOffset != null) d.audio.offset = snap.audioOffset;
  if (snap.basics) Object.assign(d, snap.basics);
  s.sel = null;
  refreshLyrics(s);
  renderAll(s, true);
  markDirty(s);
  s.app.toast(`되돌렸어요: ${snap.label}`);
}

// ---------------------------------------------------------------------------
// Piano roll
// ---------------------------------------------------------------------------

function scheduleRoll(s) {
  if (s.rollRaf || s.disposed) return;
  s.rollRaf = requestAnimationFrame(() => {
    s.rollRaf = 0;
    if (!s.disposed) drawRoll(s);
  });
}

function rollColors(s) {
  if (s.colors) return s.colors;
  let cs = null;
  try { cs = getComputedStyle(document.documentElement); } catch { cs = null; }
  const v = (name, fb) => ((cs && cs.getPropertyValue(name)) || '').trim() || fb;
  s.colors = {
    bg: v('--bg-2', '#111427'),
    blackRow: 'rgba(255,255,255,0.035)',
    cLine: 'rgba(255,255,255,0.16)',
    beat: 'rgba(255,255,255,0.06)',
    bar: 'rgba(255,255,255,0.17)',
    muted: v('--muted', '#9aa0c3'),
    white: v('--accent-2', '#22d3ee'),
    black: '#a78bfa',
    lyric: v('--sung', '#38bdf8'),
    audio: v('--perfect', '#ffd84d'),
    sel: '#ffffff',
    font: v('--font', '"Pretendard","Noto Sans KR","Malgun Gothic",system-ui,sans-serif'),
  };
  return s.colors;
}

function currentLines(s) {
  return s.lyricResult && Array.isArray(s.lyricResult.lines) ? s.lyricResult.lines : [];
}

function drawRoll(s) {
  const { canvas, rollWrap } = s.ui;
  const wrapW = rollWrap.clientWidth;
  if (!wrapW) return;
  const cssW = Math.max(240, Math.round(wrapW * s.zoom));
  canvas.style.width = `${cssW}px`;
  const cssH = canvas.clientHeight || 200;
  let dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cssW * dpr > 8192) dpr = 8192 / cssW;
  const pw = Math.round(cssW * dpr);
  const ph = Math.round(cssH * dpr);
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const g = canvas.getContext('2d');
  if (!g) return;
  const C = rollColors(s);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = C.bg;
  g.fillRect(0, 0, cssW, cssH);

  const d = s.draft;
  const notes = d.notes;
  const lines = currentLines(s);
  let end = 0;
  let mn = 127;
  let mx = 0;
  for (const n of notes) {
    end = Math.max(end, n.t + n.d);
    if (n.m < mn) mn = n.m;
    if (n.m > mx) mx = n.m;
  }
  for (const line of lines) for (const y of line.syllables) end = Math.max(end, y.t + y.d);
  const tEnd = Math.max(4, end + 0.5);
  const top = 18;
  const bottom = 16;
  let lo = 60;
  let hi = 74;
  if (notes.length) {
    lo = mn - 2;
    hi = mx + 2;
  }
  if (hi - lo < 14) {
    const c = (lo + hi) / 2;
    lo = Math.floor(c - 7);
    hi = lo + 14;
  }
  const rowH = (cssH - top - bottom) / (hi - lo + 1);
  const pps = cssW / tEnd;
  const yOf = (m) => top + (hi - m) * rowH;
  s.rollGeo = { pps, top, rowH, lo, hi };

  // 검은 건반 줄, C 줄
  g.fillStyle = C.blackRow;
  for (let m = lo; m <= hi; m++) if (isBlackKey(m)) g.fillRect(0, yOf(m), cssW, rowH);
  g.font = `10px ${C.font}`;
  g.textBaseline = 'alphabetic';
  g.fillStyle = C.cLine;
  for (let m = lo; m <= hi; m++) {
    if (m % 12 === 0) g.fillRect(0, Math.round(yOf(m) + rowH) - 0.5, cssW, 1);
  }

  // 박/마디 선
  const beat = 60 / (d.bpm > 0 ? d.bpm : 100);
  const bpb = d.beatsPerBar > 0 ? d.beatsPerBar : 4;
  const beatPx = beat * pps;
  const barPx = beatPx * bpb;
  const off = Number.isFinite(d.offset) ? d.offset : 0;
  if (barPx >= 5) {
    const step = beatPx >= 7 ? 1 : bpb;
    const k0 = Math.ceil(-off / beat / step) * step;
    for (let k = k0; ; k += step) {
      const t = off + k * beat;
      if (t > tEnd) break;
      if (t < 0) continue;
      const isBar = ((k % bpb) + bpb) % bpb === 0;
      g.fillStyle = isBar ? C.bar : C.beat;
      g.fillRect(Math.round(t * pps), top, 1, cssH - top - bottom);
    }
  }

  // 시간 눈금
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  const tStep = steps.find((x) => x * pps >= 56) || 600;
  g.fillStyle = C.muted;
  for (let t = 0; t <= tEnd; t += tStep) g.fillText(fmtClock(t), Math.round(t * pps) + 3, cssH - 4);

  // 음원 시작 위치
  if (d.audio && Number.isFinite(d.audio.offset) && d.audio.offset > 0 && d.audio.offset < tEnd) {
    const x = Math.round(d.audio.offset * pps) + 0.5;
    g.fillStyle = C.audio;
    g.fillRect(x - 0.5, top, 1, cssH - top - bottom);
    g.fillText('♪', x + 2, top + 10);
  }

  // 가사 줄 시작
  if (lines.length) {
    g.save();
    g.strokeStyle = C.lyric;
    g.globalAlpha = 0.75;
    g.setLineDash([3, 3]);
    g.lineWidth = 1;
    g.fillStyle = C.lyric;
    g.font = `bold 11px ${C.font}`;
    let lastLabelX = -100;
    lines.forEach((line, i) => {
      if (!line.syllables.length) return;
      const t = lineStart(line);
      if (!Number.isFinite(t)) return;
      const x = Math.round(t * pps) + 0.5;
      g.beginPath();
      g.moveTo(x, top - 2);
      g.lineTo(x, cssH - bottom);
      g.stroke();
      if (x - lastLabelX >= 16) {
        g.fillText(String(i + 1), x + 2, 12);
        lastLabelX = x;
      }
    });
    g.restore();
  }

  // 노트
  const h = Math.max(2, rowH - 1);
  for (const n of notes) {
    const x = n.t * pps;
    const w = Math.max(2, n.d * pps - 1);
    g.fillStyle = isBlackKey(n.m) ? C.black : C.white;
    g.fillRect(x, yOf(n.m) + (rowH - h) / 2, w, h);
  }
  // 옥타브(C) 이름표는 노트 위에 그린다
  g.font = `10px ${C.font}`;
  for (let m = lo; m <= hi; m++) {
    if (m % 12 !== 0) continue;
    const y = Math.round(yOf(m) + rowH) - 0.5;
    const label = noteName(m, 'en');
    g.fillStyle = 'rgba(11,13,23,0.72)';
    g.fillRect(1, y - 12, g.measureText(label).width + 6, 11);
    g.fillStyle = C.muted;
    g.fillText(label, 4, y - 3);
  }

  if (s.sel && notes.includes(s.sel)) {
    const n = s.sel;
    g.strokeStyle = C.sel;
    g.lineWidth = 2;
    g.setLineDash([]);
    g.strokeRect(n.t * pps - 1, yOf(n.m) - 1, Math.max(2, n.d * pps - 1) + 2, rowH + 2);
  }

  if (!notes.length) {
    g.fillStyle = C.muted;
    g.font = `14px ${C.font}`;
    g.textAlign = 'center';
    g.fillText('아직 노트가 없어요', cssW / 2, cssH / 2 + 5);
    g.textAlign = 'start';
  }
}

function onRollTap(s, e) {
  const geo = s.rollGeo;
  const notes = s.draft.notes;
  if (!geo || !notes.length) return;
  const rect = s.ui.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  let best = null;
  let bestScore = Infinity;
  for (const n of notes) {
    const x0 = n.t * geo.pps;
    const x1 = x0 + Math.max(2, n.d * geo.pps);
    const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
    const yc = geo.top + (geo.hi - n.m) * geo.rowH + geo.rowH / 2;
    const dy = Math.max(0, Math.abs(y - yc) - geo.rowH / 2);
    if (dx > 12 || dy > Math.max(10, geo.rowH)) continue;
    const score = dx + dy;
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  }
  selectNote(s, best);
  if (best) playPreviewNote(s, best.m);
}

function selectNote(s, n) {
  s.sel = n;
  renderSelection(s);
  scheduleRoll(s);
}

function editSel(s, action) {
  const n = s.sel;
  const notes = s.draft.notes;
  if (!n || !notes.includes(n)) {
    selectNote(s, null);
    return;
  }
  const step = round3(60 / s.draft.bpm / 4);
  const labels = {
    up: '반음 올리기', down: '반음 내리기', earlier: '앞으로 옮기기', later: '뒤로 옮기기',
    shorter: '짧게', longer: '길게', delete: '노트 삭제',
  };
  pushUndo(s, labels[action] || '노트 수정');
  switch (action) {
    case 'up': n.m = clamp(n.m + 1, 21, 108); break;
    case 'down': n.m = clamp(n.m - 1, 21, 108); break;
    case 'earlier': n.t = Math.max(0, round3(n.t - step)); break;
    case 'later': n.t = round3(n.t + step); break;
    case 'shorter': n.d = Math.max(0.05, round3(n.d - step)); break;
    case 'longer': n.d = round3(n.d + step); break;
    case 'delete': notes.splice(notes.indexOf(n), 1); break;
    default: break;
  }
  if (action === 'delete') {
    notesChanged(s);
    return;
  }
  sortNotes(notes);
  notesChanged(s, { keepSel: true });
  if (action === 'up' || action === 'down') playPreviewNote(s, n.m);
}

// ---------------------------------------------------------------------------
// Audio helpers (synth)
// ---------------------------------------------------------------------------

function unlock(s) {
  // app.unlockAudio는 마스터 볼륨도 맞춘다. 사용자 제스처 안에서 다른 await보다 먼저 호출할 것.
  return typeof s.app.unlockAudio === 'function' ? s.app.unlockAudio() : unlockAudio();
}

async function getSynth(s) {
  await unlock(s);
  if (!s.synth) s.synth = new Synth(getAudioContext());
  return s.synth;
}

function playPreviewNote(s, m) {
  getSynth(s).then((synth) => {
    if (s.disposed) return;
    synth.playNote(m, getAudioContext().currentTime + 0.02, 0.5, { velocity: 0.7 });
  }).catch((err) => console.error(err));
}

function stopPlayer(s) {
  const p = s.player;
  if (!p) return;
  s.player = null;
  clearInterval(p.timer);
  try { if (s.synth) s.synth.stopAll(); } catch (err) { console.error(err); }
  if (p.onEnd) {
    try { p.onEnd(); } catch (err) { console.error(err); }
  }
}

/**
 * notes를 첫 노트부터 최대 maxSec초 들려준다. 신스 보이스 수가 적어서 0.35초 앞까지만 조금씩 예약한다.
 * 끝나거나 멈추면 onEnd를 부른다. 재생을 시작했으면 true.
 */
async function playNotes(s, notes, { maxSec = 30, onEnd = null } = {}) {
  const synth = await getSynth(s);
  stopPlayer(s);
  if (s.disposed || !notes.length) return false;
  const ctx = getAudioContext();
  const first = notes[0].t;
  const list = [];
  let endRel = 0;
  for (const n of notes) {
    const rel = n.t - first;
    if (rel > maxSec) break;
    const dur = clamp(n.d, 0.08, 2);
    list.push({ rel, dur, m: clamp(n.m, 21, 108), v: 0.35 + 0.45 * (Number.isFinite(n.v) ? n.v : 0.7) });
    endRel = Math.max(endRel, rel + dur);
  }
  const t0 = ctx.currentTime + 0.12;
  let i = 0;
  const player = { timer: 0, onEnd };
  const tick = () => {
    if (s.player !== player) return;
    const now = ctx.currentTime;
    while (i < list.length && t0 + list[i].rel < now + 0.35) {
      const n = list[i++];
      synth.playNote(n.m, t0 + n.rel, n.dur, { velocity: n.v });
    }
    if (i >= list.length && now > t0 + endRel + 0.2) stopPlayer(s);
  };
  s.player = player;
  player.timer = setInterval(tick, 50);
  tick();
  return true;
}

// ---------------------------------------------------------------------------
// Note tools
// ---------------------------------------------------------------------------

function requireNotes(s) {
  if (s.draft.notes.length) return true;
  s.app.toast('노트가 없어요. 먼저 멜로디를 만들어 주세요.');
  return false;
}

function toolTranspose(s, semis) {
  if (!requireNotes(s)) return;
  const r = noteRange(s.draft.notes);
  if (r && (r.min + semis < 21 || r.max + semis > 108)) {
    s.app.toast('피아노 건반(A0~C8) 범위를 벗어나는 음이 있어서 바꿀 수 없어요.', 'error');
    return;
  }
  const label = Math.abs(semis) === 12 ? `옥타브 ${semis > 0 ? '+' : '−'}` : `반음 ${semis > 0 ? '+' : '−'}`;
  pushUndo(s, label);
  s.draft.notes = transposeNotes(s.draft.notes, semis);
  notesChanged(s);
}

function toolShift(s, sec) {
  if (!requireNotes(s)) return;
  pushUndo(s, `시간 ${fmtSec(sec)}`);
  s.draft.notes = shiftNotes(s.draft.notes, sec);
  notesChanged(s);
}

function toolTrim(s) {
  if (!requireNotes(s)) return;
  const res = trimLeadingSilence(s.draft);
  if (!res) {
    s.app.toast('첫 노트가 이미 0초에 있어요.');
    return;
  }
  pushUndo(s, '앞 공백 제거', { basics: true });
  const d = s.draft;
  d.notes = res.notes;
  d.offset = res.offset;
  d.audio = res.audio;
  d.lyrics = res.lyrics;
  renderBasics(s, true);
  renderAudio(s);
  notesChanged(s);
  s.app.toast(`앞 공백 ${fmtClock(-res.shift, 2)}을 지웠어요.${d.audio ? ' 반주 음원 위치도 함께 옮겼어요.' : ''}`);
}

async function toolClear(s) {
  if (!requireNotes(s)) return;
  const ok = await confirmDialog({
    title: '노트를 모두 지울까요?',
    message: `노트 ${s.draft.notes.length}개를 지워요. 「되돌리기」로 다시 살릴 수 있어요.`,
    okText: '모두 지우기',
    cancelText: '취소',
    danger: true,
  });
  if (!ok || s.disposed) return;
  pushUndo(s, '모두 지우기');
  s.draft.notes = [];
  notesChanged(s);
}

function openTempoDialog(s) {
  if (!requireNotes(s)) return;
  const d = s.draft;
  const input = el('input', {
    type: 'number', class: 'ed-input ed-num', min: 30, max: 300, step: 1, inputmode: 'decimal', value: d.bpm,
    'aria-label': '새 BPM',
  });
  const info = el('p', { class: 'muted' });
  const update = () => {
    const v = parseNum(input.value);
    if (!(v >= 30 && v <= 300)) {
      info.textContent = 'BPM은 30~300 사이로 입력해 주세요.';
      return;
    }
    const f = d.bpm / v;
    const dur = songDuration({ ...d, lyrics: { ...d.lyrics, lines: [] } });
    info.textContent = `길이 ${fmtClock(dur)} → ${fmtClock(dur * f)} (${f > 1 ? '느려져요' : f < 1 ? '빨라져요' : '그대로'})`;
  };
  input.addEventListener('input', update);
  update();
  let m = null;
  const apply = () => {
    const v = parseNum(input.value);
    if (!(v >= 30 && v <= 300)) {
      s.app.toast('BPM은 30~300 사이로 입력해 주세요.', 'error');
      return;
    }
    if (v === d.bpm) {
      m.close();
      return;
    }
    pushUndo(s, '빠르기 바꾸기', { basics: true });
    const res = scaleTempo(d, Math.round(v * 100) / 100);
    d.bpm = res.bpm;
    d.offset = res.offset;
    d.notes = res.notes;
    d.lyrics = res.lyrics;
    m.close();
    renderBasics(s, true);
    notesChanged(s);
    s.app.toast(`빠르기를 BPM ${d.bpm}(으)로 바꿨어요.`, 'success');
  };
  m = openModal(s, {
    title: '빠르기 바꾸기',
    content: el('div', { class: 'ed-dialog' },
      el('p', null, `지금 BPM ${d.bpm}. 노트·첫 박 위치·LRC 가사 시간을 새 빠르기에 맞춰 늘이거나 줄여요. 반주 음원은 바뀌지 않아요.`),
      el('label', { class: 'ed-field' }, el('span', { class: 'ed-label' }, '새 BPM'), input),
      info,
      el('div', { class: 'ed-modal-actions' },
        btn('취소', () => m.close(), 'ghost'),
        btn('적용', apply, 'primary'),
      ),
    ),
  });
}

function openQuantizeDialog(s) {
  if (!requireNotes(s)) return;
  let division = 4;
  let m = null;
  const apply = () => {
    pushUndo(s, '박자 맞춤');
    s.draft.notes = quantizeNotes(s.draft.notes, s.draft.bpm, s.draft.offset, division);
    m.close();
    notesChanged(s);
    s.app.toast(`노트를 ${division === 2 ? '8분' : division === 4 ? '16분' : '4분'}음표 격자에 맞췄어요.`, 'success');
  };
  m = openModal(s, {
    title: '박자 맞춤 (양자화)',
    content: el('div', { class: 'ed-dialog' },
      el('p', null, `노트 시작을 BPM ${s.draft.bpm}·첫 박 ${s.draft.offset}초 기준의 격자에 맞춰요. BPM과 첫 박 위치가 곡과 맞아야 해요.`),
      seg([
        { value: 1, label: '4분음표' },
        { value: 2, label: '8분음표' },
        { value: 4, label: '16분음표' },
      ], division, (v) => { division = Number(v); }, '격자'),
      el('div', { class: 'ed-modal-actions' },
        btn('취소', () => m.close(), 'ghost'),
        btn('맞추기', apply, 'primary'),
      ),
    ),
  });
}

// --- 텍스트 입력 --------------------------------------------------------------

function showNotationErrors(s, errors, onForce) {
  const box = s.ui.notationErrs;
  if (!errors.length) {
    box.hidden = true;
    fill(box);
    return;
  }
  const shown = errors.slice(0, 12);
  fill(box,
    el('div', { class: 'ed-errbox-title' }, `알아볼 수 없는 부분이 ${errors.length}개 있어요`),
    el('ul', null, shown.map((e) => el('li', null, e)), errors.length > shown.length ? el('li', null, `… 외 ${errors.length - shown.length}개`) : null),
    onForce ? btn('오류는 건너뛰고 적용', onForce, 'small') : null,
  );
  box.hidden = false;
}

function applyNotation(s, mode, force = false) {
  const text = s.ui.notation.value;
  s.notationText = text;
  if (!text.trim()) {
    s.app.toast('입력한 음이 없어요.');
    return;
  }
  const d = s.draft;
  if (s.errors.bpm || s.errors.offset) {
    s.app.toast('기본 정보의 BPM·첫 박 위치를 먼저 고쳐 주세요.', 'error');
    return;
  }
  const base = mode === 'append' ? appendStartTime(d.notes, d) : gridStart(d.offset, d.bpm, d.beatsPerBar);
  let res;
  try {
    res = parseNotation(text, { bpm: d.bpm, offset: base });
  } catch (err) {
    console.error(err);
    s.app.toast('텍스트를 해석하지 못했어요.', 'error');
    return;
  }
  const errors = res.errors || [];
  if (errors.length && !force) {
    showNotationErrors(s, errors, () => applyNotation(s, mode, true));
    return;
  }
  showNotationErrors(s, errors, null);
  if (!res.notes.length) {
    s.app.toast('적용할 음이 없어요.', 'error');
    return;
  }
  pushUndo(s, mode === 'append' ? '텍스트 뒤에 추가' : '텍스트 적용');
  d.notes = mode === 'append' ? sortNotes([...d.notes, ...res.notes]) : res.notes;
  notesChanged(s);
  s.app.toast(`노트 ${res.notes.length}개를 ${mode === 'append' ? '뒤에 추가했어요' : '적용했어요'}.`, 'success');
}

async function notesToText(s) {
  if (!requireNotes(s)) return;
  const d = s.draft;
  const cur = s.ui.notation.value.trim();
  if (cur) {
    const ok = await confirmDialog({
      title: '입력 칸을 바꿀까요?',
      message: '지금 입력 칸에 있는 내용을 현재 노트로 바꿔요.',
      okText: '바꾸기',
      cancelText: '취소',
    });
    if (!ok || s.disposed) return;
  }
  let text = '';
  try {
    text = notesToNotation(d.notes, { bpm: d.bpm, offset: gridStart(d.offset, d.bpm, d.beatsPerBar), beatsPerBar: d.beatsPerBar });
  } catch (err) {
    console.error(err);
    s.app.toast('노트를 텍스트로 바꾸지 못했어요.', 'error');
    return;
  }
  s.ui.notation.value = text;
  s.notationText = text;
  s.ui.notationBox.open = true;
  showNotationErrors(s, [], null);
  s.app.toast('박자는 1/4박 단위로 반올림돼요. 고친 뒤 「적용」을 누르세요.');
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

function refreshLyrics(s) {
  const lyr = s.draft.lyrics;
  if (lyr.source === 'lrc') {
    s.lyricResult = { lines: lyr.lines || [], warnings: [], stats: null };
    return;
  }
  const text = lyr.text || '';
  if (!text.trim()) {
    s.lyricResult = null;
    return;
  }
  try {
    s.lyricResult = assignLyrics(text, s.draft.notes);
  } catch (err) {
    console.error(err);
    s.lyricResult = { lines: [], warnings: ['가사를 처리하지 못했어요. 특수 문자를 확인해 주세요.'], stats: null };
  }
}

function onLyricsInput(s, value) {
  if (s.draft.lyrics.source === 'lrc') return;
  s.draft.lyrics.text = value;
  markDirty(s);
  s.ui.pasteBanner.hidden = !looksLikeLrc(value);
  clearTimeout(s.lyricTimer);
  s.lyricTimer = setTimeout(() => {
    if (s.disposed) return;
    refreshLyrics(s);
    renderLyricPreview(s);
    scheduleRoll(s);
  }, 250);
}

function renderLyrics(s, forceText = false) {
  const { ui } = s;
  const lyr = s.draft.lyrics;
  const isLrc = lyr.source === 'lrc';
  const text = lyr.text || '';
  if ((forceText || document.activeElement !== ui.lyrics) && ui.lyrics.value !== text) ui.lyrics.value = text;
  ui.lyrics.readOnly = isLrc;
  ui.lyrics.classList.toggle('readonly', isLrc);
  ui.lrcBanner.hidden = !isLrc;
  ui.pasteBanner.hidden = isLrc || !looksLikeLrc(ui.lyrics.value);
  ui.lyricSource.textContent = isLrc ? 'LRC 시간' : '노트 기준';
  ui.lyricSource.classList.toggle('lrc', isLrc);
  renderLyricPreview(s);
}

function renderLyricPreview(s) {
  const { ui } = s;
  const r = s.lyricResult;
  const lines = currentLines(s);
  if (!r) {
    ui.lyricStats.textContent = s.draft.notes.length
      ? '가사를 입력하면 노트에 맞춰 자동으로 배치해 미리 보여줘요.'
      : '가사는 노트가 있어야 시간에 맞게 배치돼요.';
    ui.lyricWarn.hidden = true;
    fill(ui.lyricWarn);
    ui.lyricPreviewBox.hidden = true;
    fill(ui.lyricPreview);
    return;
  }
  if (r.stats) {
    ui.lyricStats.textContent = `가사 ${lines.length}줄 · 음절 ${r.stats.syllables}개 · 노트 ${r.stats.events}개 (동시에 치는 화음은 1개)`;
  } else {
    ui.lyricStats.textContent = `가사 ${lines.length}줄 · LRC 시간 사용`;
  }
  const warnings = r.warnings || [];
  ui.lyricWarn.hidden = warnings.length === 0;
  fill(ui.lyricWarn, ...warnings.map((w) => el('li', null, `⚠ ${w}`)));

  ui.lyricPreviewBox.hidden = lines.length === 0;
  fill(ui.lyricPreview, ...lines.map((line) => {
    const t = line.syllables.length ? lineStart(line) : NaN;
    const text = line.syllables.map((y) => y.text).join('');
    return el('li', null,
      el('span', { class: 'ed-lt' }, fmtClock(t, 1)),
      el('span', { class: 'ed-ltext' }, text || ' '));
  }));
}

function autoPlaceLyrics(s) {
  const lyr = s.draft.lyrics;
  const text = s.ui.lyrics.value;
  if (!text.trim()) {
    s.app.toast('가사를 먼저 입력해 주세요.');
    s.ui.lyrics.focus();
    return;
  }
  if (lyr.source === 'lrc') {
    switchToNotes(s);
    return;
  }
  lyr.text = text;
  refreshLyrics(s);
  renderLyrics(s);
  scheduleRoll(s);
  markDirty(s);
  const r = s.lyricResult;
  if (!s.draft.notes.length) {
    s.app.toast('노트가 없어서 임시 시간으로 배치했어요. 멜로디를 만든 뒤 다시 눌러 주세요.', 'error');
  } else if (r && r.warnings && r.warnings.length) {
    s.app.toast(r.warnings[0], 'error');
  } else {
    s.app.toast(`가사 ${currentLines(s).length}줄을 노트에 딱 맞게 배치했어요.`, 'success');
  }
  s.ui.lyricPreviewBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function switchToNotes(s) {
  pushUndo(s, '노트 기준으로 바꾸기');
  const lyr = s.draft.lyrics;
  s.draft.lyrics = { text: lyr.text || lyricsPlainText(lyr.lines || []), source: 'notes', lines: [] };
  refreshLyrics(s);
  renderLyrics(s, true);
  scheduleRoll(s);
  markDirty(s);
  s.app.toast('이제 가사가 노트 순서에 맞춰 배치돼요. 가사를 고칠 수 있어요.');
}

async function fillSolfege(s) {
  if (!requireNotes(s)) return;
  const cur = s.ui.lyrics.value.trim();
  if (cur) {
    const ok = await confirmDialog({
      title: '가사를 계이름으로 바꿀까요?',
      message: '지금 가사를 지우고 노트의 계이름(도레미)으로 채워요. 「되돌리기」로 되살릴 수 있어요.',
      okText: '계이름으로 채우기',
      cancelText: '취소',
    });
    if (!ok || s.disposed) return;
  }
  pushUndo(s, '계이름으로 채우기');
  s.draft.lyrics = { text: solfegeLyricText(s.draft.notes), source: 'notes', lines: [] };
  refreshLyrics(s);
  renderLyrics(s, true);
  scheduleRoll(s);
  markDirty(s);
  s.app.toast('노트의 계이름으로 가사를 채웠어요.', 'success');
}

function applyLrcText(s, text, label = 'LRC 가져오기') {
  let res;
  try {
    res = parseLRC(String(text || ''));
  } catch (err) {
    console.error(err);
    s.app.toast('LRC 가사를 읽지 못했어요.', 'error');
    return false;
  }
  const lines = (res.lines || []).filter((l) => l.syllables && l.syllables.length);
  if (!lines.length) {
    s.app.toast('시간이 붙은 가사 줄을 찾지 못했어요. [00:12.34] 형식인지 확인해 주세요.', 'error');
    return false;
  }
  const d = s.draft;
  pushUndo(s, label, { basics: true });
  d.lyrics = { text: lyricsPlainText(lines), source: 'lrc', lines };
  const meta = res.meta || {};
  if (!d.title.trim() && meta.ti) d.title = String(meta.ti).trim();
  if (!String(d.artist || '').trim() && meta.ar) d.artist = String(meta.ar).trim();
  refreshLyrics(s);
  renderBasics(s, true);
  renderHeader(s);
  renderLyrics(s, true);
  scheduleRoll(s);
  markDirty(s);
  s.app.toast(`LRC 가사 ${lines.length}줄을 가져왔어요.${res.wordTimed ? '' : ' 줄 안의 글자는 고르게 나눴어요.'}`, 'success');
  return true;
}

async function importLrc(s) {
  // 안드로이드는 .lrc 확장자를 모르는 경우가 많아 모든 파일을 허용하고 내용으로 확인한다.
  const file = await pickFile('');
  if (!file || s.disposed) return;
  if (file.size > 2 * 1024 * 1024) {
    s.app.toast('가사 파일이 너무 커요.', 'error');
    return;
  }
  let text = '';
  try {
    text = await file.text();
  } catch (err) {
    console.error(err);
    s.app.toast('파일을 읽지 못했어요.', 'error');
    return;
  }
  if (s.disposed) return;
  if (s.draft.lyrics.text && s.draft.lyrics.text.trim()) {
    const ok = await confirmDialog({
      title: 'LRC로 가사를 바꿀까요?',
      message: '지금 가사를 LRC 파일의 가사와 시간으로 바꿔요. 「되돌리기」로 되살릴 수 있어요.',
      okText: '가져오기',
      cancelText: '취소',
    });
    if (!ok || s.disposed) return;
  }
  applyLrcText(s, text, 'LRC 가져오기');
}

function exportLrc(s) {
  refreshLyrics(s);
  const lines = currentLines(s);
  if (!lines.length) {
    s.app.toast('내보낼 가사가 없어요.');
    return;
  }
  try {
    const d = s.draft;
    const text = toLRC(lines, { ti: d.title.trim() || undefined, ar: String(d.artist || '').trim() || undefined });
    downloadFile(`${fileBase(d.title)}.lrc`, text, 'text/plain');
    s.app.toast('LRC 파일을 내보냈어요.', 'success');
  } catch (err) {
    console.error(err);
    s.app.toast('LRC 파일을 만들지 못했어요.', 'error');
  }
}

// ---------------------------------------------------------------------------
// Backing audio
// ---------------------------------------------------------------------------

function setupAudioEl(s, blob) {
  disposeAudioEl(s);
  s.audioUrl = URL.createObjectURL(blob);
  const a = new Audio();
  a.preload = 'metadata';
  s.audioEl = a;
  s.audioDuration = NaN;
  a.addEventListener('loadedmetadata', () => {
    if (s.audioEl !== a) return;
    s.audioDuration = a.duration;
    renderAudioMeta(s);
  });
  a.addEventListener('play', () => renderAudioPlay(s));
  a.addEventListener('pause', () => renderAudioPlay(s));
  a.addEventListener('ended', () => renderAudioPlay(s));
  a.src = s.audioUrl;
}

function disposeAudioEl(s) {
  const a = s.audioEl;
  s.audioEl = null;
  if (a) {
    try {
      a.pause();
      a.removeAttribute('src');
      a.load();
    } catch {
      // ignore
    }
  }
  if (s.audioUrl) {
    URL.revokeObjectURL(s.audioUrl);
    s.audioUrl = '';
  }
}

function probeAudio(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { a.removeAttribute('src'); a.load(); } catch { /* ignore */ }
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(true), 8000);
    a.preload = 'metadata';
    a.addEventListener('loadedmetadata', () => finish(true), { once: true });
    a.addEventListener('error', () => finish(false), { once: true });
    a.src = url;
  });
}

async function pickAudio(s) {
  const file = await pickFile('audio/*');
  if (!file || s.disposed) return;
  const looksAudio = /^audio\//.test(file.type) || /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|mp4)$/i.test(file.name);
  if (!looksAudio) {
    s.app.toast('오디오 파일만 쓸 수 있어요.', 'error');
    return;
  }
  const ok = await probeAudio(file);
  if (s.disposed) return;
  if (!ok) {
    s.app.toast('이 브라우저에서 재생할 수 없는 음원 형식이에요. MP3나 M4A로 바꿔 보세요.', 'error');
    return;
  }
  const prev = s.draft.audio;
  s.audioBlob = file;
  s.audioChanged = true;
  s.audioMissing = false;
  s.draft.audio = {
    name: file.name || '음원',
    offset: prev && Number.isFinite(prev.offset) ? prev.offset : 0,
    volume: prev && Number.isFinite(prev.volume) ? prev.volume : 0.8,
  };
  setupAudioEl(s, file);
  markDirty(s);
  renderAudio(s);
  scheduleRoll(s);
  s.app.toast(file.size > 40 * 1024 * 1024
    ? '음원을 넣었어요. 파일이 커서 저장에 시간이 걸릴 수 있어요.'
    : '음원을 넣었어요. 오프셋을 맞춘 뒤 미리듣기로 확인해 보세요.', 'success');
}

async function removeAudio(s) {
  const ok = await confirmDialog({
    title: '반주 음원을 뺄까요?',
    message: '저장하면 이 기기에 보관된 음원 파일도 지워져요.',
    okText: '빼기',
    cancelText: '취소',
    danger: true,
  });
  if (!ok || s.disposed) return;
  disposeAudioEl(s);
  s.audioBlob = null;
  s.audioChanged = true;
  s.audioMissing = false;
  s.draft.audio = null;
  markDirty(s);
  renderAudio(s);
  scheduleRoll(s);
}

function setAudioOffset(s, v, { updateInput = true } = {}) {
  if (!s.draft.audio || !Number.isFinite(v)) return;
  s.draft.audio.offset = round3(clamp(v, -3600, 3600));
  if (updateInput && s.ui.audioOffset) s.ui.audioOffset.value = String(s.draft.audio.offset);
  markDirty(s);
  scheduleRoll(s);
}

function renderAudioMeta(s) {
  const node = s.ui.audioMeta;
  if (!node || !s.audioBlob) return;
  const dur = Number.isFinite(s.audioDuration) ? fmtClock(s.audioDuration) : '길이 확인 중…';
  node.textContent = `${fmtSize(s.audioBlob.size)} · ${dur}`;
}

function renderAudioPlay(s) {
  const b = s.ui.audioPlayBtn;
  if (!b) return;
  const playing = Boolean(s.audioEl && !s.audioEl.paused && !s.audioEl.ended);
  b.textContent = playing ? '■ 정지' : '▶ 들어보기';
}

function toggleAudioPlay(s) {
  const a = s.audioEl;
  if (!a) return;
  if (!a.paused) {
    a.pause();
    return;
  }
  a.volume = clamp(s.draft.audio ? s.draft.audio.volume : 0.8, 0, 1);
  try { a.currentTime = 0; } catch { /* metadata not ready */ }
  a.play().catch((err) => {
    console.error(err);
    s.app.toast('음원을 재생하지 못했어요.', 'error');
  });
}

function renderAudio(s) {
  const { ui } = s;
  const box = ui.audioBody;
  const a = s.draft.audio;
  ui.audioOffset = null;
  ui.audioMeta = null;
  ui.audioPlayBtn = null;
  if (!a) {
    fill(box,
      btn('🎵 음원 파일 선택', () => pickAudio(s), 'primary'),
      el('p', { class: 'ed-hint muted' }, 'MP3·M4A·WAV·OGG 파일을 쓸 수 있어요.'),
    );
    return;
  }
  if (s.audioMissing || !s.audioBlob) {
    fill(box,
      el('div', { class: 'ed-banner warn' }, `저장된 음원 파일("${a.name}")을 이 기기에서 찾을 수 없어요. 다시 선택해 주세요.`),
      el('div', { class: 'ed-row' },
        btn('다시 선택', () => pickAudio(s), 'primary small'),
        btn('빼기', () => removeAudio(s), 'small ghost danger'),
      ),
    );
    return;
  }

  ui.audioMeta = el('span', { class: 'muted' });
  ui.audioOffset = el('input', {
    type: 'number', class: 'ed-input ed-num', step: 0.01, inputmode: 'decimal', value: a.offset, 'aria-label': '음원 오프셋(초)',
    onInput: (e) => {
      const v = parseNum(e.target.value);
      if (Number.isFinite(v)) setAudioOffset(s, v, { updateInput: false });
    },
  });
  const nudge = (dv) => setAudioOffset(s, (s.draft.audio ? s.draft.audio.offset : 0) + dv);
  const volLabel = el('span', { class: 'ed-val' }, `${Math.round(a.volume * 100)}%`);
  const vol = el('input', {
    type: 'range', min: 0, max: 1, step: 0.05, value: a.volume, 'aria-label': '반주 음량',
    onInput: (e) => {
      const v = clamp(Number(e.target.value), 0, 1);
      if (!s.draft.audio) return;
      s.draft.audio.volume = v;
      volLabel.textContent = `${Math.round(v * 100)}%`;
      if (s.audioEl) s.audioEl.volume = v;
      markDirty(s);
    },
  });
  syncRange(vol);
  ui.audioPlayBtn = btn('▶ 들어보기', () => toggleAudioPlay(s), 'small');

  fill(box,
    el('div', { class: 'ed-audio-file' }, el('span', { class: 'ed-audio-icon', 'aria-hidden': 'true' }, '🎵'),
      el('div', { class: 'ed-audio-name' }, el('b', null, a.name), ui.audioMeta)),
    el('div', { class: 'ed-field' },
      el('label', { class: 'ed-label' }, '오프셋 (음원이 시작되는 곡 시간, 초)'),
      el('div', { class: 'ed-stepper ed-stepper-wide' },
        btn('−0.1', () => nudge(-0.1), 'small'),
        btn('−0.01', () => nudge(-0.01), 'small'),
        ui.audioOffset,
        btn('+0.01', () => nudge(0.01), 'small'),
        btn('+0.1', () => nudge(0.1), 'small'),
        btn('±', () => setAudioOffset(s, -(s.draft.audio ? s.draft.audio.offset : 0)), 'small ghost', { title: '부호 바꾸기', 'aria-label': '부호 바꾸기' }),
      ),
      el('div', { class: 'ed-hint muted' },
        '음원의 0초가 곡의 몇 초에 재생될지예요. 전주가 5초 있고 첫 노트가 0초라면 −5처럼 음수가 돼요.'),
    ),
    el('div', { class: 'ed-row' },
      btn('🎯 첫 음에서 탭해서 맞추기', () => openAlign(s), 'small', { title: '음원을 들으며 멜로디 첫 음에서 탭하면 오프셋을 계산해요' }),
    ),
    el('div', { class: 'ed-field' },
      el('label', { class: 'ed-label' }, '음량 ', volLabel),
      vol,
    ),
    el('div', { class: 'ed-row' },
      ui.audioPlayBtn,
      btn('교체', () => pickAudio(s), 'small'),
      btn('빼기', () => removeAudio(s), 'small ghost danger'),
    ),
  );
  renderAudioMeta(s);
  renderAudioPlay(s);
}

function openAlign(s) {
  if (!requireNotes(s)) return;
  const a = s.audioEl;
  if (!a) return;
  const firstT = s.draft.notes[0].t;
  let phase = 'idle';
  let m = null;
  const timeLabel = el('div', { class: 'ed-align-time' }, '0:00.0');
  const onTime = () => { timeLabel.textContent = fmtClock(a.currentTime, 1); };
  const big = btn('▶ 음원 재생', () => {
    if (phase === 'idle') {
      phase = 'playing';
      a.volume = clamp(s.draft.audio ? s.draft.audio.volume : 0.8, 0, 1);
      try { a.currentTime = 0; } catch { /* ignore */ }
      a.play().catch((err) => {
        console.error(err);
        s.app.toast('음원을 재생하지 못했어요.', 'error');
        m.close();
      });
      big.textContent = '지금! (첫 음)';
      big.classList.add('ed-align-now');
      return;
    }
    const at = a.currentTime;
    a.pause();
    pushUndo(s, '음원 오프셋 맞추기');
    setAudioOffset(s, Math.round((firstT - at) * 100) / 100);
    m.close();
    s.app.toast(`오프셋을 ${s.draft.audio.offset}초로 맞췄어요. 미리듣기로 확인하고 ±로 다듬어 보세요.`, 'success');
  }, 'primary big ed-align-btn');
  a.addEventListener('timeupdate', onTime);
  m = openModal(s, {
    title: '첫 음에서 탭해서 맞추기',
    content: el('div', { class: 'ed-dialog' },
      el('p', null, '음원을 처음부터 재생해요. 멜로디의 첫 음이 들리는 순간 큰 버튼을 누르세요. '
        + `그 순간이 첫 노트(${fmtClock(firstT, 2)})와 맞도록 오프셋을 계산해요.`),
      timeLabel,
      big,
      el('div', { class: 'ed-modal-actions' }, btn('취소', () => m.close(), 'ghost')),
    ),
    onClose: () => {
      a.removeEventListener('timeupdate', onTime);
      if (!a.paused) a.pause();
    },
  });
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------

function openModal(s, { title, content, dismissible = true, onClose, className = '' }) {
  let closed = false;
  let handle = null;
  const api = {
    el: null,
    close() {
      if (closed) return;
      finish();
      try { if (handle) handle.close(); } catch (err) { console.error(err); }
    },
  };
  function finish() {
    if (closed) return;
    closed = true;
    s.modals.delete(api);
    if (onClose) {
      try { onClose(); } catch (err) { console.error(err); }
    }
  }
  s.modals.add(api);
  handle = modal({ title, content, actions: [], dismissible, onClose: finish, className: `ed-modal ${className}`.trim() });
  api.el = handle ? handle.el : null;
  return api;
}

function choose(s, { title, message, options }) {
  return new Promise((resolve) => {
    let m = null;
    let result = null;
    m = openModal(s, {
      title,
      content: el('div', { class: 'ed-dialog' },
        message ? el('p', null, message) : null,
        el('div', { class: 'ed-choice' }, options.map((o) => btn(o.label, () => {
          result = o.value;
          m.close();
        }, o.cls || ''))),
      ),
      onClose: () => resolve(result),
    });
  });
}

// ---------------------------------------------------------------------------
// Score file import (MIDI / MusicXML)
// ---------------------------------------------------------------------------

/** 파일 이름에서 확장자를 뺀 제목. */
function fileTitle(name) {
  return String(name || '').replace(/\.(mid|midi|kar|rmi|musicxml|xml|mxl)$/i, '').trim();
}

async function openScoreImport(s) {
  const file = await pickFile(SCORE_ACCEPT);
  if (!file || s.disposed) return;
  if (file.size > MAX_SCORE_BYTES) {
    s.app.toast('파일이 너무 커요. MIDI나 MusicXML 악보 파일인지 확인해 주세요.', 'error');
    return;
  }
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    console.error(err);
    s.app.toast('파일을 읽지 못했어요.', 'error');
    return;
  }
  if (s.disposed) return;
  const kind = detectScoreFileKind(bytes, file.name);
  if (kind === 'midi') {
    if (bytes.length > MAX_MIDI_BYTES) {
      s.app.toast('MIDI 파일이 너무 커요.', 'error');
      return;
    }
    openMidiImport(s, file, bytes);
  } else if (kind === 'musicxml') {
    await openMusicXmlImport(s, file, bytes);
  } else if (kind === 'pdf' || kind === 'image') {
    s.app.toast('PDF·사진 악보는 바로 가져올 수 없어요. MuseScore 같은 프로그램으로 MusicXML(.mxl)로 바꾼 뒤 가져오거나 '
      + '「악보 보고 입력」을 써 주세요.', { type: 'error', duration: 7000 });
  } else if (kind === 'json') {
    s.app.toast('곡 파일(.json)은 위쪽의 「JSON 가져오기」로 불러와 주세요.', 'error');
  } else {
    s.app.toast('MIDI(.mid)나 MusicXML(.musicxml·.mxl) 악보 파일만 가져올 수 있어요.', 'error');
  }
}

// ---------------------------------------------------------------------------
// MIDI import
// ---------------------------------------------------------------------------

function openMidiImport(s, file, bytes) {
  let parsed;
  try {
    parsed = parseMidi(bytes);
  } catch (err) {
    console.error(err);
    s.app.toast(err && err.message ? err.message : 'MIDI 파일을 읽지 못했어요.', 'error');
    return;
  }
  const tracks = midiTracksSummary(parsed).filter((t) => t.count > 0);
  if (!tracks.length) {
    s.app.toast('MIDI 파일에 음표가 없어요.', 'error');
    return;
  }
  const byIndex = new Map(parsed.tracks.map((t) => [t.index, t]));
  const recIdx = recommendMelodyTrack(tracks);
  const st = {
    sel: new Set(recIdx >= 0 ? [recIdx] : []),
    skyline: true,
    transpose: 0,
    tempo: true,
    playing: -1,
  };
  const playBtns = new Map();

  const collect = () => {
    let notes = [];
    for (const idx of st.sel) {
      const tr = byIndex.get(idx);
      if (tr) for (const n of tr.notes) notes.push({ ...n });
    }
    sortNotes(notes);
    if (st.skyline && notes.length) notes = extractMelody(notes);
    return notes;
  };

  const resetPlayButtons = () => {
    st.playing = -1;
    for (const b of playBtns.values()) b.textContent = '▶';
  };
  const stopPreview = () => {
    if (st.playing >= 0) stopPlayer(s);
    resetPlayButtons();
  };
  const togglePreview = async (idx) => {
    if (st.playing === idx) {
      stopPreview();
      return;
    }
    const tr = byIndex.get(idx);
    if (!tr || !tr.notes.length) return;
    try {
      const notes = st.skyline ? extractMelody(sortNotes(tr.notes.map((n) => ({ ...n })))) : tr.notes;
      const started = await playNotes(s, transposeNotes(notes, st.transpose), {
        maxSec: 12,
        onEnd: () => { if (st.playing === idx) resetPlayButtons(); },
      });
      if (!started || s.disposed) return;
      resetPlayButtons();
      st.playing = idx;
      const b = playBtns.get(idx);
      if (b) b.textContent = '■';
    } catch (err) {
      console.error(err);
      stopPreview();
    }
  };

  const summary = el('div', { class: 'ed-midi-summary' });
  const applyBtn = btn('가져오기', () => apply(), 'primary');
  const transLabel = el('span', { class: 'ed-val' });
  const update = () => {
    const raw = [...st.sel].reduce((acc, idx) => acc + ((byIndex.get(idx) || { notes: [] }).notes.length), 0);
    const out = collect().length;
    summary.textContent = st.sel.size
      ? `선택한 트랙 노트 ${raw}개 → 가져올 노트 ${out}개${s.draft.notes.length ? ` (지금 노트 ${s.draft.notes.length}개를 바꿔요)` : ''}`
      : '가져올 트랙을 선택해 주세요.';
    applyBtn.disabled = st.sel.size === 0 || out === 0;
    transLabel.textContent = st.transpose === 0 ? '그대로' : `${st.transpose > 0 ? '+' : ''}${st.transpose} 반음`;
  };

  const rows = tracks.map((t) => {
    const cb = el('input', {
      type: 'checkbox', checked: st.sel.has(t.index),
      onChange: (e) => {
        if (e.target.checked) st.sel.add(t.index);
        else st.sel.delete(t.index);
        update();
      },
    });
    const play = el('button', {
      class: 'btn small ghost ed-track-play', type: 'button', 'aria-label': '들어보기', title: '앞부분 들어보기',
      onClick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePreview(t.index);
      },
    }, '▶');
    playBtns.set(t.index, play);
    const ch = Number.isFinite(t.channel) ? ` · 채널 ${t.channel}` : '';
    return el('label', { class: `ed-track${t.isDrum ? ' drum' : ''}` },
      cb,
      el('span', { class: 'ed-track-main' },
        el('span', { class: 'ed-track-name' },
          t.name || `트랙 ${t.index + 1}`,
          t.index === recIdx ? el('span', { class: 'badge ed-badge-rec' }, '추천') : null,
          t.isDrum ? el('span', { class: 'badge' }, '드럼') : null),
        el('span', { class: 'ed-track-meta muted' }, `노트 ${t.count}개 · ${rangeText(t.min, t.max)}${ch}`)),
      play);
  });

  const ts = parsed.timeSignature || { num: 4, den: 4 };
  const midiBpm = Math.round((Number(parsed.bpm) || 120) * 100) / 100;
  const content = el('div', { class: 'ed-dialog ed-midi' },
    el('p', { class: 'muted' }, `${file.name} · BPM ${midiBpm} · ${ts.num}/${ts.den} · 길이 ${fmtClock(parsed.duration || 0)}`),
    el('div', { class: 'ed-label' }, '트랙 선택 (멜로디가 들어 있는 트랙)'),
    el('div', { class: 'ed-tracks' }, rows),
    el('label', { class: 'ed-check' },
      checkbox(st.skyline, (v) => { st.skyline = v; update(); }),
      el('span', null, '멜로디만 추출 ', el('span', { class: 'muted' }, '(화음에서 가장 높은 음만 남겨요)'))),
    el('div', { class: 'ed-check' },
      el('span', null, '이조'),
      el('div', { class: 'ed-stepper' },
        btn('−', () => { st.transpose = Math.max(-12, st.transpose - 1); update(); }, 'small', { 'aria-label': '반음 내리기' }),
        transLabel,
        btn('+', () => { st.transpose = Math.min(12, st.transpose + 1); update(); }, 'small', { 'aria-label': '반음 올리기' }),
      )),
    el('label', { class: 'ed-check' },
      checkbox(st.tempo, (v) => { st.tempo = v; }),
      el('span', null, `BPM·박자도 가져오기 (BPM ${midiBpm}, ${ts.num}/${ts.den})`)),
    summary,
    el('div', { class: 'ed-modal-actions' }, btn('취소', () => m.close(), 'ghost'), applyBtn),
  );

  const apply = () => {
    let notes = collect();
    if (!notes.length) return;
    notes = transposeNotes(notes, st.transpose).map((n) => ({
      t: round3(Math.max(0, n.t)), d: Math.max(0.05, round3(n.d)), m: n.m, v: Number.isFinite(n.v) ? n.v : 0.8,
    }));
    const d = s.draft;
    pushUndo(s, 'MIDI 가져오기', { basics: true });
    d.notes = sortNotes(notes);
    if (st.tempo) {
      d.bpm = clamp(midiBpm, 30, 300);
      d.beatsPerBar = clamp(Math.round(Number(ts.num) || 4), 1, 16);
      d.offset = 0;
    }
    if (!d.title.trim()) d.title = fileTitle(file.name).slice(0, 100);
    m.close();
    renderBasics(s, true);
    renderHeader(s);
    notesChanged(s);
    s.app.toast(`MIDI에서 노트 ${notes.length}개를 가져왔어요.`, 'success');
  };

  update();
  const m = openModal(s, { title: 'MIDI 가져오기', content, onClose: stopPreview, className: 'wide' });
}

// ---------------------------------------------------------------------------
// MusicXML import
// ---------------------------------------------------------------------------

let musicXmlLoading = null;

/** MusicXML 파서는 처음 쓸 때만 불러온다. */
function loadMusicXml() {
  if (!musicXmlLoading) {
    musicXmlLoading = import('../core/musicxml.js').catch((err) => {
      musicXmlLoading = null;
      throw err;
    });
  }
  return musicXmlLoading;
}

function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });
}

async function openMusicXmlImport(s, file, bytes) {
  const busy = s.app.toast('악보 파일을 읽는 중…', { type: 'info', duration: 60000 });
  const endBusy = () => {
    try { if (busy && typeof busy.close === 'function') busy.close(); } catch { /* ignore */ }
  };
  let mx;
  try {
    mx = await loadMusicXml();
  } catch (err) {
    console.error(err);
    endBusy();
    if (!s.disposed) s.app.toast('악보 파일 기능을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.', 'error');
    return;
  }
  let score;
  try {
    const text = await mx.readScoreText(bytes);
    if (s.disposed) return;
    await nextFrame(); // '읽는 중' 안내가 먼저 보이도록
    score = mx.parseMusicXml(text);
  } catch (err) {
    console.error(err);
    if (!s.disposed) s.app.toast(err && err.message ? err.message : '악보 파일을 읽지 못했어요.', 'error');
    return;
  } finally {
    endBusy();
  }
  if (s.disposed || !score) return;

  const parts = Array.isArray(score.parts) ? score.parts : [];
  const tracks = [];
  for (const p of parts) for (const t of (p && p.tracks) || []) if (t && t.noteCount > 0) tracks.push(t);
  if (!tracks.length) {
    s.app.toast('악보에서 음표를 찾지 못했어요.', 'error');
    return;
  }
  const trackOf = (key) => tracks.find((t) => t.key === key) || tracks[0];
  const versesOf = (key) => {
    const part = parts.find((p) => p && p.id === trackOf(key).partId);
    return [...new Set(((part && part.verses) || []).map(Number).filter((v) => Number.isInteger(v) && v > 0))]
      .sort((a, b) => a - b);
  };
  let recKey = null;
  try {
    recKey = mx.recommendTrack(score);
  } catch (err) {
    console.error(err);
  }
  if (!tracks.some((t) => t.key === recKey)) recKey = tracks[0].key;

  const scoreTempo = Number(score.tempo);
  const ts = score.timeSignature && score.timeSignature.num ? score.timeSignature : { num: 4, den: 4 };
  // 앱의 BPM은 박자표 아래 숫자 음표 기준(6/8 → 8분음표)일 수 있어 악보의 4분음표 빠르기와 다를 수 있다.
  // 기본 변환 결과의 BPM을 기준값으로 삼아야 바꾼 값이 같은 단위로 전달된다.
  let baseBpm = scoreTempo > 0 ? clamp(Math.round(scoreTempo * 100) / 100, 30, 300) : 100;
  let beatUnit = 4;
  try {
    const first = mx.scoreToSong(score, { trackKey: recKey, includeLyrics: false });
    if (first && Number(first.bpm) > 0) baseBpm = clamp(Math.round(Number(first.bpm) * 100) / 100, 30, 300);
    if (first && ts.den !== 4 && Number(first.beatsPerBar) === Number(ts.num)) beatUnit = Number(ts.den);
  } catch (err) {
    console.error(err);
  }
  const unitName = { 1: '온음표', 2: '2분음표', 4: '4분음표', 8: '8분음표', 16: '16분음표' }[beatUnit] || '';
  const st = {
    key: recKey,
    verse: 'auto',
    lyrics: trackOf(recKey).lyricCount > 0,
    lyricsTouched: false,
    unfold: true,
    melodyOnly: true,
    transpose: 0,
    bpmText: String(baseBpm),
    playing: null,
  };
  const cache = new Map();

  /** 바꾼 BPM (그대로면 undefined → 악보의 빠르기 지도 사용). 잘못된 값이면 NaN. */
  const bpmOverride = () => {
    const v = parseNum(st.bpmText);
    if (!(v >= 30 && v <= 300)) return NaN;
    const r = Math.round(v * 100) / 100;
    return r === baseBpm && scoreTempo > 0 ? undefined : r;
  };
  const wantsLyrics = (key) => st.lyrics && trackOf(key).lyricCount > 0;
  /** 고른 절이 이 성부에 없으면 자동. (고른 값은 남겨 두어 다른 성부를 보고 와도 유지된다) */
  const verseFor = (key) => (st.verse !== 'auto' && versesOf(key).includes(st.verse) ? st.verse : 'auto');
  const convert = (key, { forPreview = false } = {}) => {
    const bpm = bpmOverride();
    if (Number.isNaN(bpm)) return { error: 'BPM은 30~300 사이로 입력해 주세요.' };
    const opts = {
      trackKey: key,
      verse: key === st.key ? verseFor(key) : 'auto',
      melodyOnly: st.melodyOnly,
      unfoldRepeats: st.unfold,
      includeLyrics: forPreview ? false : wantsLyrics(key),
    };
    if (bpm !== undefined) opts.bpm = bpm;
    const ck = JSON.stringify(opts);
    if (cache.has(ck)) return cache.get(ck);
    let res;
    try {
      res = mx.scoreToSong(score, opts);
      if (!res || !Array.isArray(res.notes)) throw new Error('악보를 변환하지 못했어요.');
    } catch (err) {
      console.error(err);
      res = { error: err && err.message ? err.message : '악보를 변환하지 못했어요.' };
    }
    cache.set(ck, res);
    return res;
  };
  /** 이조를 적용한 노트. 피아노 음역을 벗어나는 음은 옥타브를 옮겨 개수(=가사 짝)를 지킨다. */
  const prepared = (res) => {
    let moved = 0;
    const notes = (res.notes || []).filter((n) => n && Number.isFinite(n.t) && Number.isFinite(n.m)).map((n) => {
      let m = Math.round(n.m + st.transpose);
      if (m < 21 || m > 108) moved++;
      while (m < 21) m += 12;
      while (m > 108) m -= 12;
      return {
        t: round3(Math.max(0, n.t)),
        d: Math.max(0.05, round3(Number.isFinite(n.d) ? n.d : 0.25)),
        m,
        v: Number.isFinite(n.v) ? n.v : 0.8,
      };
    });
    return { notes: sortNotes(notes), moved };
  };

  // --- preview -------------------------------------------------------------
  const playBtns = new Map();
  const mainPlay = btn('▶ 미리듣기', () => togglePreview(st.key), 'small', { title: '고른 성부의 앞부분을 들어봐요' });
  const setPlayLabels = () => {
    for (const [key, b] of playBtns) b.textContent = st.playing === key ? '■' : '▶';
    mainPlay.textContent = st.playing === st.key ? '■ 정지' : '▶ 미리듣기';
  };
  const stopPreview = () => {
    if (st.playing != null) {
      st.playing = null;
      stopPlayer(s);
    }
    setPlayLabels();
  };
  const togglePreview = async (key) => {
    if (st.playing === key) {
      stopPreview();
      return;
    }
    const res = convert(key, { forPreview: true });
    const notes = res.error ? [] : prepared(res).notes;
    if (!notes.length) {
      s.app.toast(res.error || '들려줄 음이 없어요.', res.error ? 'error' : 'info');
      return;
    }
    try {
      const started = await playNotes(s, notes, {
        maxSec: 15,
        onEnd: () => {
          if (st.playing === key) {
            st.playing = null;
            setPlayLabels();
          }
        },
      });
      if (!started || s.disposed) return;
      st.playing = key;
      setPlayLabels();
    } catch (err) {
      console.error(err);
      stopPreview();
    }
  };

  // --- track list ------------------------------------------------------------
  const radioName = `ed-xml-${++idSeq}`;
  const rows = tracks.map((t) => {
    const radio = el('input', {
      type: 'radio', name: radioName, value: t.key, checked: t.key === st.key,
      onChange: (e) => { if (e.target.checked) selectTrack(t.key); },
    });
    const play = el('button', {
      class: 'btn small ghost ed-track-play', type: 'button', 'aria-label': '들어보기', title: '앞부분 들어보기',
      onClick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePreview(t.key);
      },
    }, '▶');
    playBtns.set(t.key, play);
    return el('label', { class: 'ed-track' },
      radio,
      el('span', { class: 'ed-track-main' },
        el('span', { class: 'ed-track-name' },
          t.label || t.key,
          t.key === recKey ? el('span', { class: 'badge ed-badge-rec' }, '추천') : null,
          t.lyricCount > 0 ? el('span', { class: 'badge ed-badge-lyric' }, `가사 ${t.lyricCount}`) : null),
        el('span', { class: 'ed-track-meta muted' }, `노트 ${t.noteCount}개 · ${rangeText(t.min, t.max)}`)),
      play);
  });

  // --- options ---------------------------------------------------------------
  const lyricsCb = checkbox(st.lyrics, (v) => {
    st.lyrics = v;
    st.lyricsTouched = true;
    renderVerses();
    update();
  });
  const lyricsHint = el('span', { class: 'muted' });
  const verseHost = el('div', { class: 'ed-xml-verse-seg' });
  const verseField = el('div', { class: 'ed-field ed-xml-verse' }, el('span', { class: 'ed-label' }, '가사 절'), verseHost);
  const renderVerses = () => {
    const verses = versesOf(st.key);
    verseField.hidden = !(wantsLyrics(st.key) && verses.length > 1);
    fill(verseHost, seg([
      { value: 'auto', label: '자동 (반복마다 다음 절)' },
      ...verses.map((v) => ({ value: v, label: `${v}절` })),
    ], verseFor(st.key), (v) => {
      st.verse = v;
      update();
    }, '가사 절'));
  };

  const transLabel = el('span', { class: 'ed-val' });
  const bpmInput = el('input', {
    type: 'number', class: 'ed-input ed-num', min: 30, max: 300, step: 1, inputmode: 'decimal', value: baseBpm,
    'aria-label': 'BPM',
    onInput: (e) => {
      st.bpmText = e.target.value;
      scheduleUpdate();
    },
  });
  const stepBpmBy = (dv) => {
    const cur = parseNum(bpmInput.value);
    const v = clamp(Math.round(Number.isFinite(cur) ? cur : baseBpm) + dv, 30, 300);
    bpmInput.value = String(v);
    st.bpmText = bpmInput.value;
    update();
  };
  const bpmHint = el('div', { class: 'ed-hint muted' });

  const summary = el('div', { class: 'ed-midi-summary' });
  const warnList = el('ul', { class: 'ed-warns', hidden: true });
  const applyBtn = btn('가져오기', () => apply(), 'primary');

  let updTimer = 0;
  const scheduleUpdate = () => {
    clearTimeout(updTimer);
    updTimer = setTimeout(update, 200);
  };
  const update = () => {
    clearTimeout(updTimer);
    if (s.disposed) return;
    const t = trackOf(st.key);
    lyricsCb.checked = wantsLyrics(st.key);
    lyricsCb.disabled = !(t.lyricCount > 0);
    lyricsHint.textContent = t.lyricCount > 0 ? `(이 성부에 가사 ${t.lyricCount}개)` : '(이 성부에는 가사가 없어요)';
    transLabel.textContent = st.transpose === 0 ? '그대로' : `${st.transpose > 0 ? '+' : ''}${st.transpose} 반음`;
    const bpm = bpmOverride();
    bpmHint.textContent = Number.isNaN(bpm)
      ? 'BPM은 30~300 사이로 입력해 주세요.'
      : bpm !== undefined
        ? `곡 전체를 BPM ${bpm} 하나로 맞춰요.${scoreTempo > 0 ? ` (악보 빠르기 ${baseBpm})` : ''}`
        : scoreTempo > 0
          ? `악보에 적힌 빠르기(${baseBpm})를 써요. 중간에 빠르기가 바뀌면 그대로 따라가요.`
          : `악보에 빠르기 표시가 없어서 ${baseBpm}(으)로 시작해요. 필요하면 바꿔 주세요.`;
    bpmInput.classList.toggle('invalid', Number.isNaN(bpm));

    const res = convert(st.key);
    if (res.error) {
      summary.textContent = res.error;
      warnList.hidden = true;
      fill(warnList);
      applyBtn.disabled = true;
      mainPlay.disabled = true;
      return;
    }
    const { notes, moved } = prepared(res);
    const withLyrics = wantsLyrics(st.key) && String(res.lyricText || '').trim() !== '';
    const syllables = withLyrics ? (res.stats && Number.isFinite(res.stats.syllables) ? res.stats.syllables : 0) : 0;
    let end = 0;
    for (const n of notes) end = Math.max(end, n.t + n.d);
    const d = s.draft;
    const replacing = [];
    if (d.notes.length) replacing.push(`지금 노트 ${d.notes.length}개`);
    if (withLyrics && String(d.lyrics.text || '').trim()) replacing.push('가사');
    fill(summary,
      `노트 ${notes.length}개 · 가사 음절 ${syllables}개 · 길이 ${fmtClock(end)}`,
      replacing.length ? el('span', { class: 'muted' }, ` — ${replacing.join('와 ')}를 바꿔요`) : null,
    );
    const warnings = (Array.isArray(res.warnings) ? res.warnings : []).filter(Boolean).map(String);
    if (moved) warnings.push(`피아노 건반 범위를 벗어난 음 ${moved}개는 한 옥타브씩 옮겼어요.`);
    if (withLyrics && !st.melodyOnly) warnings.push('「멜로디만」을 끄면 화음 때문에 가사가 어긋날 수 있어요.');
    warnList.hidden = warnings.length === 0;
    fill(warnList, ...warnings.slice(0, 12).map((w) => el('li', null, `⚠ ${w}`)),
      warnings.length > 12 ? el('li', null, `… 외 ${warnings.length - 12}개`) : null);
    applyBtn.disabled = notes.length === 0;
    mainPlay.disabled = notes.length === 0;
  };

  const selectTrack = (key) => {
    if (st.playing != null && st.playing !== key) stopPreview();
    st.key = key;
    if (!st.lyricsTouched) st.lyrics = trackOf(key).lyricCount > 0;
    renderVerses();
    update();
    setPlayLabels();
  };

  const apply = () => {
    const res = convert(st.key);
    if (res.error) return;
    const { notes } = prepared(res);
    if (!notes.length) return;
    const withLyrics = wantsLyrics(st.key) && String(res.lyricText || '').trim() !== '';
    const d = s.draft;
    pushUndo(s, '악보 파일 가져오기', { basics: true });
    d.notes = notes;
    const bpm = Number(res.bpm);
    if (bpm > 0) d.bpm = clamp(Math.round(bpm * 100) / 100, 30, 300);
    const bpb = Math.round(Number(res.beatsPerBar));
    if (bpb >= 1) d.beatsPerBar = clamp(bpb, 1, 16);
    d.offset = Number.isFinite(res.offset) ? round3(res.offset) : 0;
    if (withLyrics) d.lyrics = { text: String(res.lyricText), source: 'notes', lines: [] };
    if (!d.title.trim()) d.title = String(score.title || fileTitle(file.name)).trim().slice(0, 100);
    if (!String(d.artist || '').trim() && score.composer) d.artist = String(score.composer).trim().slice(0, 100);
    stopPreview();
    m.close();
    renderBasics(s, true);
    renderHeader(s);
    notesChanged(s);
    renderLyrics(s, true);
    const r = s.lyricResult;
    const lyricWarn = withLyrics && r && r.warnings && r.warnings.length;
    s.app.toast(`악보에서 노트 ${notes.length}개${withLyrics ? '와 가사' : ''}를 가져왔어요.`
      + `${lyricWarn ? ' 가사 칸의 안내를 확인해 주세요.' : ''}`, lyricWarn ? 'info' : 'success');
  };

  const metaBits = [
    file.name,
    `${ts.num}/${ts.den}`,
    Number.isFinite(score.measureCount) && score.measureCount > 0 ? `${score.measureCount}마디` : null,
    scoreTempo > 0 ? `빠르기 ${baseBpm}` : '빠르기 표시 없음',
  ].filter(Boolean);
  const content = el('div', { class: 'ed-dialog ed-midi ed-xml' },
    el('div', { class: 'ed-xml-head' },
      el('b', { class: 'ed-xml-title' }, String(score.title || fileTitle(file.name) || '제목 없는 악보')),
      score.composer ? el('span', { class: 'ed-xml-composer' }, String(score.composer)) : null,
      el('span', { class: 'muted ed-xml-meta' }, metaBits.join(' · '))),
    el('div', { class: 'ed-label' }, '가져올 성부 (노래 멜로디가 있는 줄을 고르세요)'),
    el('div', { class: 'ed-tracks' }, rows),
    el('div', { class: 'ed-xml-opts' },
      el('label', { class: 'ed-check' }, lyricsCb, el('span', null, '가사도 가져오기 '), lyricsHint),
      el('label', { class: 'ed-check' },
        checkbox(st.unfold, (v) => { st.unfold = v; update(); }),
        el('span', null, '반복 펼치기 ', el('span', { class: 'muted' }, '(도돌이표·1·2번 괄호·D.S.를 순서대로 풀어요)'))),
      el('label', { class: 'ed-check' },
        checkbox(st.melodyOnly, (v) => { st.melodyOnly = v; update(); }),
        el('span', null, '멜로디만 (위 음) ', el('span', { class: 'muted' }, '(화음은 가장 높은 음만 남겨요)'))),
    ),
    verseField,
    el('div', { class: 'ed-xml-grid' },
      el('div', { class: 'ed-field' },
        el('span', { class: 'ed-label' }, '이조'),
        el('div', { class: 'ed-stepper' },
          btn('−', () => { st.transpose = Math.max(-12, st.transpose - 1); update(); }, 'small', { 'aria-label': '반음 내리기' }),
          transLabel,
          btn('+', () => { st.transpose = Math.min(12, st.transpose + 1); update(); }, 'small', { 'aria-label': '반음 올리기' }),
        )),
      el('div', { class: 'ed-field' },
        el('span', { class: 'ed-label' }, beatUnit === 4 ? '빠르기 (BPM)' : `빠르기 (BPM · ${unitName} 기준)`),
        el('div', { class: 'ed-stepper' },
          btn('−', () => stepBpmBy(-1), 'small', { 'aria-label': 'BPM 1 줄이기' }),
          bpmInput,
          btn('+', () => stepBpmBy(1), 'small', { 'aria-label': 'BPM 1 늘리기' }),
        ),
        bpmHint),
    ),
    el('div', { class: 'ed-xml-sum-row' }, mainPlay, summary),
    warnList,
    el('div', { class: 'ed-modal-actions' }, btn('취소', () => m.close(), 'ghost'), applyBtn),
  );

  renderVerses();
  update();
  setPlayLabels();
  const m = openModal(s, {
    title: '악보 파일 가져오기 (MusicXML)',
    content,
    className: 'wide',
    onClose: () => {
      clearTimeout(updTimer);
      stopPreview();
    },
  });
}

// ---------------------------------------------------------------------------
// 악보 보고 입력 (step entry)
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k of Object.keys(attrs || {})) node.setAttribute(k, String(attrs[k]));
  return node;
}

/** 음표 모양 아이콘: 온(빈 머리) · 2분(빈 머리+기둥) · 4분 · 8분(꼬리 1) · 16분(꼬리 2). */
function noteIcon(value) {
  const svg = svgEl('svg', { viewBox: '0 0 24 32', width: 18, height: 24, class: 'ed-note-ico', 'aria-hidden': 'true' });
  const hollow = value >= 2;
  svg.append(svgEl('ellipse', {
    cx: 9, cy: 24, rx: 6.2, ry: 4.4, transform: 'rotate(-20 9 24)',
    fill: hollow ? 'none' : 'currentColor', stroke: 'currentColor', 'stroke-width': hollow ? 2.2 : 1,
  }));
  if (value <= 2) {
    svg.append(svgEl('path', { d: 'M14.6 22.6V3', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }));
  }
  const flags = value === 0.5 ? 1 : value === 0.25 ? 2 : 0;
  for (let i = 0; i < flags; i++) {
    svg.append(svgEl('path', {
      d: `M14.6 ${3 + i * 6}c1.6 4 7 5.4 5.2 12`, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round',
    }));
  }
  return svg;
}

/** 화면 건반의 시작 도(C): 기존 노트의 가운데 음이 잘 보이게. 노트가 없으면 가운데 도(C4)부터. */
export function stepDefaultBase(notes) {
  const ms = (notes || []).map((n) => n && n.m).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ms.length) return 60;
  const median = ms[Math.floor(ms.length / 2)];
  return clamp(12 * Math.round((median - 12) / 12), 24, 84);
}

async function openStepEntry(s) {
  if (s.disposed || s.modals.size) return;
  if (s.errors.bpm || s.errors.offset) {
    s.app.toast('기본 정보의 BPM·첫 박 위치를 먼저 고쳐 주세요.', 'error');
    return;
  }
  let mode = 'replace';
  const count = s.draft.notes.length;
  if (count) {
    const choice = await choose(s, {
      title: '🎼 악보 보고 입력',
      message: `지금 노트가 ${count}개 있어요. 어디서부터 입력할까요?`,
      options: [
        { value: 'append', label: '이어서 입력 — 마지막 노트 바로 뒤부터', cls: 'primary' },
        { value: 'replace', label: '새로 입력 — 처음부터 (「완료」하면 기존 노트를 바꿔요)' },
      ],
    });
    if (!choice || s.disposed) return;
    mode = choice;
  }
  openStepPanel(s, mode);
}

function openStepPanel(s, mode) {
  const d = s.draft;
  const bpm = d.bpm > 0 ? d.bpm : 100;
  const bpb = d.beatsPerBar > 0 ? d.beatsPerBar : 4;
  const spt = 60 / bpm / STEP_TPB; // 1틱의 초
  const origin = gridStart(d.offset, bpm, bpb);
  const append = mode === 'append';
  const existing = append ? copyNotes(d.notes) : [];
  const startTick = append ? stepResumeTick(existing, { bpm, origin }) : 0;
  const existingTicks = existing.map((n) => ({ m: n.m, tick: (n.t - origin) / spt, ticks: n.d / spt }));
  const lyricText = d.lyrics && d.lyrics.source !== 'lrc' ? String(d.lyrics.text || '') : '';
  const lyricBase = append ? groupNoteEvents(existing).length : 0;
  const st = {
    entries: [],
    value: 1,
    dotted: false,
    triplet: false,
    base: stepDefaultBase(d.notes),
    lastPress: 0,
    lastKey: null,
    playing: false,
    confirming: false,
    closed: false,
    raf: 0,
  };
  const keyTimers = new Map();
  const r = {};
  const curTicks = () => stepTicks(st.value, { dotted: st.dotted, triplet: st.triplet });

  // --- top bar: 위치 · 다음 가사 · 취소/완료 ------------------------------------
  r.pos = el('div', { class: 'ed-step-pos', 'aria-live': 'polite' });
  r.meta = el('div', { class: 'ed-step-meta muted' });
  r.lyric = el('div', { class: 'ed-step-lyric', hidden: !lyricText.trim() });
  r.doneBtn = btn('완료', () => done(), 'primary');
  const top = el('div', { class: 'ed-step-top' },
    el('div', { class: 'ed-step-where' },
      el('div', { class: 'ed-step-pos-row' },
        r.pos,
        el('span', { class: 'badge ed-step-mode' }, append ? '이어서 입력' : '새로 입력')),
      r.meta),
    r.lyric,
    el('div', { class: 'ed-step-top-btns' }, btn('취소', () => cancel(), 'ghost'), r.doneBtn),
  );

  // --- mini view + 입력한 음(텍스트) ----------------------------------------------
  r.canvas = el('canvas', { class: 'ed-step-canvas', 'aria-hidden': 'true' });
  r.view = el('div', { class: 'ed-step-view' }, r.canvas);
  r.text = el('div', { class: 'ed-step-text', role: 'log', 'aria-label': '입력한 음' });

  // --- 음표 길이 · 점 · 셋잇단 · 쉼표 · 이음줄 · 지우기 ----------------------------
  r.values = STEP_VALUES.map((v) => el('button', {
    type: 'button', class: 'ed-step-key-btn ed-step-val', role: 'radio', dataset: { value: String(v.value) },
    'aria-label': `${v.label} (${formatStepBeats(v.value)}박)`, title: `${v.label} · ${formatStepBeats(v.value)}박`,
    onClick: () => { st.value = v.value; update(); },
  }, noteIcon(v.value), el('span', { class: 'ed-step-btn-text' }, v.short)));
  const toggle = (label, sub, title, onClick) => el('button', {
    type: 'button', class: 'ed-step-key-btn ed-step-mod', 'aria-pressed': 'false', title, onClick,
  }, el('span', { class: 'ed-step-mod-mark', 'aria-hidden': 'true' }, sub), el('span', { class: 'ed-step-btn-text' }, label));
  r.dot = toggle('점', '•', '점음표: 길이 ×1.5', () => { st.dotted = !st.dotted; update(); });
  r.trip = toggle('셋잇단', '3', '셋잇단음표: 길이 ×⅔ (세 음을 연달아 넣으세요)', () => { st.triplet = !st.triplet; update(); });
  const act = (label, sub, cls, onClick, title) => el('button', {
    type: 'button', class: `ed-step-key-btn ed-step-act ${cls}`.trim(), title, onClick,
  }, el('span', { class: 'ed-step-act-main' }, label), sub ? el('small', null, sub) : null);
  r.restBtn = act('쉼표', '고른 길이', '', () => addRest(), '고른 길이만큼 쉬어요');
  r.tieBtn = act('이음줄', '앞 음 늘이기', '', () => addTie(), '바로 앞 음을 고른 길이만큼 더 늘여요');
  r.backBtn = act('⌫ 지우기', '마지막 하나', 'warn', () => back(), '마지막에 넣은 음·쉼표·이음줄을 지워요 (Backspace)');
  r.playBtn = act('▶ 들어보기', '보이는 곳부터', '', () => togglePlay(), '화면에 보이는 마디부터 들려줘요');
  const tools = el('div', { class: 'ed-step-tools' },
    el('div', { class: 'ed-step-values', role: 'radiogroup', 'aria-label': '음표 길이' }, r.values),
    el('div', { class: 'ed-step-mods' }, r.dot, r.trip),
    el('div', { class: 'ed-step-acts' }, r.restBtn, r.tieBtn, r.backBtn, r.playBtn),
  );

  // --- 화면 건반 ----------------------------------------------------------------
  r.kbd = el('div', { class: 'ed-kbd', role: 'group', 'aria-label': '건반 (누르면 음이 들어가요)' });
  r.lowBtn = el('button', {
    type: 'button', class: 'btn ed-oct', 'aria-label': '한 옥타브 낮게', title: '한 옥타브 낮게',
    onClick: () => shiftOctave(-12),
  }, el('span', { 'aria-hidden': 'true' }, '◀'), el('small', null, '낮게'));
  r.highBtn = el('button', {
    type: 'button', class: 'btn ed-oct', 'aria-label': '한 옥타브 높게', title: '한 옥타브 높게',
    onClick: () => shiftOctave(12),
  }, el('span', { 'aria-hidden': 'true' }, '▶'), el('small', null, '높게'));

  const buildKeys = () => {
    const keys = [];
    let white = -1;
    for (let m = st.base; m <= st.base + 24; m++) {
      const black = isBlackKey(m);
      if (!black) white++;
      const name = noteName(m, 'solfege-octave');
      keys.push(el('button', {
        type: 'button',
        class: `ed-key ${black ? 'black' : 'white'}${m > st.base + 12 ? ' far' : ''}${m % 12 === 0 ? ' c' : ''}`,
        style: `--i:${black ? white + 1 : white}`,
        dataset: { m: String(m) },
        'aria-label': `${name} (${noteName(m, 'en')})`,
      }, el('span', { class: 'ed-key-label' }, name)));
    }
    fill(r.kbd, keys);
    r.lowBtn.disabled = st.base <= 24;
    r.highBtn.disabled = st.base >= 84;
  };
  const shiftOctave = (dm) => {
    const next = clamp(st.base + dm, 24, 84);
    if (next === st.base) return;
    st.base = next;
    buildKeys();
    scheduleDraw();
  };

  const flash = (keyEl) => {
    keyEl.classList.add('on');
    clearTimeout(keyTimers.get(keyEl));
    keyTimers.set(keyEl, setTimeout(() => {
      keyEl.classList.remove('on');
      keyTimers.delete(keyEl);
    }, 170));
  };
  const onKeyPointer = (e) => {
    const keyEl = e.target && e.target.closest ? e.target.closest('.ed-key') : null;
    if (!keyEl || !r.kbd.contains(keyEl)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const now = performance.now();
    // 손바닥이나 두 손가락이 거의 동시에 닿으면 처음 누른 건반만 쓴다.
    if (keyEl !== st.lastKey && now - st.lastPress < 45) return;
    st.lastPress = now;
    st.lastKey = keyEl;
    flash(keyEl);
    pressKey(Number(keyEl.dataset.m));
  };
  r.kbd.addEventListener('pointerdown', onKeyPointer);
  r.kbd.addEventListener('click', (e) => {
    if (e.detail !== 0) return; // 터치·마우스는 pointerdown에서 처리했다. 키보드(Enter/Space)로 누른 경우만.
    const keyEl = e.target && e.target.closest ? e.target.closest('.ed-key') : null;
    if (!keyEl) return;
    flash(keyEl);
    pressKey(Number(keyEl.dataset.m));
  });
  r.kbd.addEventListener('contextmenu', (e) => e.preventDefault());

  // --- 입력 동작 ------------------------------------------------------------------
  const full = () => {
    if (st.entries.length < STEP_MAX_ENTRIES) return false;
    s.app.toast('한 번에 입력할 수 있는 양을 넘었어요. 「완료」한 뒤 「이어서 입력」으로 계속해 주세요.');
    return true;
  };
  const sound = (m, dur) => {
    getSynth(s).then((synth) => {
      if (s.disposed || st.closed) return;
      synth.playNote(m, getAudioContext().currentTime + 0.01, clamp(dur, 0.15, 1.2), { velocity: 0.75 });
    }).catch((err) => console.error(err));
  };
  const pressKey = (m) => {
    if (!Number.isFinite(m) || full()) return;
    stopStepPlayback();
    const ticks = curTicks();
    st.entries.push({ kind: 'note', m, ticks });
    sound(m, ticks * spt);
    update();
  };
  const addRest = () => {
    if (full()) return;
    stopStepPlayback();
    st.entries.push({ kind: 'rest', ticks: curTicks() });
    update();
  };
  const addTie = () => {
    if (!stepCanTie(st.entries)) {
      s.app.toast('늘일 음이 없어요. 음을 먼저 넣어 주세요.');
      return;
    }
    if (full()) return;
    stopStepPlayback();
    st.entries.push({ kind: 'tie', ticks: curTicks() });
    update();
  };
  const back = () => {
    if (!st.entries.length) return;
    stopStepPlayback();
    st.entries.pop();
    update();
  };

  // --- 들어보기 -------------------------------------------------------------------
  const viewWindow = () => {
    const barTicks = bpb * STEP_TPB;
    const cur = startTick + stepTotalTicks(st.entries);
    const curBar = Math.floor(cur / barTicks + 1e-9);
    const from = Math.max(0, curBar - 1) * barTicks;
    return { from, to: from + 2 * barTicks, cur, barTicks };
  };
  const renderPlay = () => {
    const main = r.playBtn.querySelector('.ed-step-act-main');
    if (main) main.textContent = st.playing ? '■ 정지' : '▶ 들어보기';
  };
  const stopStepPlayback = () => {
    if (!st.playing) return;
    st.playing = false;
    stopPlayer(s);
    renderPlay();
  };
  const togglePlay = async () => {
    if (st.playing) {
      stopStepPlayback();
      return;
    }
    const fromSec = origin + viewWindow().from * spt;
    const notes = sortNotes([...existing, ...stepEntriesToNotes(st.entries, { bpm, origin, startTick })]
      .filter((n) => n.t + n.d > fromSec + 1e-3));
    if (!notes.length) {
      s.app.toast('들려줄 음이 없어요.');
      return;
    }
    try {
      const started = await playNotes(s, notes, {
        maxSec: 20,
        onEnd: () => {
          st.playing = false;
          if (!st.closed) renderPlay();
        },
      });
      if (!started || st.closed) return;
      st.playing = true;
      renderPlay();
    } catch (err) {
      console.error(err);
    }
  };

  // --- 그리기 ---------------------------------------------------------------------
  const scheduleDraw = () => {
    if (st.raf || st.closed) return;
    st.raf = requestAnimationFrame(() => {
      st.raf = 0;
      if (!st.closed) draw();
    });
  };
  const draw = () => {
    const canvas = r.canvas;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const g = canvas.getContext('2d');
    if (!g) return;
    const C = rollColors(s);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, cssW, cssH);

    const { from, to, cur, barTicks } = viewWindow();
    const items = stepItems(st.entries, startTick);
    const visible = (tick, ticks) => tick + ticks > from && tick < to;
    const shown = [];
    for (const n of existingTicks) if (visible(n.tick, n.ticks)) shown.push({ m: n.m, tick: n.tick, ticks: n.ticks, own: false });
    for (const it of items) if (!it.rest && visible(it.tick, it.ticks)) shown.push({ m: it.m, tick: it.tick, ticks: it.ticks, own: true });
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of shown) {
      lo = Math.min(lo, n.m);
      hi = Math.max(hi, n.m);
    }
    if (!shown.length) {
      lo = st.base + 5;
      hi = st.base + 19;
    }
    lo -= 2;
    hi += 2;
    if (hi - lo < 14) {
      const c = (lo + hi) / 2;
      lo = Math.floor(c - 7);
      hi = lo + 14;
    }
    const topPad = 18;
    const bottomPad = 14;
    const rowH = (cssH - topPad - bottomPad) / (hi - lo + 1);
    const xOf = (tick) => ((tick - from) / (to - from)) * cssW;
    const yOf = (m) => topPad + (hi - m) * rowH;
    const innerH = cssH - topPad - bottomPad;

    g.fillStyle = C.blackRow;
    for (let m = lo; m <= hi; m++) if (isBlackKey(m)) g.fillRect(0, yOf(m), cssW, rowH);

    g.font = `bold 11px ${C.font}`;
    g.textBaseline = 'alphabetic';
    for (let t = from; t <= to; t += STEP_TPB) {
      const isBar = t % barTicks === 0;
      const x = Math.round(xOf(t));
      g.fillStyle = isBar ? C.bar : C.beat;
      g.fillRect(x, topPad, isBar ? 2 : 1, innerH);
      if (isBar && t < to) {
        g.fillStyle = C.muted;
        g.fillText(`${t / barTicks + 1}마디`, x + 5, 13);
      }
    }

    // 이어서 입력한 시작 위치
    if (append && startTick > from && startTick < to) {
      const x = Math.round(xOf(startTick)) + 0.5;
      g.save();
      g.strokeStyle = C.lyric;
      g.globalAlpha = 0.7;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, topPad);
      g.lineTo(x, cssH - bottomPad);
      g.stroke();
      g.restore();
    }

    // 다음에 들어갈 길이 (커서부터)
    const ghostEnd = cur + curTicks();
    g.fillStyle = 'rgba(255, 216, 77, 0.09)';
    g.fillRect(xOf(cur), topPad, Math.max(2, xOf(ghostEnd) - xOf(cur)), innerH);

    // 쉼표
    g.font = `bold 10px ${C.font}`;
    for (const it of items) {
      if (!it.rest || !visible(it.tick, it.ticks)) continue;
      const x = xOf(it.tick) + 1;
      const w = Math.max(2, xOf(it.tick + it.ticks) - x - 2);
      g.fillStyle = 'rgba(154, 160, 195, 0.22)';
      g.fillRect(x, cssH - bottomPad - 9, w, 7);
      if (w > 22) {
        g.fillStyle = C.muted;
        g.fillText('쉼', x + 3, cssH - bottomPad - 12);
      }
    }

    // 노트 (기존 노트는 흐리게)
    const h = Math.max(3, rowH - 1);
    const lastItem = items.length ? items[items.length - 1] : null;
    g.textBaseline = 'middle';
    for (const n of shown) {
      const x = xOf(n.tick);
      const w = Math.max(3, xOf(n.tick + n.ticks) - x - 1);
      const y = yOf(n.m) + (rowH - h) / 2;
      g.globalAlpha = n.own ? 1 : 0.35;
      g.fillStyle = isBlackKey(n.m) ? C.black : C.white;
      g.fillRect(x, y, w, h);
      g.globalAlpha = 1;
      if (n.own && w > 24 && h >= 10) {
        g.fillStyle = '#0b0d17';
        g.font = `bold ${Math.min(12, Math.floor(h - 1))}px ${C.font}`;
        g.fillText(noteName(n.m, 'solfege'), x + 4, y + h / 2 + 0.5);
      }
      if (n.own && lastItem && !lastItem.rest && lastItem.tick === n.tick && lastItem.m === n.m) {
        g.strokeStyle = C.sel;
        g.lineWidth = 2;
        g.strokeRect(x - 1, y - 1, w + 2, h + 2);
      }
    }
    g.globalAlpha = 1;

    // 커서
    const cx = Math.round(xOf(cur)) + 0.5;
    g.fillStyle = C.audio;
    g.fillRect(cx - 1, topPad - 2, 2, innerH + 4);
    g.beginPath();
    g.moveTo(cx - 6, topPad - 8);
    g.lineTo(cx + 6, topPad - 8);
    g.lineTo(cx, topPad - 1);
    g.closePath();
    g.fill();
  };

  // --- 화면 갱신 -------------------------------------------------------------------
  const update = () => {
    if (st.closed) return;
    const ticks = curTicks();
    const cur = startTick + stepTotalTicks(st.entries);
    const n = stepNoteCount(st.entries);
    r.pos.textContent = stepCursor(cur / STEP_TPB, bpb).text;
    const info = STEP_VALUES.find((v) => v.value === st.value);
    r.meta.textContent = `다음 길이: ${info ? info.label : ''}${st.dotted ? ' · 점' : ''}${st.triplet ? ' · 셋잇단' : ''}`
      + ` (${formatStepBeats(ticks / STEP_TPB)}박) · 넣은 음 ${n}개 · BPM ${bpm} · ${bpb}박자`;
    for (const b of r.values) {
      const on = Number(b.dataset.value) === st.value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    r.dot.classList.toggle('on', st.dotted);
    r.dot.setAttribute('aria-pressed', st.dotted ? 'true' : 'false');
    r.trip.classList.toggle('on', st.triplet);
    r.trip.setAttribute('aria-pressed', st.triplet ? 'true' : 'false');
    r.tieBtn.disabled = !stepCanTie(st.entries);
    r.backBtn.disabled = st.entries.length === 0;
    r.doneBtn.disabled = n === 0;
    r.doneBtn.textContent = n ? `완료 (${n})` : '완료';

    const text = stepEntriesText(st.entries, { beatsPerBar: bpb, startTick });
    r.text.classList.toggle('empty', !text);
    r.text.textContent = text || '음표 길이를 고르고 건반을 누르세요. 쉼표·이음줄도 고른 길이만큼 들어가요. 셋잇단은 세 음을 연달아 넣으세요.';
    if (text) r.text.scrollTop = r.text.scrollHeight;

    if (lyricText.trim()) {
      const toks = lyricTokensAt(lyricText, lyricBase + n, 6);
      fill(r.lyric,
        el('span', { class: 'ed-step-lyric-label' }, '다음 가사'),
        toks.length
          ? [el('b', { class: 'ed-step-syl' }, toks[0]), toks.length > 1 ? el('span', { class: 'ed-step-syl-rest' }, toks.slice(1).join(' ')) : null]
          : el('span', { class: 'ed-step-syl-rest' }, '가사 끝'));
    }
    scheduleDraw();
  };

  // --- 키보드 단축키 · 닫기 ---------------------------------------------------------
  const onWinKey = (e) => {
    if (st.closed || st.confirming || e.defaultPrevented) return;
    const t = e.target;
    const tag = t && t.tagName ? t.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const key = String(e.key || '');
    if (key === 'Backspace' || ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'z')) {
      e.preventDefault();
      back();
    }
  };
  window.addEventListener('keydown', onWinKey);

  let ro = null;
  const cleanup = () => {
    st.closed = true;
    stopStepPlayback();
    if (st.raf) cancelAnimationFrame(st.raf);
    st.raf = 0;
    if (ro) ro.disconnect();
    else window.removeEventListener('resize', scheduleDraw);
    window.removeEventListener('keydown', onWinKey);
    for (const t of keyTimers.values()) clearTimeout(t);
    keyTimers.clear();
  };

  const cancel = async () => {
    const n = stepNoteCount(st.entries);
    if (st.entries.length) {
      st.confirming = true;
      const ok = await confirmDialog({
        title: '입력한 내용을 버릴까요?',
        message: n ? `입력한 음 ${n}개를 넣지 않고 닫아요.` : '입력한 쉼표를 버리고 닫아요.',
        okText: '버리기',
        cancelText: '계속 입력',
        danger: true,
      });
      st.confirming = false;
      if (!ok || st.closed) return;
    }
    m.close();
  };

  const done = () => {
    const notes = stepEntriesToNotes(st.entries, { bpm, origin, startTick });
    if (!notes.length) {
      s.app.toast('입력한 음이 없어요.');
      return;
    }
    const dr = s.draft;
    pushUndo(s, '악보 보고 입력');
    dr.notes = append ? sortNotes([...dr.notes, ...notes]) : sortNotes(notes);
    m.close();
    notesChanged(s);
    s.app.toast(`노트 ${notes.length}개를 ${append ? '이어서 넣었어요' : '넣었어요'}.`, 'success');
  };

  const content = el('div', { class: 'ed-dialog ed-step' },
    top,
    r.view,
    r.text,
    tools,
    el('div', { class: 'ed-kbd-row' }, r.lowBtn, r.kbd, r.highBtn),
  );
  buildKeys();
  update();
  const m = openModal(s, { title: '', content, className: 'wide ed-step-modal', dismissible: false, onClose: cleanup });
  if (m.el) m.el.setAttribute('aria-label', '악보 보고 입력');
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => scheduleDraw());
    ro.observe(r.view);
  } else {
    window.addEventListener('resize', scheduleDraw);
  }
  scheduleDraw();
}

// ---------------------------------------------------------------------------
// Piano recording (mic)
// ---------------------------------------------------------------------------

async function ensureMic(s) {
  const unlocking = unlock(s);
  const input = s.app.getInput();
  await unlocking;
  if (!input) {
    const err = new Error('오디오 기능을 불러오지 못했어요.');
    err.code = 'unsupported';
    throw err;
  }
  if (input.state === 'running' && input.mode === 'mic') return input;
  if (input.state === 'running') input.stop();
  await input.startMic();
  if (s.app.settings.get('inputMode') !== 'mic') s.startedMic = true;
  return input;
}

function latencySetting(s) {
  const v = Number(s.app.settings.get('latency'));
  return Number.isFinite(v) ? v : 0;
}

function stopRecorder(s) {
  const rec = s.rec;
  if (!rec) return;
  s.rec = null;
  const active = rec.phase === 'countin' || rec.phase === 'recording';
  rec.phase = 'closed';
  cancelAnimationFrame(rec.raf);
  clearInterval(rec.clickTimer);
  stopPlayer(s);
  for (const off of rec.offs) {
    try { off(); } catch (err) { console.error(err); }
  }
  rec.offs.length = 0;
  if (s.synth) {
    try { s.synth.stopAll(); } catch (err) { console.error(err); }
  }
  if (active) keepAwake(s, false);
}

function keepAwake(s, on) {
  try {
    if (typeof s.app.keepAwake === 'function') Promise.resolve(s.app.keepAwake(on)).catch(() => {});
  } catch (err) {
    console.error(err);
  }
}

function openRecorder(s) {
  if (s.rec) return;
  const { app } = s;
  const rec = {
    phase: 'setup',
    events: [],
    raw: [],
    start: 0,
    beat: 0.6,
    raf: 0,
    clickTimer: 0,
    clickNext: 0,
    clickIdx: 0,
    quantize: 4,
    offs: [],
    input: null,
    modal: null,
  };
  s.rec = rec;
  const r = {};
  r.status = el('div', { class: 'ed-rec-status' }, '마이크를 켜는 중…');
  r.meterFill = el('div', { class: 'ed-rec-meter-fill' });
  r.pitch = el('span', { class: 'ed-rec-pitch' }, '—');
  r.metro = el('input', { type: 'checkbox' });
  r.setup = el('div', { class: 'ed-rec-setup' },
    el('p', null, `BPM ${s.draft.bpm} · ${s.draft.beatsPerBar}박 — 「녹음 시작」을 누르면 클릭 4번(카운트인) 뒤에 녹음이 시작돼요.`),
    el('label', { class: 'ed-check' }, r.metro, el('span', null, '녹음하는 동안 메트로놈 켜기')),
    el('p', { class: 'ed-hint warn' }, '메트로놈 소리가 음으로 잘못 감지될 수 있어요. 켤 때는 이어폰을 권장해요.'),
    el('p', { class: 'ed-hint muted' }, '멜로디만 한 손으로, 한 음씩 또렷하게 쳐 주세요. 페달은 떼는 게 좋아요.'),
  );
  r.big = el('div', { class: 'ed-rec-big' }, '준비');
  r.count = el('span', { class: 'muted' }, '0개');
  r.chips = el('div', { class: 'ed-rec-chips' });
  r.review = el('div', { class: 'ed-rec-review', hidden: true });
  r.startBtn = btn('● 녹음 시작', () => startRec(), 'primary big', { disabled: true });
  r.stopBtn = btn('■ 정지', () => stopRec(), 'danger big', { hidden: true });
  r.closeBtn = btn('닫기', () => rec.modal && rec.modal.close(), 'ghost');

  const content = el('div', { class: 'ed-dialog ed-rec' },
    r.status,
    el('div', { class: 'ed-rec-live' },
      el('div', { class: 'ed-rec-meter', 'aria-hidden': 'true' }, r.meterFill),
      r.pitch),
    r.setup,
    r.big,
    el('div', { class: 'ed-rec-list-head' }, el('span', null, '감지된 음'), r.count),
    r.chips,
    r.review,
    el('div', { class: 'ed-modal-actions' }, r.closeBtn, r.stopBtn, r.startBtn),
  );
  rec.modal = openModal(s, {
    title: '🎹 피아노로 녹음',
    content,
    className: 'wide',
    dismissible: false,
    onClose: () => { if (s.rec === rec) stopRecorder(s); },
  });

  const addChip = (m) => {
    r.chips.append(el('span', { class: 'chip ed-rec-chip' }, noteName(m, 'solfege-octave')));
    while (r.chips.childElementCount > 80) r.chips.firstElementChild.remove();
    r.chips.scrollTop = r.chips.scrollHeight;
    r.count.textContent = `${rec.events.length}개`;
  };

  const onAnalysis = (a) => {
    if (!a) return;
    const pct = clamp(((Number.isFinite(a.db) ? a.db : -120) + 80) / 80, 0, 1);
    r.meterFill.style.transform = `scaleX(${pct.toFixed(3)})`;
    r.meterFill.classList.toggle('open', Boolean(a.gateOpen));
    if (a.pitch && Number.isFinite(a.pitch.midi) && (a.pitch.clarity == null || a.pitch.clarity >= 0.6)) {
      r.pitch.textContent = noteName(Math.round(a.pitch.midi), 'solfege-octave');
    }
  };
  const onNote = (ev) => {
    if (rec.phase !== 'countin' && rec.phase !== 'recording') return;
    if (!ev || !Number.isFinite(ev.time) || !Number.isFinite(ev.midi)) return;
    if (ev.time - latencySetting(s) < rec.start - 0.25) return;
    rec.events.push({ time: ev.time, midi: ev.midi, strength: ev.strength, source: ev.source });
    addChip(Math.round(ev.midi));
  };

  const prepareMic = async () => {
    r.startBtn.disabled = true;
    r.status.className = 'ed-rec-status';
    r.status.textContent = '마이크를 켜는 중…';
    try {
      const input = await ensureMic(s);
      if (s.rec !== rec) return;
      rec.input = input;
      rec.offs.push(input.on('analysis', onAnalysis));
      rec.offs.push(input.on('note', onNote));
      r.status.textContent = '🎤 듣고 있어요. 건반을 눌러서 소리 막대와 음 이름이 움직이는지 확인해 보세요.';
      r.startBtn.disabled = false;
    } catch (err) {
      console.error(err);
      if (s.rec !== rec) return;
      const msg = micErrorMessage(err);
      r.status.className = 'ed-rec-status error';
      fill(r.status,
        el('strong', null, msg.title),
        el('div', null, msg.message),
        btn('다시 시도', () => prepareMic(), 'small'),
      );
    }
  };

  const scheduleClicks = () => {
    if (rec.phase !== 'countin' && rec.phase !== 'recording') return;
    const synth = s.synth;
    if (!synth) return;
    const now = getAudioContext().currentTime;
    while (rec.clickNext < now + 0.25) {
      if (rec.clickNext >= now - 0.05) synth.click(rec.clickNext, rec.clickIdx % s.draft.beatsPerBar === 0);
      rec.clickIdx++;
      rec.clickNext = rec.start + rec.clickIdx * rec.beat;
    }
  };

  const loop = () => {
    if (s.rec !== rec) return;
    const now = audioNow();
    if (rec.phase === 'countin') {
      const left = rec.start - now;
      if (left <= 0) {
        rec.phase = 'recording';
      } else {
        r.big.textContent = String(clamp(Math.ceil(left / rec.beat), 1, 4));
        r.big.className = 'ed-rec-big count';
      }
    }
    if (rec.phase === 'recording') {
      const elapsed = now - rec.start;
      r.big.textContent = `● 녹음 중 ${fmtClock(elapsed)}`;
      r.big.className = 'ed-rec-big live';
      if (elapsed > MAX_REC_SEC) {
        stopRec();
        return;
      }
    }
    if (rec.phase === 'countin' || rec.phase === 'recording') rec.raf = requestAnimationFrame(loop);
  };

  const startRec = async () => {
    if (!rec.input || rec.phase === 'countin' || rec.phase === 'recording') return;
    if (s.errors.bpm) {
      app.toast('BPM을 먼저 바르게 입력해 주세요.', 'error');
      return;
    }
    let synth;
    try {
      synth = await getSynth(s);
    } catch (err) {
      console.error(err);
      app.toast('소리를 낼 수 없어요.', 'error');
      return;
    }
    if (s.rec !== rec) return;
    stopPlayer(s);
    synth.stopAll();
    const ctx = getAudioContext();
    rec.beat = 60 / s.draft.bpm;
    rec.events = [];
    rec.raw = [];
    fill(r.chips);
    r.count.textContent = '0개';
    const t0 = ctx.currentTime + 0.3;
    for (let i = 0; i < 4; i++) synth.click(t0 + i * rec.beat, i === 0);
    rec.start = t0 + 4 * rec.beat;
    rec.phase = 'countin';
    rec.clickNext = rec.start;
    rec.clickIdx = 0;
    if (r.metro.checked) {
      rec.clickTimer = setInterval(scheduleClicks, 50);
      scheduleClicks();
    }
    r.status.className = 'ed-rec-status';
    r.status.textContent = '카운트인이 끝나면 멜로디를 연주하세요. 다 치면 「정지」를 누르세요.';
    r.setup.hidden = true;
    r.review.hidden = true;
    r.startBtn.hidden = true;
    r.closeBtn.hidden = true;
    r.stopBtn.hidden = false;
    keepAwake(s, true);
    rec.raf = requestAnimationFrame(loop);
  };

  const stopRec = () => {
    if (rec.phase !== 'countin' && rec.phase !== 'recording') return;
    rec.phase = 'review';
    cancelAnimationFrame(rec.raf);
    clearInterval(rec.clickTimer);
    if (s.synth) s.synth.stopAll();
    keepAwake(s, false);
    rec.raw = recordedEventsToNotes(rec.events, { start: rec.start, latency: latencySetting(s), bpm: s.draft.bpm });
    r.stopBtn.hidden = true;
    r.startBtn.hidden = false;
    r.startBtn.textContent = '● 다시 녹음';
    r.startBtn.classList.remove('primary');
    r.closeBtn.hidden = false;
    r.setup.hidden = false;
    r.big.className = 'ed-rec-big';
    r.big.textContent = rec.raw.length ? `녹음 완료 · 노트 ${rec.raw.length}개` : '감지된 음이 없어요';
    r.status.textContent = rec.raw.length
      ? '들어보고 「교체」나 「뒤에 추가」를 누르세요. 마음에 안 들면 다시 녹음할 수 있어요.'
      : '🎤 듣고 있어요. 다시 녹음해 보세요.';
    renderReview();
  };

  const placed = (mode) => {
    const d = s.draft;
    const base = mode === 'append' ? appendStartTime(d.notes, d) : gridStart(d.offset, d.bpm, d.beatsPerBar);
    let notes = rec.raw.map((n) => ({ ...n, t: round3(n.t + base) }));
    if (rec.quantize) notes = quantizeNotes(notes, d.bpm, d.offset, rec.quantize);
    return sortNotes(notes);
  };

  const applyRec = (mode) => {
    if (!rec.raw.length) return;
    const notes = placed(mode);
    const d = s.draft;
    pushUndo(s, mode === 'append' ? '녹음 뒤에 추가' : '녹음으로 교체');
    d.notes = mode === 'append' ? sortNotes([...d.notes, ...notes]) : notes;
    rec.modal.close();
    notesChanged(s);
    app.toast(`녹음한 노트 ${notes.length}개를 ${mode === 'append' ? '뒤에 추가했어요' : '넣었어요'}.`, 'success');
  };

  const renderReview = () => {
    r.review.hidden = false;
    if (!rec.raw.length) {
      fill(r.review, el('p', { class: 'ed-hint' },
        '소리 막대가 움직이는지 확인해 보세요. 잘 안 잡히면 「마이크·보정」 화면에서 민감도를 높여 보세요.'));
      return;
    }
    const range = noteRange(rec.raw);
    const last = rec.raw[rec.raw.length - 1];
    const resetListen = () => {
      delete listenBtn.dataset.playing;
      listenBtn.textContent = '▶ 들어보기';
    };
    const listenBtn = btn('▶ 들어보기', async () => {
      if (listenBtn.dataset.playing) {
        stopPlayer(s);
        return;
      }
      try {
        const started = await playNotes(s, placed('replace'), { maxSec: 60, onEnd: resetListen });
        if (!started) return;
        listenBtn.dataset.playing = '1';
        listenBtn.textContent = '■ 정지';
      } catch (err) {
        console.error(err);
      }
    }, 'small');
    fill(r.review,
      el('div', { class: 'ed-rec-sum' },
        `노트 ${rec.raw.length}개 · 음역 ${range ? rangeText(range.min, range.max) : '-'} · 길이 ${fmtClock(last.t + last.d)}`),
      el('div', { class: 'ed-field' },
        el('span', { class: 'ed-label' }, '박자 맞춤 (양자화)'),
        seg([
          { value: 0, label: '끄기' },
          { value: 2, label: '8분음표' },
          { value: 4, label: '16분음표' },
        ], rec.quantize, (v) => { rec.quantize = Number(v); }, '박자 맞춤'),
      ),
      el('div', { class: 'ed-row ed-wrap-row' },
        listenBtn,
        btn('교체', () => applyRec('replace'), 'primary', { title: '지금 노트를 지우고 녹음한 노트로 바꿔요' }),
        btn('뒤에 추가', () => applyRec('append'), '', { title: '지금 노트 뒤 다음 마디부터 이어 붙여요' }),
      ),
      s.draft.notes.length ? el('p', { class: 'ed-hint muted' },
        `「교체」는 지금 노트 ${s.draft.notes.length}개를 바꾸고, 「뒤에 추가」는 마지막 노트 다음 마디부터 이어 붙여요.`) : null,
    );
  };

  prepareMic();
}

// ---------------------------------------------------------------------------
// Save / export / import / delete / navigation
// ---------------------------------------------------------------------------

function validateAll(s, { requireTitle = true } = {}) {
  const errs = validateBasics({
    title: s.draft.title,
    bpm: parseNum(s.ui.bpm.value),
    beatsPerBar: s.draft.beatsPerBar,
    offset: parseNum(s.ui.offset.value),
  });
  if (!requireTitle) delete errs.title;
  for (const key of ['title', 'bpm', 'beatsPerBar', 'offset']) {
    if (key === 'title' && !requireTitle) continue;
    setError(s, key, errs[key] || '');
  }
  return errs;
}

function focusFirstError(s, errs) {
  const order = [['title', s.ui.title], ['bpm', s.ui.bpm], ['beatsPerBar', s.ui.beats], ['offset', s.ui.offset]];
  for (const [key, ctl] of order) {
    if (errs[key]) {
      ctl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      ctl.focus({ preventScroll: true });
      s.app.toast(errs[key], 'error');
      return;
    }
  }
}

/** 저장/내보내기/미리듣기용 완성본 (가사 줄 계산 포함). */
function finalizeDraft(s, { fallbackTitle = false } = {}) {
  const d = cloneSong(s.draft);
  d.title = String(d.title || '').trim();
  if (!d.title && fallbackTitle) d.title = '제목 없음';
  d.artist = String(d.artist || '').trim();
  d.description = String(d.description || '').trim();
  d.notes = sortNotes(d.notes.map((n) => ({ ...n })));
  d.builtin = false;
  d.template = false;
  if (d.lyrics.source !== 'lrc') {
    const text = d.lyrics.text || '';
    d.lyrics = { text, source: 'notes', lines: text.trim() ? assignLyrics(text, d.notes).lines : [] };
  }
  d.updatedAt = Date.now();
  return normalizeSong(d);
}

async function save(s) {
  if (s.saving || s.disposed) return false;
  const errs = validateAll(s);
  if (Object.keys(errs).length) {
    focusFirstError(s, errs);
    return false;
  }
  const { app } = s;
  s.saving = true;
  renderActions(s);
  try {
    const song = finalizeDraft(s);
    if (s.audioChanged) {
      if (song.audio && s.audioBlob) {
        await app.library.saveAudio(song.id, s.audioBlob);
      } else if (!song.audio) {
        try { await app.library.removeAudio(song.id); } catch (err) { console.error(err); }
      }
    }
    const saved = await app.library.save(song);
    if (s.disposed) return true;
    const result = saved && typeof saved === 'object' && saved.id ? saved : song;
    let stored = null;
    try { stored = await app.library.get(song.id); } catch (err) { console.error(err); }
    if (s.disposed) return true;
    s.draft = normalizeSafe(result);
    s.stored = stored || { ...s.draft, builtin: false };
    s.sel = null;
    s.dirty = false;
    s.audioChanged = false;
    clearTimeout(s.recoveryTimer);
    clearRecovery();
    refreshLyrics(s);
    renderAll(s, true);
    app.toast(song.audio && s.audioMissing ? '저장했어요. (반주 음원 파일은 다시 선택해 주세요)' : '저장했어요.', 'success');
    return true;
  } catch (err) {
    console.error(err);
    const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message)));
    app.toast(quota ? '저장 공간이 부족해요. 큰 음원 파일을 빼고 다시 시도해 보세요.' : `저장하지 못했어요. ${err && err.message ? err.message : ''}`, 'error');
    return false;
  } finally {
    s.saving = false;
    if (!s.disposed) renderActions(s);
  }
}

function exportJson(s) {
  const errs = validateAll(s, { requireTitle: false });
  if (Object.keys(errs).length) {
    focusFirstError(s, errs);
    return;
  }
  try {
    const song = finalizeDraft(s, { fallbackTitle: true });
    downloadFile(`${fileBase(song.title)}.json`, serializeSong(song), 'application/json');
    s.app.toast(song.audio ? '곡 파일을 내보냈어요. 반주 음원 파일은 포함되지 않아요.' : '곡 파일을 내보냈어요.', 'success');
  } catch (err) {
    console.error(err);
    s.app.toast('곡 파일을 만들지 못했어요.', 'error');
  }
}

async function importJson(s) {
  const file = await pickFile('.json,application/json');
  if (!file || s.disposed) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    console.error(err);
    s.app.toast('JSON 파일을 읽지 못했어요.', 'error');
    return;
  }
  if (s.disposed) return;
  let raw = data;
  if (Array.isArray(data)) {
    const list = data.filter((x) => x && typeof x === 'object');
    if (!list.length) {
      s.app.toast('파일에 곡이 없어요.', 'error');
      return;
    }
    if (list.length === 1) {
      raw = list[0];
    } else {
      const idx = await choose(s, {
        title: '어떤 곡을 가져올까요?',
        message: `파일에 곡이 ${list.length}개 있어요. 지금 편집 중인 곡에 덮어쓸 곡을 고르세요.`,
        options: list.slice(0, 30).map((x, i) => ({
          value: i, label: `${x.title || '제목 없음'}${x.artist ? ` — ${x.artist}` : ''}`,
        })),
      });
      if (idx == null || s.disposed) return;
      raw = list[idx];
    }
  }
  let song;
  try {
    song = normalizeSong(raw);
  } catch (err) {
    s.app.toast(err && err.message ? err.message : '곡 파일 형식이 올바르지 않아요.', 'error');
    return;
  }
  const d = s.draft;
  if (d.notes.length || (d.lyrics.text || '').trim()) {
    const ok = await confirmDialog({
      title: '가져온 곡으로 바꿀까요?',
      message: `지금 편집 중인 내용을 "${song.title || '제목 없음'}"(노트 ${song.notes.length}개)로 바꿔요. 「되돌리기」로 되살릴 수 있어요.`,
      okText: '바꾸기',
      cancelText: '취소',
    });
    if (!ok || s.disposed) return;
  }
  pushUndo(s, 'JSON 가져오기', { basics: true });
  d.title = song.title || d.title;
  d.artist = song.artist || '';
  d.description = song.description || '';
  d.bpm = song.bpm;
  d.beatsPerBar = song.beatsPerBar;
  d.offset = song.offset;
  d.notes = song.notes;
  d.lyrics = song.lyrics;
  if (song.audio && s.audioBlob && d.audio) {
    d.audio = { ...d.audio, offset: song.audio.offset, volume: song.audio.volume };
  } else if (song.audio && !s.audioBlob) {
    s.app.toast('반주 음원 파일은 JSON에 들어 있지 않아요. 음원을 다시 선택해 주세요.');
  }
  s.sel = null;
  refreshLyrics(s);
  renderAll(s, true);
  markDirty(s);
  s.app.toast(`"${song.title || '제목 없음'}"을(를) 가져왔어요. 저장해야 반영돼요.`, 'success');
}

function preview(s, mode) {
  if (!isPlayable(s.draft)) {
    s.app.toast('노트가 없어서 들어볼 수 없어요. 먼저 멜로디를 만들어 주세요.', 'error');
    return;
  }
  const errs = validateAll(s, { requireTitle: false });
  if (Object.keys(errs).length) {
    focusFirstError(s, errs);
    return;
  }
  let song;
  try {
    song = finalizeDraft(s, { fallbackTitle: true });
  } catch (err) {
    console.error(err);
    s.app.toast('곡을 준비하지 못했어요.', 'error');
    return;
  }
  if (s.dirty) writeRecovery(s);
  const audioBlob = song.audio && s.audioBlob ? s.audioBlob : null;
  s.app.go('play', {
    song,
    mode,
    audioBlob,
    returnTo: 'editor',
    returnParams: {
      draft: cloneSong(s.draft),
      audioBlob: s.audioBlob,
      dirty: s.dirty,
      audioChanged: s.audioChanged,
      editorUi: { notationText: s.notationText, zoom: s.zoom, templateDesc: s.templateDesc, undo: s.undo },
    },
  });
}

function hasOverride(s) {
  const lib = s.app.library;
  try {
    if (typeof lib.hasOverride === 'function') return lib.hasOverride(s.draft.id);
  } catch (err) {
    console.error(err);
  }
  return Boolean(s.stored && s.stored.builtin !== true);
}

async function deleteOrReset(s) {
  const { app } = s;
  const id = s.draft.id;
  let builtin = false;
  try { builtin = app.library.isBuiltin(id); } catch { builtin = false; }
  try {
    if (builtin) {
      if (!hasOverride(s)) {
        app.toast('아직 저장한 편집 내용이 없어요.');
        return;
      }
      const ok = await confirmDialog({
        title: '기본 곡으로 되돌릴까요?',
        message: '저장한 노트·가사·반주 음원이 지워지고 처음 상태로 돌아가요. 되돌릴 수 없어요.',
        okText: '초기화',
        cancelText: '취소',
        danger: true,
      });
      if (!ok || s.disposed) return;
      await app.library.remove(id);
      clearRecovery();
      const song = await app.library.get(id);
      if (s.disposed) return;
      disposeAudioEl(s);
      s.draft = song ? normalizeSafe(song) : newSong();
      s.templateDesc = song && song.template ? song.description || '' : '';
      if (song && song.template) s.draft.description = '';
      s.stored = song || null;
      s.audioBlob = null;
      s.audioChanged = false;
      s.audioMissing = false;
      s.dirty = false;
      s.undo = [];
      s.sel = null;
      const guide = buildGuide(s);
      s.ui.guide.replaceWith(guide);
      s.ui.guide = guide;
      refreshLyrics(s);
      renderAll(s, true);
      app.toast('기본 곡으로 되돌렸어요.', 'success');
      return;
    }
    if (s.stored) {
      const ok = await confirmDialog({
        title: '곡을 삭제할까요?',
        message: `"${s.draft.title.trim() || '제목 없음'}" 곡과 반주 음원이 삭제돼요. 되돌릴 수 없어요.`,
        okText: '삭제',
        cancelText: '취소',
        danger: true,
      });
      if (!ok || s.disposed) return;
      await app.library.remove(id);
    } else if (s.dirty) {
      const ok = await confirmDialog({
        title: '이 곡을 버릴까요?',
        message: '저장하지 않은 새 곡이에요. 버리면 편집한 내용이 사라져요.',
        okText: '버리기',
        cancelText: '취소',
        danger: true,
      });
      if (!ok || s.disposed) return;
    }
    clearRecovery();
    s.dirty = false;
    app.go('home');
  } catch (err) {
    console.error(err);
    app.toast(`처리하지 못했어요. ${err && err.message ? err.message : ''}`, 'error');
  }
}

async function leave(s) {
  const { app } = s;
  if (s.dirty) {
    const choice = await choose(s, {
      title: '저장하지 않은 변경 사항이 있어요',
      message: '나가기 전에 저장할까요?',
      options: [
        { value: 'save', label: '저장하고 나가기', cls: 'primary' },
        { value: 'discard', label: '저장하지 않고 나가기', cls: 'danger' },
        { value: 'cancel', label: '계속 편집', cls: 'ghost' },
      ],
    });
    if (s.disposed || !choice || choice === 'cancel') return;
    if (choice === 'save') {
      const ok = await save(s);
      if (!ok || s.disposed) return;
    } else {
      clearTimeout(s.recoveryTimer);
      clearRecovery();
      s.dirty = false;
    }
  }
  app.back();
}
