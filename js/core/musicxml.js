// MusicXML import (.musicxml / .xml / compressed .mxl, e.g. produced by OMR tools from PDF sheet music):
// a small XML parser, a lenient score model (parts → staves → voices), repeat unfolding, a tempo map,
// and conversion of one melody track into app notes (seconds) plus lyric text in the app's lyric syntax.
// Pure module: no DOM access, importable in Node 22.

import { unzip } from './unzip.js';
import { tokenizeLine, groupNoteEvents } from './lyrics.js';

const ERR_XML = '악보 파일(XML)을 읽을 수 없어요.';
const ERR_READ = '악보 파일을 읽을 수 없어요.';
const ERR_EMPTY = '악보 파일이 비어 있어요.';
const ERR_PDF = 'PDF 악보는 바로 읽을 수 없어요. MuseScore·Audiveris 같은 악보 인식 프로그램으로 MusicXML(.musicxml/.mxl)로 변환한 뒤 선택해 주세요.';
const ERR_MIDI = 'MIDI 파일이에요. MIDI 가져오기를 이용해 주세요.';
const ERR_MXL_NO_SCORE = '압축 파일 안에서 MusicXML 악보를 찾을 수 없어요.';
const ERR_NOT_MUSICXML = 'MusicXML 악보 파일이 아니에요.';
const ERR_UNSUPPORTED = '지원하지 않는 형식의 MusicXML이에요. 악보 한 곡(score-partwise/score-timewise) 파일을 선택해 주세요.';
const ERR_NO_PARTS = '악보에 파트(악기)가 없어요.';
const ERR_SCORE = '악보 정보가 올바르지 않아요.';
const ERR_TRACK = '선택한 성부를 찾을 수 없어요.';
const ERR_NO_NOTES = '악보에서 음표를 찾지 못했어요.';
const ERR_MUSESCORE = 'MuseScore 파일(.mscz/.mscx)은 바로 열 수 없어요. MuseScore에서 MusicXML(.musicxml/.mxl)로 내보내 주세요.';

const WARN_NO_TEMPO = '악보에 빠르기 표시가 없어 BPM 100으로 맞췄어요. 필요하면 BPM을 바꿔 다시 가져오세요.';
const WARN_TEMPO_CHANGES = '곡 중간에 빠르기가 바뀌어요. 노트 시간에는 반영했고, 박자 격자는 처음 빠르기를 따라요.';
const WARN_CAP = '반복 구간이 너무 많아 2000마디까지만 펼쳤어요.';
const WARN_NO_SEGNO = '달 세뇨(D.S.) 표시가 가리키는 세뇨 표시를 찾지 못해 무시했어요.';
const WARN_INFERRED = '도돌이 지시(D.C./D.S./Fine/Coda)를 악보 글자에서 추정해 펼쳤어요. 순서가 맞는지 확인해 주세요.';
const WARN_NO_LYRICS = '악보에 가사가 없어요.';
const warnLyricsElsewhere = (label) => `선택한 성부에는 가사가 없어요. 가사가 있는 성부: ${label}`;
const WARN_NO_NOTES = '선택한 성부에 음표가 없어요.';
const WARN_ALIGN = '일부 가사 줄의 정렬을 확인해 주세요.';
const warnVerse = (n) => `${n}절 가사가 없는 부분은 다른 절 가사를 사용했어요.`;
const warnDropped = (n) => `음역을 벗어난 노트 ${n}개를 뺐어요.`;

const EPS = 1e-6;
const MAX_PLAYED = 2000;
const MAX_ENDING_LEN = 32;
const TIE_MAX_GAP = 1; // quarters between a tie start's end and its stop note
const MIN_NOTE_D = 0.03;
const DEFAULT_BPM = 100;
const LINE_MAX_SYLLABLES = 16;
const BREAK_SYSTEM = 1;
const BREAK_JUMP = 2;
const MIN_BPM = 10;
const MAX_BPM = 400;

const r3 = (x) => Math.round(x * 1000) / 1000;
const r2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const cleanSpace = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- XML

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][\w.-]*);/g;
const NAME_START_RE = /^[A-Za-z_:\u00c0-\uffff]/;

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(ENTITY_RE, (m, e) => {
    if (e.charCodeAt(0) === 35) {
      const hex = e[1] === 'x' || e[1] === 'X';
      const cp = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return String.fromCodePoint(cp);
      return m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : m;
  });
}

const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13;
const isNameEnd = (c) => isWs(c) || c === 47 || c === 62 || c === 61; // '/', '>', '='

/**
 * Minimal XML parser → root element { name, attrs, children, text }. `text` is the element's own
 * character data (entities decoded, CDATA included; whitespace-only text of container elements is
 * dropped). Prolog, DOCTYPE (with internal subset), comments and processing instructions are skipped.
 */
export function parseXml(text) {
  if (typeof text !== 'string') throw new Error(ERR_XML);
  const src = text;
  const len = src.length;
  const doc = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [doc];
  let top = doc;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = () => {
    throw new Error(ERR_XML);
  };

  while (i < len) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      if (top !== doc) top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i && top !== doc) top.text += decodeEntities(src.slice(i, lt));
    const c = src.charCodeAt(lt + 1);

    if (c === 33) { // '<!'
      if (src.startsWith('<!--', lt)) {
        const e = src.indexOf('-->', lt + 4);
        if (e < 0) fail();
        i = e + 3;
        continue;
      }
      if (src.startsWith('<![CDATA[', lt)) {
        const e = src.indexOf(']]>', lt + 9);
        if (e < 0) fail();
        if (top !== doc) top.text += src.slice(lt + 9, e);
        i = e + 3;
        continue;
      }
      // <!DOCTYPE ...> or another declaration, possibly with an internal subset [...]
      let j = lt + 2;
      let depth = 0;
      let quote = 0;
      for (; j < len; j++) {
        const ch = src.charCodeAt(j);
        if (quote) {
          if (ch === quote) quote = 0;
        } else if (ch === 34 || ch === 39) {
          quote = ch;
        } else if (ch === 91) {
          depth++;
        } else if (ch === 93) {
          depth--;
        } else if (ch === 62 && depth <= 0) {
          break;
        }
      }
      if (j >= len) fail();
      i = j + 1;
      continue;
    }

    if (c === 63) { // '<?'
      const e = src.indexOf('?>', lt + 2);
      if (e < 0) fail();
      i = e + 2;
      continue;
    }

    if (c === 47) { // '</'
      const e = src.indexOf('>', lt + 2);
      if (e < 0) fail();
      const name = src.slice(lt + 2, e).trim();
      if (top === doc || name !== top.name) fail();
      if (top.children.length && !/\S/.test(top.text)) top.text = '';
      stack.pop();
      top = stack[stack.length - 1];
      i = e + 1;
      continue;
    }

    // Start tag.
    let j = lt + 1;
    while (j < len && !isNameEnd(src.charCodeAt(j))) j++;
    const name = src.slice(lt + 1, j);
    if (!name || !NAME_START_RE.test(name)) fail();
    const attrs = {};
    let selfClose = false;
    for (;;) {
      while (j < len && isWs(src.charCodeAt(j))) j++;
      if (j >= len) fail();
      const ch = src.charCodeAt(j);
      if (ch === 62) {
        j++;
        break;
      }
      if (ch === 47) {
        if (src.charCodeAt(j + 1) !== 62) fail();
        selfClose = true;
        j += 2;
        break;
      }
      const ns = j;
      while (j < len && !isNameEnd(src.charCodeAt(j))) j++;
      const an = src.slice(ns, j);
      if (!an) fail();
      while (j < len && isWs(src.charCodeAt(j))) j++;
      let value = '';
      if (src.charCodeAt(j) === 61) {
        j++;
        while (j < len && isWs(src.charCodeAt(j))) j++;
        const q = src.charCodeAt(j);
        if (q === 34 || q === 39) {
          const e = src.indexOf(q === 34 ? '"' : "'", j + 1);
          if (e < 0) fail();
          value = decodeEntities(src.slice(j + 1, e));
          j = e + 1;
        } else {
          const vs = j;
          while (j < len && !isWs(src.charCodeAt(j)) && src.charCodeAt(j) !== 62
            && !(src.charCodeAt(j) === 47 && src.charCodeAt(j + 1) === 62)) j++;
          if (j === vs) fail();
          value = decodeEntities(src.slice(vs, j));
        }
      }
      if (an !== '__proto__') attrs[an] = value;
    }
    const node = { name, attrs, children: [], text: '' };
    top.children.push(node);
    if (!selfClose) {
      stack.push(node);
      top = node;
    }
    i = j;
  }
  if (stack.length > 1) fail();
  const root = doc.children[0];
  if (!root) fail();
  return root;
}

