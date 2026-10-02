// Karaoke lyrics: tokenizing lyric text into syllables, timing them against note events, LRC import/export.

import { noteName } from './notes.js';

const CLOSING = new Set([
  ',', '.', '!', '?', '…', '’', '”', ')', ']', '}', '#', '♯', '♭', ':', ';',
  '，', '。', '、', '！', '？', '）', '」', '』', '】', '》', '〉', '・', '–', '—',
  '♪', '♫', '♬', '♩',
]);
const OPENING = new Set(['(', '[', '{', '“', '‘', '（', '「', '『', '【', '《', '〈']);
const AMBIGUOUS_QUOTES = new Set(["'", '"']);
const EXTEND = new Set(['~', '～']);
const SKIP = '_';
const HIDDEN_SPLIT = '-';
const GROUP_OPEN = '{';
const GROUP_CLOSE = '}';
const WS_RE = /\s/u;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const SECTION_TAG_RE = /^\[[^\]]*\]$/;

const r3 = (x) => Math.round(x * 1000) / 1000;

// Characters that are one sung syllable each: Hangul, CJK ideographs, kana.
function isSyllableChar(cp) {
  return (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0x1100 && cp <= 0x11ff)
    || (cp >= 0x3131 && cp <= 0x318e)
    || (cp >= 0x3040 && cp <= 0x309f)
    || (cp >= 0x30a0 && cp <= 0x30ff && cp !== 0x30fb)
    || (cp >= 0x31f0 && cp <= 0x31ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xff66 && cp <= 0xff9d);
}

function isWordChar(ch) {
  return ch !== undefined && WORD_CHAR_RE.test(ch) && !isSyllableChar(ch.codePointAt(0));
}

function syllableCount(text) {
  let n = 0;
  for (const tk of tokenizeLine(text)) if (tk.type === 'syl') n++;
  return n;
}

/**
 * Splits one lyric line into tokens: {type:'syl', text} | {type:'ext'} | {type:'skip'}.
 * Syllable texts carry display punctuation and one trailing space when followed by whitespace
 * (never on the last syllable), so concatenating them reproduces the displayed line.
 *
 * Brace group: '{abc def}' is ONE syllable displayed as 'abc def' (braces removed, inner text kept
 * verbatim apart from trimmed edges; markers inside are literal). An unclosed '{' groups the rest of
 * the line. Braces around content that is a single syllable anyway (e.g. '{예}') keep their old
 * meaning as visible punctuation.
 */
export function tokenizeLine(line) {
  if (typeof line !== 'string' || !line) return [];
  const chars = Array.from(line.normalize('NFC'));
  const tokens = [];
  let last = null; // last syllable token
  let space = false; // whitespace seen after `last`
  let prefix = ''; // opening punctuation waiting for the next syllable
  let inWord = false; // `last` is a Latin-like word that may keep growing

  const startSyllable = (ch) => {
    if (last && space) last.text += ' ';
    last = { type: 'syl', text: prefix + ch };
    tokens.push(last);
    prefix = '';
    space = false;
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (WS_RE.test(ch)) {
      inWord = false;
      if (prefix) {
        if (!prefix.endsWith(' ')) prefix += ' ';
      } else if (last) {
        space = true;
      }
      continue;
    }
    if (ch === GROUP_OPEN) {
      let close = chars.indexOf(GROUP_CLOSE, i + 1);
      if (close < 0) close = chars.length;
      const body = chars.slice(i + 1, close).join('').trim();
      if (syllableCount(body) >= 2) {
        startSyllable(body);
        inWord = false;
        i = close;
        continue;
      }
    }
    if (EXTEND.has(ch)) {
      tokens.push({ type: 'ext' });
      inWord = false;
      continue;
    }
    if (ch === SKIP) {
      tokens.push({ type: 'skip' });
      inWord = false;
      continue;
    }
    if (ch === HIDDEN_SPLIT) {
      inWord = false;
      continue;
    }
    // Apostrophe inside a word ("don't", "rock'n'roll").
    if ((ch === "'" || ch === '’') && inWord && last && !space && isWordChar(chars[i + 1])) {
      last.text += ch;
      continue;
    }
    if (AMBIGUOUS_QUOTES.has(ch)) {
      if (last && !space && !prefix) {
        last.text += ch; // closing quote glued to the previous syllable
      } else {
        prefix += ch;
        inWord = false;
      }
      continue;
    }
    if (CLOSING.has(ch)) {
      if (last && !prefix) {
        if (space) {
          last.text += ' ';
          space = false;
        }
        last.text += ch;
      } else {
        prefix += ch;
      }
      continue;
    }
    if (OPENING.has(ch)) {
      prefix += ch;
      inWord = false;
      continue;
    }
    if (isSyllableChar(ch.codePointAt(0))) {
      startSyllable(ch);
      inWord = false;
      continue;
    }
    if (inWord && last && !space && !prefix) {
      last.text += ch;
    } else {
      startSyllable(ch);
      inWord = true;
    }
  }
  if (prefix && last) last.text += (space ? ' ' : '') + prefix.trimEnd();
  return tokens;
}