function child(node, name) {
  const cs = node.children;
  for (let k = 0; k < cs.length; k++) if (cs[k].name === name) return cs[k];
  return null;
}

function childText(node, name) {
  const c = child(node, name);
  return c ? c.text.trim() : '';
}

function childNum(node, name) {
  const s = childText(node, name);
  return s ? Number(s) : NaN;
}

function stripPrefixes(node) {
  const k = node.name.indexOf(':');
  if (k >= 0) node.name = node.name.slice(k + 1);
  for (const c of node.children) stripPrefixes(c);
}

// ---------------------------------------------------------------- file reading

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  const tag = Object.prototype.toString.call(input);
  if (input instanceof ArrayBuffer || tag === '[object ArrayBuffer]') return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error(ERR_READ);
}

function tryDecode(bytes, encoding, fatal) {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeUtf16(bytes, littleEndian) {
  const s = tryDecode(bytes, littleEndian ? 'utf-16le' : 'utf-16be', false);
  if (s !== null) return s;
  const units = [];
  for (let p = 0; p + 1 < bytes.length; p += 2) {
    units.push(littleEndian ? bytes[p] | (bytes[p + 1] << 8) : (bytes[p] << 8) | bytes[p + 1]);
  }
  let out = '';
  for (let p = 0; p < units.length; p += 8192) out += String.fromCharCode(...units.slice(p, p + 8192));
  return out;
}

// Bytes of an XML document → string (BOM / UTF-16 detection, declared encoding, Korean legacy fallback).
function decodeXmlBytes(b) {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return tryDecode(b.subarray(3), 'utf-8', false);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return decodeUtf16(b.subarray(2), true);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return decodeUtf16(b.subarray(2), false);
  if (b.length >= 4 && b[0] === 0x3c && b[1] === 0 && b[3] === 0) return decodeUtf16(b, true);
  if (b.length >= 4 && b[0] === 0 && b[1] === 0x3c && b[2] === 0) return decodeUtf16(b, false);
  const utf8 = tryDecode(b, 'utf-8', true);
  if (utf8 !== null) return utf8;
  const head = String.fromCharCode(...b.subarray(0, 256));
  const m = /encoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(head);
  const declared = m && !/^utf-?(8|16)$/i.test(m[1]) ? m[1] : null;
  for (const [enc, fatal] of [[declared, false], ['euc-kr', true], ['windows-1252', false]]) {
    if (!enc) continue;
    const s = tryDecode(b, enc, fatal);
    if (s !== null) return s;
  }
  return tryDecode(b, 'utf-8', false);
}

const startsWithAscii = (b, s) => {
  if (b.length < s.length) return false;
  for (let k = 0; k < s.length; k++) if (b[k] !== s.charCodeAt(k)) return false;
  return true;
};

const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');

function collect(node, name, out) {
  if (node.name === name) out.push(node);
  for (const c of node.children) collect(c, name, out);
  return out;
}

async function readMxl(b) {
  const files = await unzip(b);
  const byLower = new Map();
  for (const k of files.keys()) byLower.set(normPath(k).toLowerCase(), k);
  const lookup = (p) => {
    const k = files.has(p) ? p : byLower.get(normPath(p).toLowerCase());
    return k === undefined ? null : files.get(k);
  };
  let data = null;
  const container = lookup('META-INF/container.xml');
  if (container) {
    try {
      const doc = parseXml(decodeXmlBytes(container));
      for (const rf of collect(doc, 'rootfile', [])) {
        const type = (rf.attrs['media-type'] || '').toLowerCase();
        if (type && !type.includes('musicxml') && !type.endsWith('xml')) continue;
        data = lookup(rf.attrs['full-path'] || '');
        if (data) break;
      }
    } catch {
      data = null;
    }
  }
  for (const ext of [/\.musicxml$/i, /\.xml$/i]) {
    if (data) break;
    for (const [k, v] of files) {
      const p = normPath(k);
      if (!/^meta-inf\//i.test(p) && ext.test(p)) {
        data = v;
        break;
      }
    }
  }
  if (!data) throw new Error(ERR_MXL_NO_SCORE);
  return decodeXmlBytes(data);
}

/** File bytes (.musicxml / .xml / .mxl) → MusicXML text. Throws Korean errors. */
export async function readScoreText(bytes) {
  const b = toBytes(bytes);
  if (!b.length) throw new Error(ERR_EMPTY);
  if (b[0] === 0x50 && b[1] === 0x4b) return readMxl(b);
  if (startsWithAscii(b, '%PDF')) throw new Error(ERR_PDF);
  if (startsWithAscii(b, 'MThd')) throw new Error(ERR_MIDI);
  const text = decodeXmlBytes(b);
  if (text === null || !text.trim()) throw new Error(ERR_EMPTY);
  return text;
}

export function isScoreFileName(name) {
  return typeof name === 'string' && /\.(musicxml|xml|mxl)$/i.test(name.trim());
}

// ---------------------------------------------------------------- score model

const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const TYPE_Q = {
  '1024th': 1 / 256, '512th': 1 / 128, '256th': 1 / 64, '128th': 1 / 32, '64th': 1 / 16, '32nd': 1 / 8,
  '16th': 1 / 4, eighth: 1 / 2, quarter: 1, half: 2, whole: 4, breve: 8, long: 16, maxima: 32,
};
const SYLLABIC = new Set(['single', 'begin', 'middle', 'end']);
const GENERIC_PART_RE = /^(musicxml\s*part|part\s*\d*|p\d+|staff\s*\d*|instrument\s*\d*|unnamed.*|untitled.*|track\s*\d*)$/i;
const PART_NAMES_KO = [
  [/^(?:lead\s*)?(?:voice|vocals?|vox|singer)(?:\s*(\d+))?$/i, '보컬'],
  [/^(?:acoustic\s*)?(?:grand\s*)?piano(?:forte)?(?:\s*(\d+))?$/i, '피아노'],
  [/^melody(?:\s*(\d+))?$/i, '멜로디'],
];
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f\u200b-\u200d\u2028\u2029\ufeff]/g;

function displayPartName(raw, index) {
  const name = cleanSpace(raw);
  if (!name || GENERIC_PART_RE.test(name)) return `파트 ${index + 1}`;
  for (const [re, ko] of PART_NAMES_KO) {
    const m = re.exec(name);
    if (m) return m[1] ? `${ko} ${m[1]}` : ko;
  }
  return name;
}

const expectedQ = (ts) => (ts.num * 4) / ts.den;

function emptyFlow() {
  return {
    repeatForward: false, repeatBackward: false, times: 0, endingStart: null, endingStop: false,
    segno: null, coda: null, tocoda: null, dacapo: false, dalsegno: null, fine: false,
    newSystem: false, inferred: false, explicit: false,
  };
}

function newMeasure(ts, implicit) {
  return { notes: [], tempos: [], ts, actual: 0, implicit, flow: emptyFlow() };
}