function isIgnoredLine(trimmed) {
  return !trimmed || trimmed.startsWith('#') || SECTION_TAG_RE.test(trimmed);
}

export function parseLyricText(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const trimmed = raw.trim();
    if (isIgnoredLine(trimmed)) continue;
    const tokens = tokenizeLine(trimmed);
    if (tokens.length) out.push({ tokens });
  }
  return out;
}

// Groups notes whose onsets are within `eps` of the group's first onset. idx = indices into `notes`.
export function groupNoteEvents(notes, eps = 0.03) {
  if (!Array.isArray(notes) || !notes.length) return [];
  const order = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n && Number.isFinite(n.t)) order.push(i);
  }
  order.sort((a, b) => notes[a].t - notes[b].t || a - b);
  const tol = (Number.isFinite(eps) && eps >= 0 ? eps : 0.03) + 1e-9;
  const events = [];
  let cur = null;
  for (const i of order) {
    const n = notes[i];
    const d = Number.isFinite(n.d) && n.d > 0 ? n.d : 0;
    const end = n.t + d;
    if (cur && n.t - cur.t <= tol) {
      cur.idx.push(i);
      if (end > cur.end) cur.end = end;
    } else {
      cur = { t: n.t, end, idx: [i] };
      events.push(cur);
    }
  }
  return events;
}

const WARN_NO_NOTES = '노트가 없어 가사를 임시 시간으로 배치했어요.';
const warnOverflow = (n) => `가사 음절이 노트보다 ${n}개 많아요. 남는 가사는 마지막 노트 뒤에 배치됩니다.`;
const warnUnused = (n) => `가사가 없는 노트가 ${n}개 있어요.`;
const NO_NOTE_SLOT = 0.5;
const OVERFLOW_SLOT = 0.4;
const MIN_SYL_D = 0.05;

function finishLine(raw) {
  return {
    syllables: raw.map((s) => {
      const t = r3(s.t);
      return { text: s.text, t, d: r3(Math.max(MIN_SYL_D, s.end - s.t)) };
    }),
  };
}

/**
 * Times lyric syllables against note events (one event per syllable; `~` extends, `_` skips).
 * Returns { lines, warnings, stats: { syllables, events, used } }.
 */
export function assignLyrics(text, notes) {
  const parsed = parseLyricText(text);
  const events = groupNoteEvents(notes);
  const lines = [];
  const warnings = [];
  let syllables = 0;
  for (const l of parsed) for (const tk of l.tokens) if (tk.type === 'syl') syllables++;

  if (!events.length) {
    if (syllables > 0) {
      let cursor = 0;
      for (const l of parsed) {
        const raw = [];
        let prev = null;
        for (const tk of l.tokens) {
          if (tk.type === 'syl') {
            prev = { text: tk.text, t: cursor, end: cursor + NO_NOTE_SLOT };
            raw.push(prev);
          } else if (tk.type === 'ext' && prev) {
            prev.end = cursor + NO_NOTE_SLOT;
          }
          cursor += NO_NOTE_SLOT;
        }
        if (raw.length) lines.push(finishLine(raw));
      }
      warnings.push(WARN_NO_NOTES);
    }
    return { lines, warnings, stats: { syllables, events: 0, used: 0 } };
  }

  let ei = 0;
  let used = 0;
  let lastEnd = -Infinity;
  let cursor = null; // overflow placement time (starts at the last used time)
  let overflow = 0;
  const take = () => {
    const ev = events[ei++];
    used++;
    if (ev.end > lastEnd) lastEnd = ev.end;
    return ev;
  };
  const overflowSlot = () => {
    if (cursor === null) cursor = Number.isFinite(lastEnd) ? lastEnd : events[events.length - 1].end;
    const t = cursor;
    cursor += OVERFLOW_SLOT;
    return t;
  };

  for (const l of parsed) {
    const raw = [];
    let prev = null;
    for (const tk of l.tokens) {
      if (tk.type === 'syl') {
        if (ei < events.length) {
          const ev = take();
          prev = { text: tk.text, t: ev.t, end: ev.end };
        } else {
          const t = overflowSlot();
          prev = { text: tk.text, t, end: t + OVERFLOW_SLOT };
          overflow++;
        }
        raw.push(prev);
      } else if (tk.type === 'ext') {
        if (ei < events.length) {
          const ev = take();
          if (prev && ev.end > prev.end) prev.end = ev.end;
        } else if (prev) {
          const t = overflowSlot();
          prev.end = Math.max(prev.end, t + OVERFLOW_SLOT);
        }
      } else if (ei < events.length) {
        take();
      } else if (cursor !== null) {
        overflowSlot();
      }
    }
    if (raw.length) lines.push(finishLine(raw));
  }

  if (overflow > 0) warnings.push(warnOverflow(overflow));
  const unused = events.length - used;
  if (unused > 0 && syllables > 0) warnings.push(warnUnused(unused));
  return { lines, warnings, stats: { syllables, events: events.length, used } };
}

const SOLFEGE_LINE_GAP = 0.6;
const SOLFEGE_LINE_MAX = 8;

// 계이름 lyric text: one name per note event (highest note of a chord).
export function solfegeLyricText(notes) {
  const events = groupNoteEvents(notes);
  const lines = [];
  let cur = [];
  let prevEnd = null;
  for (const ev of events) {
    let top = -Infinity;
    for (const i of ev.idx) if (notes[i].m > top) top = notes[i].m;
    const name = noteName(top, 'solfege');
    if (!name) continue;
    if (cur.length && (cur.length >= SOLFEGE_LINE_MAX || ev.t - prevEnd >= SOLFEGE_LINE_GAP - 1e-9)) {
      lines.push(cur.join(' '));
      cur = [];
    }
    cur.push(name);
    prevEnd = ev.end;
  }
  if (cur.length) lines.push(cur.join(' '));
  return lines.join('\n');
}

export function lineStart(line) {
  const s = line && line.syllables && line.syllables[0];
  return s ? s.t : 0;
}

export function lineEnd(line) {
  const syls = (line && line.syllables) || [];
  let end = syls.length ? -Infinity : 0;
  for (const s of syls) if (s.t + s.d > end) end = s.t + s.d;
  return end;
}

export function lyricsPlainText(lines) {
  if (!Array.isArray(lines)) return '';
  return lines
    .map((l) => ((l && l.syllables) || []).map((s) => s.text).join(''))
    .join('\n');
}

// ---------------------------------------------------------------- LRC

const LINE_STAMP_RE = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const META_RE = /^\[([A-Za-z#]+)\s*:(.*)\]$/;
const WORD_STAMP_SRC = '<(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?>';
const LRC_MAX_LINE = 10;
const LRC_LAST_LINE = 4;
const LRC_FILL = 0.9;

function stampSeconds(min, sec, frac) {
  let t = Number(min) * 60 + Number(sec);
  if (frac) t += Number(frac) / Math.pow(10, frac.length);
  return t;
}

// Splits text after the line stamps into segments at <mm:ss.xx> word stamps. First segment t = null (line stamp).
function splitWordSegments(text) {
  const re = new RegExp(WORD_STAMP_SRC, 'g');
  const segs = [];
  let lastIdx = 0;
  let curT = null;
  let m;
  while ((m = re.exec(text))) {
    segs.push({ t: curT, raw: text.slice(lastIdx, m.index) });
    curT = stampSeconds(m[1], m[2], m[3]);
    lastIdx = m.index + m[0].length;
  }
  segs.push({ t: curT, raw: text.slice(lastIdx) });
  return segs;
}

// Tokenizes each segment (markers ignored) and keeps word spacing across segment boundaries.
function segmentSyllables(segs) {
  let last = null;
  let pendingSpace = false;
  let count = 0;
  for (const seg of segs) {
    const raw = seg.raw;
    const syls = tokenizeLine(raw).filter((tk) => tk.type === 'syl').map((tk) => ({ text: tk.text }));
    seg.syls = syls;
    if (!syls.length) {
      const visible = raw.trim();
      if (visible && last) {
        // Punctuation-only segment: keep it visible on the previous syllable.
        if (pendingSpace || /^\s/.test(raw)) last.text += ' ';
        last.text += visible;
        pendingSpace = /\s$/.test(raw);
      } else if (WS_RE.test(raw) && last) {
        pendingSpace = true;
      }
      continue;
    }
    if (last && (pendingSpace || /^\s/.test(raw)) && !last.text.endsWith(' ')) last.text += ' ';
    last = syls[syls.length - 1];
    pendingSpace = /\s$/.test(raw);
    count += syls.length;
  }
  return count;
}

/**
 * Parses (enhanced) LRC → { lines, meta: { ti?, ar?, al?, offset }, wordTimed }.
 * offset is in seconds; a positive [offset:ms] shows lyrics earlier.
 */
export function parseLRC(text) {
  const meta = { offset: 0 };
  const entries = [];
  const src = typeof text === 'string' ? text.replace(/^﻿/, '') : '';
  let order = 0;

  for (const rawLine of src.split(/\r\n|\r|\n/)) {
    let rest = rawLine.trim();
    if (!rest) continue;
    const stamps = [];
    let m;
    while ((m = LINE_STAMP_RE.exec(rest))) {
      stamps.push(stampSeconds(m[1], m[2], m[3]));
      rest = rest.slice(m[0].length);
    }
    if (!stamps.length) {
      const mm = META_RE.exec(rest);
      if (mm) {
        const key = mm[1].toLowerCase();
        const val = mm[2].trim();
        if (key === 'offset') {
          const ms = Number(val);
          if (val && Number.isFinite(ms)) meta.offset = ms / 1000;
        } else if ((key === 'ti' || key === 'ar' || key === 'al') && val) {
          meta[key] = val;
        }
      }
      continue;
    }
    const segs = splitWordSegments(rest);
    const count = segmentSyllables(segs);
    const wordTimed = segs.length > 1;
    for (const st of stamps) {
      entries.push({ t: st, shift: st - stamps[0], segs, count, wordTimed, order: order++ });
    }
  }

  entries.sort((a, b) => a.t - b.t || a.order - b.order);

  const lines = [];
  let anyWordTimed = false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.count) continue; // empty-text stamp: only terminates the previous line
    let nextStart = null;
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].t > e.t) {
        nextStart = entries[j].t;
        break;
      }
    }
    const lineLimit = nextStart !== null ? Math.min(nextStart - e.t, LRC_MAX_LINE) : LRC_LAST_LINE;
    const syllables = [];

    if (!e.wordTimed) {
      const syls = e.segs[0].syls;
      const step = (LRC_FILL * lineLimit) / syls.length;
      syls.forEach((s, k) => syllables.push({ text: s.text, t: e.t + k * step, d: step }));
    } else {
      anyWordTimed = true;
      const segs = e.segs;
      for (let k = 0; k < segs.length; k++) {
        const seg = segs[k];
        if (!seg.syls.length) continue;
        const start = seg.t === null ? e.t : seg.t + e.shift;
        let end;
        if (k + 1 < segs.length) end = segs[k + 1].t + e.shift;
        else end = Math.max(e.t + lineLimit, start + 0.3 * seg.syls.length);
        const n = seg.syls.length;
        const step = Math.max(end - start, MIN_SYL_D * n) / n;
        seg.syls.forEach((s, q) => syllables.push({ text: s.text, t: start + q * step, d: step }));
      }
    }
    lines.push({
      syllables: syllables.map((s) => ({ text: s.text, t: r3(s.t - meta.offset), d: r3(Math.max(s.d, 0.001)) })),
    });
  }

  return { lines, meta, wordTimed: anyWordTimed };
}