function parseTime(el) {
  if (!el || child(el, 'senza-misura')) return null;
  const beats = [];
  const types = [];
  for (const c of el.children) {
    if (c.name === 'beats') beats.push(c.text.split('+').reduce((s, x) => s + (Number(x) || 0), 0));
    else if (c.name === 'beat-type') types.push(Number(c.text));
  }
  let quarters = 0;
  let maxDen = 0;
  let sameDen = true;
  for (let k = 0; k < beats.length && k < types.length; k++) {
    const num = beats[k];
    const den = types[k];
    if (!(num > 0) || !(den > 0)) return null;
    quarters += (num * 4) / den;
    if (maxDen && den !== maxDen) sameDen = false;
    maxDen = Math.max(maxDen, den);
  }
  if (!(quarters > 0)) return null;
  const num = sameDen ? beats.slice(0, types.length).reduce((s, x) => s + x, 0) : Math.round((quarters * maxDen) / 4);
  return num >= 1 ? { num: Math.round(num), den: maxDen } : null;
}

function noteTypeQ(el) {
  const type = childText(el, 'type');
  let q = TYPE_Q[type];
  if (q === undefined) return null;
  let add = q / 2;
  for (const c of el.children) {
    if (c.name === 'dot') {
      q += add;
      add /= 2;
    }
  }
  const tm = child(el, 'time-modification');
  if (tm) {
    const actual = childNum(tm, 'actual-notes');
    const normal = childNum(tm, 'normal-notes');
    if (actual > 0 && normal > 0) q = (q * normal) / actual;
  }
  return q;
}

function durationQ(el, divisions) {
  const d = childNum(el, 'duration');
  return Number.isFinite(d) && d >= 0 ? d / divisions : null;
}

function clampBpm(v) {
  return clamp(v, MIN_BPM, MAX_BPM);
}

function metronomeBpm(el) {
  const units = el.children.filter((c) => c.name === 'beat-unit');
  const pm = child(el, 'per-minute');
  if (!pm || units.length !== 1) return null;
  const m = /\d+(?:[.,]\d+)?/.exec(pm.text);
  const n = m ? Number(m[0].replace(',', '.')) : NaN;
  if (!(n > 0)) return null;
  let q = TYPE_Q[units[0].text.trim()] || 1;
  let add = q / 2;
  for (const c of el.children) {
    if (c.name === 'beat-unit-dot') {
      q += add;
      add /= 2;
    }
  }
  return clampBpm(n * q);
}

// Tempo printed only as text (typical OMR output): '♩ = 76', 'J=76' (OCR of ♩), '♪. = 120', '= 80'.
const WORDS_TEMPO_RE = /(?:^|[\s(])(?:(♩|♪|\u{1D15F}|\u{1D15E}|\u{1D160}|[Jjq])(\.?)\s*)?=\s*(?:c\.|ca\.|약)?\s*(\d{2,3})(?![\d.])/u;
const WORDS_TEMPO_UNIT = { '♩': 1, J: 1, j: 1, q: 1, '\u{1D15F}': 1, '♪': 0.5, '\u{1D160}': 0.5, '\u{1D15E}': 2 };

function wordsTempo(words) {
  const m = WORDS_TEMPO_RE.exec(` ${cleanSpace(words)}`);
  if (!m) return null;
  const n = Number(m[3]);
  if (n < 30 || n > 300) return null;
  const unit = m[1] ? WORDS_TEMPO_UNIT[m[1]] : 1;
  return clampBpm(n * unit * (m[2] ? 1.5 : 1));
}

const isYes = (v) => v !== undefined && v.trim().toLowerCase() !== 'no';

function applySound(snd, pos, m) {
  const a = snd.attrs;
  const f = m.flow;
  let tempo = false;
  let flow = false;
  const tv = Number(a.tempo);
  if (a.tempo !== undefined && tv > 0 && Number.isFinite(tv)) {
    m.tempos.push({ pos, bpm: clampBpm(tv) });
    tempo = true;
  }
  if (isYes(a.dacapo)) {
    f.dacapo = true;
    flow = true;
  }
  if (a.dalsegno !== undefined) {
    f.dalsegno = a.dalsegno.trim();
    flow = true;
  }
  if (a.segno !== undefined) {
    f.segno = a.segno.trim();
    flow = true;
  }
  if (a.coda !== undefined) {
    f.coda = a.coda.trim();
    flow = true;
  }
  if (a.tocoda !== undefined) {
    f.tocoda = a.tocoda.trim();
    flow = true;
  }
  if (a.fine !== undefined && a.fine.trim().toLowerCase() !== 'no') {
    f.fine = true;
    flow = true;
  }
  if (flow) f.explicit = true;
  return { tempo, flow };
}

const DC_RE = /(^|[^a-z])d\.?\s?c\.?(?![a-z])|da\s*capo/i;
const DS_RE = /(^|[^a-z])d\.?\s?s\.?(?![a-z])|dal\s*segno/i;

// Best effort for OMR output that carries only the printed words (no <sound> playback attributes).
function inferFlow(words, segnoSym, codaSym, m) {
  const f = m.flow;
  const w = cleanSpace(words);
  if (segnoSym && f.segno === null) f.segno = '';
  let toCoda = false;
  if (w) {
    if (DC_RE.test(w)) {
      f.dacapo = true;
      f.inferred = true;
    } else if (DS_RE.test(w)) {
      if (f.dalsegno === null) f.dalsegno = '';
      f.inferred = true;
    }
    if (/to\s*(coda|⊕|𝄌)/i.test(w)) {
      toCoda = true;
      if (f.tocoda === null) f.tocoda = '';
      f.inferred = true;
    } else if (/^fine\.?$/i.test(w)) {
      f.fine = true;
      f.inferred = true;
    } else if (/^coda\.?$/i.test(w) && f.coda === null) {
      f.coda = '';
    }
  }
  if (codaSym && !toCoda && f.tocoda === null && f.coda === null) f.coda = '';
}

function parseDirection(el, pos, m) {
  let words = '';
  let metronome = null;
  let segnoSym = false;
  let codaSym = false;
  for (const c of el.children) {
    if (c.name !== 'direction-type') continue;
    for (const d of c.children) {
      if (d.name === 'words') words += (words ? ' ' : '') + d.text;
      else if (d.name === 'metronome' && metronome === null) metronome = metronomeBpm(d);
      else if (d.name === 'segno') segnoSym = true;
      else if (d.name === 'coda') codaSym = true;
    }
  }
  const snd = child(el, 'sound');
  const set = snd ? applySound(snd, pos, m) : { tempo: false, flow: false };
  if (!set.tempo) {
    const bpm = metronome || wordsTempo(words);
    if (bpm) m.tempos.push({ pos, bpm });
  }
  if (!set.flow) inferFlow(words, segnoSym, codaSym, m);
}

function parseEndingNumbers(s) {
  const out = [];
  for (const mm of String(s || '').matchAll(/(\d+)\s*[-–]\s*(\d+)|(\d+)/g)) {
    if (mm[1]) {
      const a = Number(mm[1]);
      const b = Math.min(Number(mm[2]), a + 16);
      for (let k = a; k <= b; k++) out.push(k);
    } else {
      out.push(Number(mm[3]));
    }
  }
  return out;
}

function parseBarline(el, m) {
  const f = m.flow;
  for (const c of el.children) {
    if (c.name === 'repeat') {
      const dir = (c.attrs.direction || '').trim();
      if (dir === 'forward') {
        f.repeatForward = true;
      } else if (dir === 'backward') {
        f.repeatBackward = true;
        const t = parseInt(c.attrs.times, 10);
        if (t >= 1 && t <= 16) f.times = t;
      }
    } else if (c.name === 'ending') {
      const type = (c.attrs.type || '').trim();
      if (type === 'start') f.endingStart = parseEndingNumbers(c.attrs.number !== undefined ? c.attrs.number : c.text);
      else if (type === 'stop' || type === 'discontinue') f.endingStop = true;
    } else if (c.name === 'segno' && f.segno === null) {
      f.segno = '';
    } else if (c.name === 'coda' && f.coda === null) {
      f.coda = '';
    }
  }
}

function lyricSyllableCount(text) {
  let n = 0;
  for (const tk of tokenizeLine(text)) if (tk.type === 'syl') n++;
  return n;
}

// Lyric kinds: 'text' (sung syllable(s)), 'punct' (punctuation only → glued to the previous syllable),
// 'melisma' (extender / hyphen glyphs only, or an <extend> without text), 'empty'.
function classifyLyric(number, raw, firstSyl, lastSyl, extend) {
  let s = raw.normalize('NFC').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  let joinPrev = firstSyl === 'middle' || firstSyl === 'end';
  let joinNext = lastSyl === 'begin' || lastSyl === 'middle';
  if (/^[\s_~～\-–—‿]*$/.test(s)) {
    return { number, kind: s || extend ? 'melisma' : 'empty', text: '', count: 0, joinPrev, joinNext, extend };
  }
  if (/^[-–]/.test(s)) {
    joinPrev = true;
    s = s.replace(/^[-–]+\s*/, '');
  }
  if (/[-–]$/.test(s)) {
    joinNext = true;
    s = s.replace(/\s*[-–]+$/, '');
  }
  s = s
    .replace(/[{}]/g, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/[~～_]+/g, ' ')
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { number, kind: 'empty', text: '', count: 0, joinPrev, joinNext, extend };
  const count = lyricSyllableCount(s);
  return { number, kind: count ? 'text' : 'punct', text: s, count, joinPrev, joinNext, extend };
}

function parseLyric(el) {
  const digits = String(el.attrs.number || el.attrs.name || '').match(/\d+/g);
  let number = digits ? parseInt(digits[digits.length - 1], 10) : 1;
  if (!(number >= 1 && number <= 99)) number = 1;
  const segs = [];
  let cur = null;
  let elision = false;
  let extend = null;
  for (const c of el.children) {
    if (c.name === 'syllabic') {
      const v = c.text.trim().toLowerCase();
      cur = SYLLABIC.has(v) ? v : 'single';
    } else if (c.name === 'text') {
      segs.push({ syl: cur || 'single', text: c.text, sep: segs.length ? (elision ? ' ' : '') : '' });
      cur = null;
      elision = false;
    } else if (c.name === 'elision') {
      elision = true;
    } else if (c.name === 'extend') {
      extend = (c.attrs.type || 'start').trim() || 'start';
    }
  }
  const raw = segs.map((s) => s.sep + s.text).join('');
  const firstSyl = segs.length ? segs[0].syl : 'single';
  const lastSyl = segs.length ? segs[segs.length - 1].syl : 'single';
  return classifyLyric(number, raw, firstSyl, lastSyl, extend);
}

function normVoice(v) {
  const s = cleanSpace(v);
  if (!s) return '1';
  return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s;
}

function parsePart(partEl, index, names) {
  const id = partEl.attrs.id || `P${index + 1}`;
  const part = { id, index, name: displayPartName(names.get(id), index), staves: 1, measures: [] };
  let divisions = 1;
  let ts = { num: 4, den: 4 };
  const transpose = new Map(); // staff number (0 = all staves) → semitones written → concert

  for (const mEl of partEl.children) {
    if (mEl.name !== 'measure') continue;
    const m = newMeasure(ts, mEl.attrs.implicit === 'yes');
    let cursor = 0;
    let maxPos = 0;
    let lastStart = null;
    let lastDur = 0;

    for (const el of mEl.children) {
      switch (el.name) {
        case 'attributes': {
          const dv = childNum(el, 'divisions');
          if (dv > 0) divisions = dv;
          const st = childNum(el, 'staves');
          if (st >= 1) part.staves = Math.max(part.staves, Math.floor(st));
          const t = parseTime(child(el, 'time'));
          if (t) {
            ts = t;
            if (cursor <= EPS) m.ts = t;
          }
          for (const c of el.children) {
            if (c.name !== 'transpose') continue;
            const chrom = childNum(c, 'chromatic');
            const oct = childNum(c, 'octave-change');
            const semis = (Number.isFinite(chrom) ? chrom : 0) + 12 * (Number.isFinite(oct) ? oct : 0);
            const staffNo = parseInt(c.attrs.number, 10);
            if (staffNo >= 1) {
              transpose.set(staffNo, semis);
            } else {
              transpose.clear();
              transpose.set(0, semis);
            }
          }
          break;
        }
        case 'note': {
          if (child(el, 'grace')) break;
          const chord = Boolean(child(el, 'chord')) && lastStart !== null;
          const rest = child(el, 'rest');
          let dq = durationQ(el, divisions);
          if (dq === null) dq = chord ? lastDur : noteTypeQ(el);
          if (dq === null) dq = rest && rest.attrs.measure === 'yes' ? expectedQ(m.ts) : 1;
          let start;
          if (chord) {
            start = lastStart;
          } else {
            start = cursor;
            lastStart = cursor;
            lastDur = dq;
            cursor += dq;
            if (cursor > maxPos) maxPos = cursor;
          }
          if (rest || child(el, 'cue')) break;
          const pitch = child(el, 'pitch');
          if (!pitch) break; // unpitched
          const pc = STEP_PC[childText(pitch, 'step').toUpperCase()];
          const octave = childNum(pitch, 'octave');
          if (pc === undefined || !Number.isFinite(octave)) break;
          const alter = childNum(pitch, 'alter');
          const staffNo = parseInt(childText(el, 'staff'), 10);
          const staff = staffNo >= 1 ? staffNo : 1;
          const shift = transpose.has(staff) ? transpose.get(staff) : transpose.get(0) || 0;
          const midi = Math.round((octave + 1) * 12 + pc + (Number.isFinite(alter) ? alter : 0) + shift);
          if (!Number.isFinite(midi)) break;
          let tieStart = false;
          let tieStop = false;
          const lyrics = [];
          for (const c of el.children) {
            if (c.name === 'tie') {
              const type = c.attrs.type;
              if (type === 'start') tieStart = true;
              else if (type === 'stop') tieStop = true;
            } else if (c.name === 'notations') {
              for (const t of c.children) {
                if (t.name !== 'tied') continue;
                const type = t.attrs.type;
                if (type === 'start') tieStart = true;
                else if (type === 'stop') tieStop = true;
                else if (type === 'continue') tieStart = tieStop = true;
              }
            } else if (c.name === 'lyric') {
              const lyr = parseLyric(c);
              if (lyr.kind !== 'empty' && !lyrics.some((l) => l.number === lyr.number)) lyrics.push(lyr);
            }
          }
          if (staff > part.staves) part.staves = staff;
          m.notes.push({
            pos: start, dur: Math.max(0, dq), midi, staff, voice: normVoice(childText(el, 'voice')),
            home: staff, tieStart, tieStop, lyrics,
          });
          break;
        }
        case 'backup': {
          const d = durationQ(el, divisions);
          if (d !== null) cursor = Math.max(0, cursor - d);
          lastStart = null;
          break;
        }
        case 'forward': {
          const d = durationQ(el, divisions);
          if (d !== null) {
            cursor += d;
            if (cursor > maxPos) maxPos = cursor;
          }
          lastStart = null;
          break;
        }
        case 'direction': {
          const off = childNum(el, 'offset');
          parseDirection(el, Math.max(0, cursor + (Number.isFinite(off) ? off / divisions : 0)), m);
          break;
        }
        case 'sound':
          applySound(el, cursor, m);
          break;
        case 'barline':
          parseBarline(el, m);
          break;
        case 'print':
          if (el.attrs['new-system'] === 'yes' || el.attrs['new-page'] === 'yes') m.flow.newSystem = true;
          break;
        default:
          break;
      }
    }
    m.actual = maxPos;
    part.measures.push(m);
  }
  return part;
}

function measureLength(m, i, n) {
  const exp = expectedQ(m.ts);
  const act = m.actual;
  if (act <= EPS) return exp;
  if (m.implicit || act > exp + EPS) return act;
  if (act < exp - EPS && (i === 0 || i === n - 1)) return act; // pickup / closing partial measure
  return exp;
}

// Voices are melodic identities; a voice briefly crossing to another staff stays with its main staff,
// while a voice id reused for real on several staves is split per staff.
function assignHomeStaves(part) {
  const counts = new Map();
  for (const m of part.measures) {
    for (const n of m.notes) {
      let byStaff = counts.get(n.voice);
      if (!byStaff) counts.set(n.voice, (byStaff = new Map()));
      byStaff.set(n.staff, (byStaff.get(n.staff) || 0) + 1);
    }
  }
  const home = new Map();
  for (const [voice, byStaff] of counts) {
    let total = 0;
    let main = null;
    for (const [s, c] of byStaff) {
      total += c;
      if (main === null || c > byStaff.get(main) || (c === byStaff.get(main) && s < main)) main = s;
    }
    for (const [s, c] of byStaff) home.set(`${voice}|${s}`, s === main || (c >= 4 && c / total >= 0.2) ? s : main);
  }
  for (const m of part.measures) for (const n of m.notes) n.home = home.get(`${n.voice}|${n.staff}`) || n.staff;
}

const voiceSort = (a, b) => {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
};

function trackDefs(part) {
  const byStaff = new Map();
  for (const m of part.measures) {
    for (const n of m.notes) {
      let set = byStaff.get(n.home);
      if (!set) byStaff.set(n.home, (set = new Set()));
      set.add(n.voice);
    }
  }
  const defs = [];
  const staves = [...byStaff.keys()].sort((a, b) => a - b);
  for (const s of staves) {
    const voices = [...byStaff.get(s)].sort(voiceSort);
    for (const v of voices) {
      defs.push({ key: `${part.id}|s${s}|v${v}`, staff: s, voice: v, label: `${part.name} · ${s}단 · 성부 ${v}` });
    }
    if (voices.length > 1) {
      defs.push({ key: `${part.id}|s${s}|*`, staff: s, voice: null, label: `${part.name} · ${s}단 · 모든 성부` });
    }
  }
  if (staves.length > 1) defs.push({ key: `${part.id}|*|*`, staff: null, voice: null, label: `${part.name} · 전체` });
  return defs;
}

function timewiseToPartwise(root) {
  const out = { name: 'score-partwise', attrs: { ...root.attrs }, children: [], text: '' };
  const parts = new Map();
  let measureIndex = 0;
  for (const c of root.children) {
    if (c.name !== 'measure') {
      out.children.push(c);
      continue;
    }
    for (const pc of c.children) {
      if (pc.name !== 'part') continue;
      const id = pc.attrs.id || '';
      let p = parts.get(id);
      if (!p) parts.set(id, (p = { name: 'part', attrs: { id }, children: [], text: '' }));
      while (p.children.length < measureIndex) p.children.push({ name: 'measure', attrs: {}, children: [], text: '' });
      if (p.children.length === measureIndex) {
        p.children.push({ name: 'measure', attrs: { ...c.attrs }, children: pc.children, text: '' });
      }
    }
    measureIndex++;
  }
  for (const p of parts.values()) out.children.push(p);
  return out;
}

function readMeta(root) {
  const work = child(root, 'work');
  let title = cleanSpace(work ? childText(work, 'work-title') : '') || cleanSpace(childText(root, 'movement-title'));
  let composer = '';
  let lyricist = '';
  const ident = child(root, 'identification');
  if (ident) {
    for (const c of ident.children) {
      if (c.name !== 'creator') continue;
      const type = (c.attrs.type || '').toLowerCase();
      const v = cleanSpace(c.text);
      if (!v) continue;
      if (type === 'composer' && !composer) composer = v;
      else if ((type === 'lyricist' || type === 'poet' || type === 'words') && !lyricist) lyricist = v;
    }
  }
  for (const c of root.children) {
    if (c.name !== 'credit') continue;
    const types = c.children.filter((x) => x.name === 'credit-type').map((x) => x.text.trim().toLowerCase());
    const words = cleanSpace(c.children.filter((x) => x.name === 'credit-words').map((x) => x.text).join(' '));
    if (!words) continue;
    if (types.includes('title') && !title) title = words;
    else if (types.includes('composer') && !composer) composer = words;
    else if ((types.includes('lyricist') || types.includes('poet')) && !lyricist) lyricist = words;
  }
  return { title, composer, lyricist };
}

function readPartNames(root) {
  const out = new Map();
  const pl = child(root, 'part-list');
  if (!pl) return out;
  for (const sp of pl.children) {
    if (sp.name !== 'score-part') continue;
    let name = cleanSpace(childText(sp, 'part-name'));
    if (!name || GENERIC_PART_RE.test(name)) {
      const inst = child(sp, 'score-instrument');
      const instName = inst ? cleanSpace(childText(inst, 'instrument-name')) : '';
      if (instName) name = instName;
    }
    out.set(sp.attrs.id || '', name);
  }
  return out;
}

function mergeFlow(into, f) {
  for (const k of ['repeatForward', 'repeatBackward', 'endingStop', 'dacapo', 'fine', 'newSystem', 'inferred', 'explicit']) {
    if (f[k]) into[k] = true;
  }
  for (const k of ['segno', 'coda', 'tocoda', 'dalsegno', 'endingStart']) {
    if (into[k] === null && f[k] !== null) into[k] = f[k];
  }
  if (f.times > into.times) into.times = f.times;
}

// Volta brackets: group per starting measure, chained when consecutive; numbers default to the ordinal.
function buildEndings(flow) {
  const n = flow.length;
  const at = new Array(n).fill(null);
  const groups = [];
  for (let s = 0; s < n; s++) {
    if (!flow[s].endingStart || at[s]) continue;
    let end = -1;
    for (let j = s; j < n && j - s < MAX_ENDING_LEN; j++) {
      if (j > s && (flow[j].endingStart || flow[j].repeatForward)) {
        end = j - 1;
        break;
      }
      if (flow[j].endingStop || flow[j].repeatBackward) {
        end = j;
        break;
      }
    }
    if (end < 0) end = s;
    const g = { start: s, end, numbers: flow[s].endingStart.slice(), backward: flow[end].repeatBackward, chainMax: 0 };
    groups.push(g);
    for (let j = s; j <= end; j++) at[j] = g;
  }
  let chain = [];
  const closeChain = () => {
    let max = 0;
    for (const g of chain) for (const x of g.numbers) if (x > max) max = x;
    for (const g of chain) g.chainMax = max;
    chain = [];
  };
  for (const g of groups) {
    if (chain.length && g.start !== chain[chain.length - 1].end + 1) closeChain();
    if (!g.numbers.length) g.numbers = [chain.length + 1];
    chain.push(g);
  }
  closeChain();
  return at;
}

/** MusicXML text → Score (see module docs; `_internal` holds the parsed model for scoreToSong). */
export function parseMusicXml(xmlText) {
  let root = parseXml(xmlText);
  if (root.name.includes(':')) stripPrefixes(root);
  if (root.name === 'score-timewise') root = timewiseToPartwise(root);
  else if (root.name === 'opus') throw new Error(ERR_UNSUPPORTED);
  else if (root.name === 'museScore') throw new Error(ERR_MUSESCORE);
  else if (root.name !== 'score-partwise') throw new Error(ERR_NOT_MUSICXML);

  const meta = readMeta(root);
  const names = readPartNames(root);
  const partEls = root.children.filter((c) => c.name === 'part');
  if (!partEls.length) throw new Error(ERR_NO_PARTS);
  const parts = partEls.map((el, i) => parsePart(el, i, names));
  const measureCount = Math.max(...parts.map((p) => p.measures.length));

  const flow = [];
  const tempos = [];
  for (let i = 0; i < measureCount; i++) {
    const f = emptyFlow();
    const list = [];
    for (const p of parts) {
      const m = p.measures[i];
      if (!m) continue;
      mergeFlow(f, m.flow);
      for (const t of m.tempos) if (!list.some((x) => Math.abs(x.pos - t.pos) < EPS)) list.push(t);
    }
    list.sort((a, b) => a.pos - b.pos);
    flow.push(f);
    tempos.push(list);
  }

  for (const p of parts) {
    const last = p.measures.length ? p.measures[p.measures.length - 1].ts : { num: 4, den: 4 };
    while (p.measures.length < measureCount) p.measures.push(newMeasure(last, false));
    p.lens = p.measures.map((m, i) => measureLength(m, i, measureCount));
    const exp0 = measureCount ? expectedQ(p.measures[0].ts) : 0;
    p.pickupShift = measureCount && p.lens[0] < exp0 - EPS ? exp0 - p.lens[0] : 0;
    assignHomeStaves(p);
    p.defs = trackDefs(p);
  }

  let tempo = null;
  for (const list of tempos) {
    if (list.length) {
      tempo = r2(list[0].bpm);
      break;
    }
  }
  const ts0 = parts[0].measures.length ? parts[0].measures[0].ts : { num: 4, den: 4 };
  const internal = { parts, flow, tempos, endings: buildEndings(flow) };
  const score = {
    title: meta.title,
    composer: meta.composer,
    lyricist: meta.lyricist,
    tempo,
    timeSignature: { num: ts0.num, den: ts0.den },
    measureCount,
    parts: [],
    _internal: internal,
  };
  score.parts = parts.map((p) => partInfo(internal, p));
  return score;
}

// ---------------------------------------------------------------- play order (repeats)

function findSegno(flow, name) {
  let any = -1;
  for (let j = 0; j < flow.length; j++) {
    if (flow[j].segno === null) continue;
    if (flow[j].segno === name || !name) return j;
    if (any < 0) any = j;
  }
  return any;
}

function findCoda(flow, from, name) {
  let any = -1;
  for (let j = from + 1; j < flow.length; j++) {
    if (flow[j].coda === null) continue;
    if (flow[j].coda === name || !name) return j;
    if (any < 0) any = j;
  }
  return any;
}

function unfoldOrder(internal) {
  const { flow, endings } = internal;
  const n = flow.length;
  const order = [];
  const warnings = [];
  let inferredUsed = false;
  let i = 0;
  let pass = 1;
  let sectionStart = 0;
  let afterJump = false;
  let codaDone = false;
  const jumped = new Set();
  const noteInferred = (f) => {
    if (f.inferred && !f.explicit) inferredUsed = true;
  };

  while (i < n) {
    if (order.length >= MAX_PLAYED) {
      warnings.push(WARN_CAP);
      break;
    }
    const f = flow[i];
    if (f.repeatForward && !afterJump && i !== sectionStart) {
      sectionStart = i;
      pass = 1;
    }
    const g = endings[i];
    if (g && g.start === i && !(afterJump ? !g.backward : g.numbers.includes(pass))) {
      i = g.end + 1;
      continue;
    }
    order.push({ idx: i, pass });
    if (afterJump && f.fine) {
      noteInferred(f);
      break;
    }
    if (afterJump && f.tocoda !== null && !codaDone) {
      const c = findCoda(flow, i, f.tocoda);
      if (c > i) {
        codaDone = true;
        noteInferred(f);
        i = c;
        continue;
      }
    }
    if (f.repeatBackward && !afterJump) {
      const times = f.times || Math.max(2, g ? g.chainMax : 0);
      if (pass < times) {
        pass++;
        i = sectionStart;
        continue;
      }
      pass = 1;
      sectionStart = i + 1;
    } else if (g && g.end === i && !g.backward) {
      pass = 1;
      sectionStart = i + 1;
    }
    if ((f.dacapo || f.dalsegno !== null) && !jumped.has(i)) {
      jumped.add(i);
      const target = f.dacapo ? 0 : findSegno(flow, f.dalsegno);
      if (target >= 0) {
        afterJump = true;
        pass = 1;
        sectionStart = target;
        noteInferred(f);
        i = target;
        continue;
      }
      warnings.push(WARN_NO_SEGNO);
    }
    i++;
  }
  if (inferredUsed) warnings.push(WARN_INFERRED);
  return { order, warnings };
}

function straightOrder(n) {
  const order = [];
  for (let i = 0; i < n; i++) order.push({ idx: i, pass: 1 });
  return { order, warnings: [] };
}

// ---------------------------------------------------------------- track extraction

const hasText = (lyr) => Boolean(lyr) && lyr.kind === 'text';
const matches = (note, def) => (def.staff === null || note.home === def.staff)
  && (def.voice === null || note.voice === def.voice);

function buildTempoMap(internal, part, order, starts, quarterBpm) {
  if (quarterBpm) {
    const spq = 60 / quarterBpm;
    return { sec: (q) => q * spq, initial: quarterBpm, found: true, changes: false };
  }
  const events = [];
  for (let k = 0; k < order.length; k++) {
    const idx = order[k].idx;
    for (const t of internal.tempos[idx]) events.push({ q: starts[k] + Math.min(t.pos, part.lens[idx]), bpm: t.bpm });
  }
  events.sort((a, b) => a.q - b.q);
  const found = events.length > 0;
  const segs = [{ q: 0, s: 0, spq: 60 / (found ? events[0].bpm : DEFAULT_BPM) }];
  const values = new Set();
  for (const e of events) {
    values.add(r2(e.bpm));
    const last = segs[segs.length - 1];
    if (e.q <= last.q + EPS) {
      last.spq = 60 / e.bpm;
    } else {
      segs.push({ q: e.q, s: last.s + (e.q - last.q) * last.spq, spq: 60 / e.bpm });
    }
  }
  const sec = (q) => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].q <= q + EPS) lo = mid;
      else hi = mid - 1;
    }
    const s = segs[lo];
    return s.s + (q - s.q) * s.spq;
  };
  return { sec, initial: 60 / segs[0].spq, found, changes: values.size > 1 };
}