export function formatLrcTime(sec) {
  const cs = Math.max(0, Math.round((Number(sec) || 0) * 100));
  const mm = Math.floor(cs / 6000);
  const ss = Math.floor((cs % 6000) / 100);
  const xx = cs % 100;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(xx).padStart(2, '0')}`;
}

const cleanMeta = (v) => String(v).replace(/[\]\r\n]/g, ' ').trim();
const cleanSyllable = (v) => String(v).replace(/[\r\n]/g, ' ').replace(/</g, '＜').replace(/>/g, '＞');

// A syllable whose text would re-tokenize into several syllables (a brace group) is written back as a
// group so parseLRC reads it as one syllable again.
function lrcSyllable(v) {
  const clean = cleanSyllable(v);
  const body = clean.trim();
  if (syllableCount(body) < 2) return clean;
  const lead = clean.slice(0, clean.indexOf(body));
  const trail = clean.slice(lead.length + body.length);
  return `${lead}${GROUP_OPEN}${body.replace(/[{}]/g, '')}${GROUP_CLOSE}${trail}`;
}

// Enhanced LRC. An end stamp follows a syllable when a gap follows it (or it ends the line),
// so parseLRC(toLRC(lines)) reproduces syllable start/duration to 10 ms.
export function toLRC(lines, meta = {}) {
  const out = [];
  for (const key of ['ti', 'ar', 'al']) {
    const v = meta && meta[key];
    if (typeof v === 'string' && v.trim()) out.push(`[${key}:${cleanMeta(v)}]`);
  }
  for (const line of Array.isArray(lines) ? lines : []) {
    const syls = ((line && line.syllables) || []).filter(
      (s) => s && Number.isFinite(s.t) && Number.isFinite(s.d) && typeof s.text === 'string',
    );
    if (!syls.length) continue;
    let s = `[${formatLrcTime(syls[0].t)}]`;
    for (let i = 0; i < syls.length; i++) {
      const a = syls[i];
      const end = a.t + Math.max(a.d, 0);
      s += `<${formatLrcTime(a.t)}>${lrcSyllable(a.text)}`;
      const next = syls[i + 1];
      if (!next || next.t - end > 0.015) s += `<${formatLrcTime(end)}>`;
    }
    out.push(s);
  }
  return out.join('\n');
}