/**
 * Core extraction of one track along the play order.
 * opts: { unfold, verse: number|null, melodyOnly }
 */
function extractTrack(internal, part, def, opts) {
  const n = part.measures.length;
  const { order, warnings } = opts.unfold ? unfoldOrder(internal) : straightOrder(n);

  const starts = [];
  let q = order.length && order[0].idx === 0 ? part.pickupShift : 0;
  for (const o of order) {
    starts.push(q);
    q += part.lens[o.idx];
  }

  // Lyric numbers present per measure for this track → chosen number per played instance.
  const numsByMeasure = part.measures.map((m) => {
    const set = new Set();
    for (const note of m.notes) if (matches(note, def)) for (const l of note.lyrics) set.add(l.number);
    return [...set].sort((a, b) => a - b);
  });
  let verseMissing = false;
  if (opts.verse !== null) verseMissing = !numsByMeasure.some((nums) => nums.includes(opts.verse));
  const visits = new Array(n).fill(0);
  const chosen = order.map((o) => {
    visits[o.idx]++;
    const nums = numsByMeasure[o.idx];
    if (!nums.length) return null;
    const want = opts.verse !== null ? opts.verse : Math.max(o.pass, visits[o.idx]);
    if (nums.includes(want)) return want;
    return nums.includes(1) ? 1 : nums[0];
  });

  let items = [];
  for (let k = 0; k < order.length; k++) {
    const idx = order[k].idx;
    const base = starts[k];
    const num = chosen[k];
    for (const note of part.measures[idx].notes) {
      if (!matches(note, def)) continue;
      let lyr = null;
      if (num !== null) for (const l of note.lyrics) if (l.number === num) lyr = l;
      items.push({
        q: base + note.pos, e: base + note.pos + note.dur, m: note.midi, voice: note.voice, staff: note.home,
        tieStart: note.tieStart, tieStop: note.tieStop, lyr, inst: k, sung: note.lyrics.some((l) => l.kind === 'text'),
      });
    }
  }
  items.sort((a, b) => a.q - b.q || b.m - a.m);

  // Ties → one long note (a "tied" note carrying its own sung syllable stays a separate note).
  const open = new Map();
  const merged = [];
  for (const it of items) {
    if (it.tieStop && !hasText(it.lyr)) {
      const list = open.get(it.m);
      let best = -1;
      if (list) {
        for (let j = list.length - 1; j >= 0; j--) {
          const c = list[j];
          if (it.q < c.q + EPS || it.q > c.e + TIE_MAX_GAP) continue;
          const same = c.voice === it.voice && c.staff === it.staff;
          if (best < 0 || (same && !(list[best].voice === it.voice && list[best].staff === it.staff))) best = j;
        }
      }
      if (best >= 0) {
        const c = list[best];
        if (it.e > c.e) c.e = it.e;
        if (!it.tieStart) list.splice(best, 1);
        continue;
      }
    }
    merged.push(it);
    if (it.tieStart) {
      let list = open.get(it.m);
      if (!list) open.set(it.m, (list = []));
      list.push(it);
    }
  }

  if (opts.melodyOnly) {
    const mel = [];
    for (let a = 0; a < merged.length;) {
      let b = a + 1;
      while (b < merged.length && merged[b].q - merged[a].q < EPS) b++;
      const top = merged[a];
      for (let c = a + 1; c < b; c++) if (merged[c].sung) top.sung = true;
      if (!hasText(top.lyr)) {
        for (let c = a + 1; c < b; c++) {
          if (hasText(merged[c].lyr) || (!top.lyr && merged[c].lyr)) {
            top.lyr = merged[c].lyr;
            if (hasText(top.lyr)) break;
          }
        }
      }
      a = b;
      const prev = mel[mel.length - 1];
      // Merged tracks: a lower note starting under a still-sounding higher note of another voice is accompaniment.
      if (def.voice === null && prev && prev.voice !== top.voice && prev.e > top.q + EPS && prev.m > top.m) continue;
      mel.push(top);
    }
    for (let k = 0; k + 1 < mel.length; k++) if (mel[k].e > mel[k + 1].q) mel[k].e = mel[k + 1].q;
    items = mel;
  } else {
    items = merged;
  }

  return { items, order, starts, warnings, verseMissing };
}

function trackInfo(internal, part, def) {
  const ex = extractTrack(internal, part, def, { unfold: false, verse: null, melodyOnly: true });
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let lyricCount = 0;
  for (const it of ex.items) {
    if (it.m < min) min = it.m;
    if (it.m > max) max = it.m;
    sum += it.m;
    if (it.sung) lyricCount++;
  }
  const noteCount = ex.items.length;
  return {
    key: def.key,
    partId: part.id,
    staff: def.staff,
    voice: def.voice,
    label: def.label,
    noteCount,
    lyricCount,
    min: noteCount ? min : null,
    max: noteCount ? max : null,
    avgPitch: noteCount ? r2(sum / noteCount) : null,
  };
}

function partInfo(internal, part) {
  const voices = new Set();
  const verses = new Set();
  let min = Infinity;
  let max = -Infinity;
  let lyricCount = 0;
  for (const m of part.measures) {
    for (const n of m.notes) {
      voices.add(n.voice);
      if (n.midi < min) min = n.midi;
      if (n.midi > max) max = n.midi;
      let sung = false;
      for (const l of n.lyrics) {
        verses.add(l.number);
        if (l.kind === 'text') sung = true;
      }
      if (sung) lyricCount++;
    }
  }
  const all = extractTrack(internal, part, { staff: null, voice: null }, {
    unfold: false, verse: null, melodyOnly: false,
  });
  const noteCount = all.items.length;
  return {
    id: part.id,
    name: part.name,
    staves: part.staves,
    voices: [...voices].sort(voiceSort),
    verses: [...verses].sort((a, b) => a - b),
    noteCount,
    lyricCount,
    min: noteCount ? min : null,
    max: noteCount ? max : null,
    tracks: part.defs.map((def) => trackInfo(internal, part, def)),
  };
}

function allTracks(score) {
  const out = [];
  for (const p of (score && score.parts) || []) for (const t of p.tracks || []) out.push(t);
  return out;
}

const specificity = (t) => (t.voice !== null ? 2 : 0) + (t.staff !== null ? 1 : 0);

/** Best melody track key: the most lyrics (a single voice preferred when nearly as good), else the highest line. */
export function recommendTrack(score) {
  const tracks = allTracks(score);
  if (!tracks.length) return null;
  const maxLyrics = Math.max(...tracks.map((t) => t.lyricCount));
  if (maxLyrics > 0) {
    let best = null;
    for (const t of tracks) {
      if (t.lyricCount < maxLyrics * 0.95) continue;
      if (!best || specificity(t) > specificity(best)
        || (specificity(t) === specificity(best) && t.lyricCount > best.lyricCount)) best = t;
    }
    return best.key;
  }
  let pool = tracks.filter((t) => t.noteCount >= 8);
  if (!pool.length) {
    const most = Math.max(...tracks.map((t) => t.noteCount));
    pool = tracks.filter((t) => t.noteCount === most);
  }
  let best = null;
  for (const t of pool) {
    if (t.avgPitch === null) continue;
    if (!best || t.avgPitch > best.avgPitch + EPS
      || (Math.abs(t.avgPitch - best.avgPitch) <= EPS && specificity(t) > specificity(best))) best = t;
  }
  return (best || pool[0]).key;
}

// ---------------------------------------------------------------- lyric text

function tokenCount(s) {
  return tokenizeLine(s).length;
}

// Separator for two chunks of the same word: nothing, unless that would merge them into one syllable.
function joinSep(a, b) {
  const want = tokenCount(a) + tokenCount(b);
  if (tokenCount(a + b) === want) return '';
  if (tokenCount(`${a}-${b}`) === want) return '-';
  return ' ';
}

function assembleLine(chunks, safe) {
  let s = '';
  for (let k = 0; k < chunks.length; k++) {
    const c = chunks[k];
    if (k) s += !safe && c.join ? joinSep(chunks[k - 1].text, c.text) : ' ';
    s += c.text;
  }
  return s;
}

function eventLyric(items) {
  const texts = items.filter((it) => hasText(it.lyr)).sort((a, b) => a.q - b.q || b.m - a.m);
  const seq = [];
  for (const it of texts) if (!seq.length || it.q > seq[seq.length - 1].q + EPS) seq.push(it);
  if (seq.length > 1) {
    // Several sung notes collapsed into one note event: one syllable group.
    let text = '';
    for (let k = 0; k < seq.length; k++) {
      const l = seq[k].lyr;
      if (k) text += seq[k - 1].lyr.joinNext || l.joinPrev ? '' : ' ';
      text += l.text;
    }
    const first = seq[0].lyr;
    const last = seq[seq.length - 1].lyr;
    return { ...last, text, count: lyricSyllableCount(text), joinPrev: first.joinPrev };
  }
  if (seq.length) return seq[0].lyr;
  const byPitch = [...items].sort((a, b) => b.m - a.m);
  const other = byPitch.find((it) => it.lyr && it.lyr.kind !== 'empty');
  return other ? other.lyr : null;
}

/**
 * Lyric text (one token per note event) from per-event lyric info.
 * evs: [{ q, e, inst, lyr }]; brk[k]: line break before played instance k (BREAK_SYSTEM, or BREAK_JUMP
 * which also ends any melisma / open word); beatQ[k]: beat length (quarters).
 */
function buildLyricText(evs, brk, beatQ) {
  const lines = [[]];
  let line = lines[0];
  let sylInLine = 0;
  let melisma = false;
  let joinPending = false;
  let pendingBreak = false;
  let prevEnd = null;
  let prevInst = -1;
  let lastSyl = null;
  let syllables = 0;
  const newLine = () => {
    if (line.length) {
      line = [];
      lines.push(line);
    }
    sylInLine = 0;
    pendingBreak = false;
  };

  for (const ev of evs) {
    for (let j = prevInst + 1; j <= ev.inst; j++) {
      if (!brk[j]) continue;
      pendingBreak = true;
      if (brk[j] === BREAK_JUMP) melisma = joinPending = false;
    }
    if (ev.inst > prevInst) prevInst = ev.inst;
    if (prevEnd !== null) {
      const gap = ev.q - prevEnd;
      if (gap >= beatQ[ev.inst] - EPS) {
        pendingBreak = true;
        melisma = false;
      } else if (gap > EPS) {
        melisma = false;
      }
    }
    prevEnd = ev.e;
    const lyr = ev.lyr;

    if (hasText(lyr)) {
      const wordStart = !(joinPending || lyr.joinPrev);
      if (wordStart && line.length && (pendingBreak || sylInLine >= LINE_MAX_SYLLABLES)) newLine();
      if (wordStart && !line.length) pendingBreak = false;
      lastSyl = { text: lyr.count >= 2 ? `{${lyr.text}}` : lyr.text, join: !wordStart };
      line.push(lastSyl);
      sylInLine++;
      syllables++;
      melisma = lyr.extend === 'start' || lyr.extend === 'continue';
      joinPending = lyr.joinNext;
      continue;
    }

    if (lyr && lyr.kind === 'punct' && lastSyl) lastSyl.text += lyr.text;
    const isMelismaLyric = Boolean(lyr) && lyr.kind === 'melisma';
    const cont = melisma || joinPending || isMelismaLyric;
    if (!cont && pendingBreak && line.length) newLine();
    const extend = cont && sylInLine > 0;
    line.push({ text: extend ? '~' : '_', join: extend || joinPending });
    if (isMelismaLyric) melisma = lyr.extend !== 'stop';
  }

  const out = [];
  let misaligned = false;
  for (const chunks of lines) {
    if (!chunks.length) continue;
    let s = assembleLine(chunks, false);
    if (tokenCount(s) !== chunks.length) {
      s = assembleLine(chunks, true);
      if (tokenCount(s) !== chunks.length) misaligned = true;
    }
    out.push(s);
  }
  return { text: syllables ? out.join('\n') : '', syllables, misaligned };
}

// ---------------------------------------------------------------- conversion

function findTrack(score, key) {
  const internal = score._internal;
  for (const p of internal.parts) for (const def of p.defs) if (def.key === key) return { part: p, def };
  return null;
}

// Beat grid: the time-signature denominator is the beat (x/4 → quarter notes), unless that leaves the
// app's 30..300 BPM range while quarter beats would fit.
function beatGrid(ts, quarterBpm) {
  let unit = ts.num >= 1 && ts.num <= 16 ? ts.den : 4;
  let perBar = unit === ts.den ? ts.num : Math.max(1, Math.round((ts.num * 4) / ts.den));
  let bpm = (quarterBpm * unit) / 4;
  if ((bpm < 30 || bpm > 300) && unit !== 4) {
    const qb = (ts.num * 4) / ts.den;
    if (Number.isInteger(qb) && qb >= 1 && qb <= 16 && quarterBpm >= 30 && quarterBpm <= 300) {
      unit = 4;
      perBar = qb;
      bpm = quarterBpm;
    }
  }
  return { unit, perBar, bpm };
}

/**
 * Converts one track of a parsed score into app data:
 * { notes, lyricText, bpm, beatsPerBar, offset: 0, warnings, stats: { notes, syllables } }.
 * `bpm` (optional) replaces the score's tempo map with one constant tempo, counted in the same beat
 * unit as the `bpm` returned without an override (the time-signature denominator, i.e. quarter
 * notes for x/4, unless that falls outside 30..300 BPM and quarter beats fit).
 */
export function scoreToSong(score, {
  trackKey, verse = 'auto', melodyOnly = true, unfoldRepeats = true, includeLyrics = true, bpm,
} = {}) {
  if (!score || !score._internal || !Array.isArray(score._internal.parts)) throw new Error(ERR_SCORE);
  const internal = score._internal;
  const key = trackKey || recommendTrack(score);
  if (!key) throw new Error(ERR_NO_NOTES);
  const found = findTrack(score, key);
  if (!found) throw new Error(ERR_TRACK);
  const { part, def } = found;
  const warnings = [];

  const verseNum = verse === 'auto' || verse == null || verse === '' ? null : parseInt(verse, 10);
  const ts0 = part.measures.length ? part.measures[0].ts : score.timeSignature || { num: 4, den: 4 };
  const override = Number(bpm) > 0 && Number.isFinite(Number(bpm)) ? clamp(Number(bpm), 30, 300) : null;

  const ex = extractTrack(internal, part, def, {
    unfold: unfoldRepeats !== false,
    verse: Number.isInteger(verseNum) && verseNum >= 1 ? verseNum : null,
    melodyOnly: melodyOnly !== false,
  });
  warnings.push(...ex.warnings);
  const natural = buildTempoMap(internal, part, ex.order, ex.starts, null);
  const grid = beatGrid(ts0, natural.initial);
  let map = natural;
  if (override) {
    map = buildTempoMap(internal, part, ex.order, ex.starts, (override * 4) / grid.unit);
    grid.bpm = override;
  } else {
    if (!map.found) warnings.push(WARN_NO_TEMPO);
    if (map.changes) warnings.push(WARN_TEMPO_CHANGES);
  }

  const pairs = [];
  let dropped = 0;
  for (const it of ex.items) {
    if (it.m < 0 || it.m > 127) {
      dropped++;
      continue;
    }
    const t = map.sec(it.q);
    const end = map.sec(Math.max(it.e, it.q));
    pairs.push({ note: { t: r3(t), d: r3(Math.max(MIN_NOTE_D, end - t)), m: it.m }, it });
  }
  pairs.sort((a, b) => a.note.t - b.note.t || a.note.m - b.note.m);
  if (dropped) warnings.push(warnDropped(dropped));
  const notes = pairs.map((p) => p.note);
  if (!notes.length) warnings.push(WARN_NO_NOTES);

  let lyricText = '';
  let syllables = 0;
  if (includeLyrics !== false && notes.length) {
    if (ex.verseMissing) warnings.push(warnVerse(verseNum));
    const brk = ex.order.map((o, k) => {
      if (k === 0) return 0;
      if (o.idx <= ex.order[k - 1].idx) return BREAK_JUMP;
      return internal.flow[o.idx].newSystem ? BREAK_SYSTEM : 0;
    });
    const beatQ = ex.order.map((o) => Math.max(1, 4 / part.measures[o.idx].ts.den));
    const evs = groupNoteEvents(notes).map((ev) => {
      const its = ev.idx.map((i) => pairs[i].it);
      let top = its[0];
      let q = Infinity;
      let e = -Infinity;
      for (const it of its) {
        if (it.m > top.m) top = it;
        if (it.q < q) q = it.q;
        if (it.e > e) e = it.e;
      }
      return { q, e, inst: top.inst, lyr: eventLyric(its) };
    });
    const built = buildLyricText(evs, brk, beatQ);
    lyricText = built.text;
    syllables = built.syllables;
    if (!syllables) {
      const withLyrics = allTracks(score).filter((t) => t.key !== key && t.lyricCount > 0)
        .sort((a, b) => b.lyricCount - a.lyricCount);
      warnings.push(withLyrics.length ? warnLyricsElsewhere(withLyrics[0].label) : WARN_NO_LYRICS);
    }
    if (built.misaligned) warnings.push(WARN_ALIGN);
  }

  return {
    notes,
    lyricText,
    bpm: r2(clamp(grid.bpm, 30, 300)),
    beatsPerBar: clamp(Math.round(grid.perBar), 1, 16),
    offset: 0,
    warnings,
    stats: { notes: notes.length, syllables },
  };
}
