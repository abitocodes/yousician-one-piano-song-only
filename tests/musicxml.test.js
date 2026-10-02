import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseXml, readScoreText, isScoreFileName, parseMusicXml, recommendTrack, scoreToSong, scoreToArrangement,
  recommendArrangement,
} from '../js/core/musicxml.js';
import { assignLyrics, tokenizeLine, lyricsPlainText, groupNoteEvents } from '../js/core/lyrics.js';
import { simplifyAccompaniment } from '../js/core/arrange.js';
import { normalizeSong } from '../js/core/song.js';
import { makeZip } from './helpers-zip.js';

// All fixtures are original: simple scales/arpeggios with placeholder words (하나 둘 셋, la, 가나다…).

const ERR_XML = { message: '악보 파일(XML)을 읽을 수 없어요.' };
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const closeAll = (as, bs, eps = 1e-6) => {
  assert.equal(as.length, bs.length, `length ${as.length} ≠ ${bs.length}: [${as}] vs [${bs}]`);
  as.forEach((a, i) => close(a, bs[i], eps));
};

// ---------------------------------------------------------------- fixture builders

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function pitchXml(p) {
  const [, step, acc, oct] = /^([A-G])(#|b)?(-?\d)$/.exec(p);
  const alter = acc === '#' ? '<alter>1</alter>' : acc === 'b' ? '<alter>-1</alter>' : '';
  return `<pitch><step>${step}</step>${alter}<octave>${oct}</octave></pitch>`;
}

function lyricXml(l) {
  const o = typeof l === 'string' ? { t: l } : l;
  const syl = o.s ? `<syllabic>${o.s}</syllabic>` : '';
  const txt = o.t !== undefined ? `<text>${esc(o.t)}</text>` : '';
  const ext = o.ext ? (o.ext === true ? '<extend/>' : `<extend type="${o.ext}"/>`) : '';
  return `<lyric number="${o.n || 1}">${syl}${txt}${ext}</lyric>`;
}

// p: 'C4', 'Bb3', 'F#5', 'R' (rest) or 'X' (unpitched). o: voice, staff, chord, tie, tied, lyric, grace, cue, type, raw
function N(p, dur, o = {}) {
  let s = '<note>';
  if (o.grace) s += '<grace/>';
  if (o.chord) s += '<chord/>';
  if (o.cue) s += '<cue/>';
  if (p === 'R') s += '<rest/>';
  else if (p === 'X') s += '<unpitched><display-step>E</display-step><display-octave>4</display-octave></unpitched>';
  else s += pitchXml(p);
  if (!o.grace && dur !== null) s += `<duration>${dur}</duration>`;
  if (o.tie === 'stop' || o.tie === 'both') s += '<tie type="stop"/>';
  if (o.tie === 'start' || o.tie === 'both') s += '<tie type="start"/>';
  if (o.voice !== null) s += `<voice>${o.voice || 1}</voice>`;
  if (o.type) s += `<type>${o.type}</type>`;
  if (o.staff) s += `<staff>${o.staff}</staff>`;
  if (o.tied) s += `<notations><tied type="${o.tied}"/></notations>`;
  for (const l of [].concat(o.lyric || [])) s += lyricXml(l);
  if (o.raw) s += o.raw;
  return `${s}</note>`;
}

const R = (dur, o) => N('R', dur, o);
const backup = (d) => `<backup><duration>${d}</duration></backup>`;
const forward = (d) => `<forward><duration>${d}</duration><voice>2</voice></forward>`;
const tempo = (bpm) => '<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>'
  + `<per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>`;
const words = (w, sound = '') => `<direction><direction-type><words>${esc(w)}</words></direction-type>${sound}</direction>`;
const attrs = ({ div = 1, beats = 4, type = 4, staves = 0, extra = '' } = {}) => `<attributes><divisions>${div}</divisions>`
  + `<time><beats>${beats}</beats><beat-type>${type}</beat-type></time>${staves ? `<staves>${staves}</staves>` : ''}${extra}</attributes>`;
const M = (content, o = {}) => `<measure number="${o.num || 'x'}"${o.implicit ? ' implicit="yes"' : ''}>`
  + `${o.print ? '<print new-system="yes"/>' : ''}${o.left || ''}${content}${o.right || ''}</measure>`;

function partwise(partsOrMeasures, { head = '' } = {}) {
  const parts = typeof partsOrMeasures[0] === 'string'
    ? [{ id: 'P1', name: 'Voice', measures: partsOrMeasures }]
    : partsOrMeasures;
  const list = parts.map((p) => `<score-part id="${p.id}"><part-name>${esc(p.name)}</part-name></score-part>`).join('');
  const body = parts.map((p) => `<part id="${p.id}">${p.measures.join('\n')}</part>`).join('\n');
  return '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
    + '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'
    + `<score-partwise version="4.0">${head}<part-list>${list}</part-list>\n${body}\n</score-partwise>`;
}

const convert = (xml, opts) => scoreToSong(parseMusicXml(xml), opts);
const ts = (song) => song.notes.map((n) => n.t);
const ms = (song) => song.notes.map((n) => n.m);

// assignLyrics must consume every note event and produce one syllable per lyric-bearing note.
function aligned(song) {
  const res = assignLyrics(song.lyricText, song.notes);
  assert.deepEqual(res.warnings, [], `assignLyrics warnings for ${JSON.stringify(song.lyricText)}`);
  const syls = res.lines.flatMap((l) => l.syllables);
  assert.equal(syls.length, song.stats.syllables);
  return { syls, lines: res.lines, starts: syls.map((s) => s.t), texts: syls.map((s) => s.text.trim()) };
}

const REPEAT_FWD = '<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>';
const ending = (num, type, loc) => `<barline location="${loc}"><ending number="${num}" type="${type}"/>`
  + `${type === 'stop' && loc === 'right' ? '<repeat direction="backward"/>' : ''}</barline>`;

// ---------------------------------------------------------------- XML

test('parseXml: prolog, DOCTYPE subset, comments, PIs, CDATA, entities, self-closing, namespaces', () => {
  const root = parseXml('﻿<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE a [ <!ENTITY e "v"> <!ELEMENT a ANY> ]>\n<!-- top comment -->\n'
    + '<a x="1" y=\'&lt;2&gt;\' z = "a&amp;b">\n  <b>t &amp; &#65;&#x42; &quot;&apos; &unknown;</b>\n'
    + '  <c/><c k="v" /><?pi data?>\n  <d><![CDATA[<raw> & stuff]]></d><!-- x -->\n'
    + '  <ns:e xmlns:ns="urn:x">z</ns:e>\n</a>\n<!-- trailing -->');
  assert.equal(root.name, 'a');
  assert.deepEqual(root.attrs, { x: '1', y: '<2>', z: 'a&b' });
  assert.deepEqual(root.children.map((c) => c.name), ['b', 'c', 'c', 'd', 'ns:e']);
  assert.equal(root.children[0].text, 't & AB "\' &unknown;');
  assert.deepEqual(root.children[2].attrs, { k: 'v' });
  assert.equal(root.children[3].text, '<raw> & stuff');
  assert.equal(root.children[4].text, 'z');
  assert.equal(root.text, '');
});

test('parseXml: malformed input throws the Korean error', () => {
  for (const bad of ['', 'hello', '<a><b></a>', '<a>', '<a x="1></a>', '<a><!-- x</a>', '<a>1 < 2</a>', '<1a/>', 42]) {
    assert.throws(() => parseXml(bad), ERR_XML, JSON.stringify(bad));
  }
});

test('isScoreFileName', () => {
  for (const ok of ['a.musicxml', 'B.XML', '곡.mxl', 'x.MusicXML']) assert.equal(isScoreFileName(ok), true, ok);
  for (const no of ['a.mid', 'a.pdf', 'xml', 'a.xml.txt', '', null]) assert.equal(isScoreFileName(no), false, String(no));
});

// ---------------------------------------------------------------- reading files

const tinyScore = (title = '연습곡') => partwise(
  [M(attrs() + tempo(90) + N('C4', 1, { lyric: '하' }) + N('D4', 1, { lyric: '나' }) + N('E4', 2, { lyric: '둘' }))],
  { head: `<work><work-title>${title}</work-title></work>` },
);

function utf16be(str) {
  const le = Buffer.from(str, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}

test('readScoreText: UTF-8 (with/without BOM) and UTF-16 (LE/BE, with/without BOM)', async () => {
  const xml = tinyScore();
  assert.equal(await readScoreText(new TextEncoder().encode(xml)), xml);
  assert.equal(await readScoreText(new TextEncoder().encode(`﻿${xml}`).buffer), xml);
  assert.equal(await readScoreText(Buffer.from(`﻿${xml}`, 'utf16le')), xml);
  assert.equal(await readScoreText(Buffer.from(xml, 'utf16le')), xml);
  assert.equal(await readScoreText(utf16be(`﻿${xml}`)), xml);
  assert.equal(await readScoreText(utf16be(xml)), xml);
  const utf16 = xml.replace('encoding="UTF-8"', 'encoding="UTF-16"');
  const score = parseMusicXml(await readScoreText(Buffer.from(`﻿${utf16}`, 'utf16le')));
  assert.equal(score.title, '연습곡');
  assert.equal(score.parts[0].lyricCount, 3);
});

test('readScoreText: rejects PDF, MIDI and empty files with Korean messages', async () => {
  await assert.rejects(readScoreText(new TextEncoder().encode('%PDF-1.7 ...')), /PDF 악보는 바로 읽을 수 없어요/);
  await assert.rejects(readScoreText(new TextEncoder().encode('MThd\0\0\0\x06')), /MIDI 가져오기/);
  await assert.rejects(readScoreText(new Uint8Array(0)), { message: '악보 파일이 비어 있어요.' });
  await assert.rejects(readScoreText(new TextEncoder().encode('PK\x03\x04 broken')), { message: '압축 파일을 읽을 수 없어요.' });
});

test('readScoreText (.mxl): rootfile from META-INF/container.xml wins over other XML files', async () => {
  const real = tinyScore('진짜 악보');
  const decoy = tinyScore('미끼');
  const container = '<?xml version="1.0" encoding="UTF-8"?><container><rootfiles>'
    + '<rootfile full-path="scores/real.musicxml" media-type="application/vnd.recordare.musicxml+xml"/>'
    + '<rootfile full-path="scores/real.pdf" media-type="application/pdf"/></rootfiles></container>';
  const zip = await makeZip([
    { name: 'mimetype', data: 'application/vnd.recordare.musicxml', method: 0 },
    { name: 'aaa-decoy.xml', data: decoy, method: 8 },
    { name: 'META-INF/container.xml', data: container, method: 0 },
    { name: 'scores', dir: true },
    { name: 'scores/real.musicxml', data: real, method: 8 },
  ]);
  const text = await readScoreText(zip);
  assert.equal(text, real);
  assert.equal(parseMusicXml(text).title, '진짜 악보');
});

test('readScoreText (.mxl): fallback to the first score file outside META-INF; missing score errors', async () => {
  const zip = await makeZip([
    { name: 'META-INF/other.xml', data: '<x/>' },
    { name: 'notes.txt', data: 'hello' },
    { name: 'layout.xml', data: '<layout/>' },
    { name: 'song.musicxml', data: tinyScore('대체 경로'), method: 0 },
  ]);
  assert.equal(parseMusicXml(await readScoreText(zip)).title, '대체 경로');
  const broken = await makeZip([
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="missing.xml"/></rootfiles></container>' },
    { name: 'inner.xml', data: tinyScore('컨테이너 오류') },
  ]);
  assert.equal(parseMusicXml(await readScoreText(broken)).title, '컨테이너 오류');
  const none = await makeZip([{ name: 'readme.txt', data: 'la la' }]);
  await assert.rejects(readScoreText(none), { message: '압축 파일 안에서 MusicXML 악보를 찾을 수 없어요.' });
});

// ---------------------------------------------------------------- score model

test('parseMusicXml: metadata, part/track info, time signature, tempo, verses', () => {
  const xml = partwise([
    { id: 'P1', name: 'Voice', measures: [
      M(attrs({ beats: 3 }) + tempo(72) + N('G4', 1, { lyric: [{ t: '하', n: 1 }, { t: '셋', n: 2 }] })
        + N('A4', 1, { lyric: '나' }) + N('B4', 1, { raw: '<lyric number="part1verse3"><text>la</text></lyric>' })),
    ] },
    { id: 'P2', name: 'MusicXML Part', measures: [M(attrs({ beats: 3 }) + N('C3', 3, { voice: 5 }))] },
  ], {
    head: '<work><work-title>  작은   노래 </work-title></work><identification><creator type="composer">작곡가 A</creator>'
      + '<creator type="lyricist">작사가 B</creator></identification>'
      + '<credit page="1"><credit-type>title</credit-type><credit-words>무시됨</credit-words></credit>',
  });
  const score = parseMusicXml(xml);
  assert.equal(score.title, '작은 노래');
  assert.equal(score.composer, '작곡가 A');
  assert.equal(score.lyricist, '작사가 B');
  assert.equal(score.tempo, 72);
  assert.deepEqual(score.timeSignature, { num: 3, den: 4 });
  assert.equal(score.measureCount, 1);
  assert.equal(score.parts.length, 2);
  const [voice, other] = score.parts;
  assert.equal(voice.name, '보컬');
  assert.deepEqual(voice.verses, [1, 2, 3]);
  assert.deepEqual(voice.voices, ['1']);
  assert.equal(voice.noteCount, 3);
  assert.equal(voice.lyricCount, 3);
  assert.equal(voice.min, 67);
  assert.equal(voice.max, 71);
  assert.deepEqual(voice.tracks, [{
    key: 'P1|s1|v1', partId: 'P1', staff: 1, voice: '1', label: '보컬 · 1단 · 성부 1',
    noteCount: 3, lyricCount: 3, min: 67, max: 71, avgPitch: 69, allNotes: 3, allMin: 67, allMax: 71,
  }]);
  assert.equal(other.name, '파트 2');
  assert.equal(other.tracks[0].key, 'P2|s1|v5');
  assert.equal(other.tracks[0].label, '파트 2 · 1단 · 성부 5');
  assert.equal(recommendTrack(score), 'P1|s1|v1');

  const credits = parseMusicXml(partwise([M(attrs() + N('C4', 4))], {
    head: '<credit page="1"><credit-type>title</credit-type><credit-words>표지 제목</credit-words></credit>'
      + '<credit page="1"><credit-type>composer</credit-type><credit-words>표지 작곡</credit-words></credit>',
  }));
  assert.equal(credits.title, '표지 제목');
  assert.equal(credits.composer, '표지 작곡');
  assert.equal(credits.tempo, null);
});

test('parseMusicXml: not MusicXML / unsupported / no parts', () => {
  assert.throws(() => parseMusicXml('<html><body/></html>'), { message: 'MusicXML 악보 파일이 아니에요.' });
  assert.throws(() => parseMusicXml('<opus><title>x</title></opus>'), /지원하지 않는 형식/);
  assert.throws(() => parseMusicXml('<score-partwise><part-list/></score-partwise>'), { message: '악보에 파트(악기)가 없어요.' });
  assert.throws(() => parseMusicXml('<score-partwise><part id="P1"><measure></part></score-partwise>'), ERR_XML);
  const score = parseMusicXml(tinyScore());
  assert.throws(() => scoreToSong(score, { trackKey: 'P9|s1|v1' }), { message: '선택한 성부를 찾을 수 없어요.' });
  assert.throws(() => scoreToSong({}), { message: '악보 정보가 올바르지 않아요.' });
  const restsOnly = parseMusicXml(partwise([M(attrs() + R(4))]));
  assert.deepEqual(restsOnly.parts[0].tracks, []);
  assert.equal(recommendTrack(restsOnly), null);
  assert.throws(() => scoreToSong(restsOnly), { message: '악보에서 음표를 찾지 못했어요.' });
});

test('MuseScore native files (.mscz zip / .mscx) get a hint to export MusicXML', async () => {
  const mscz = await makeZip([
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="song.mscx"/></rootfiles></container>' },
    { name: 'song.mscx', data: '<?xml version="1.0"?><museScore version="4.20"><Score/></museScore>' },
  ]);
  const text = await readScoreText(mscz);
  assert.throws(() => parseMusicXml(text), /MuseScore에서 MusicXML/);
});

// ---------------------------------------------------------------- notes & timing

test('ties (tie and tied elements) merge into one note; a tied note with its own syllable stays separate', () => {
  const song = convert(partwise([
    M(attrs() + tempo(60) + N('E4', 1, { lyric: '하' }) + N('D4', 1, { lyric: '나' })
      + N('C4', 2, { tie: 'start', tied: 'start', lyric: '둘' })),
    M(N('C4', 1, { tie: 'stop', tied: 'stop' }) + N('C4', 1, { tied: 'start' }) + N('C4', 2, { tied: 'stop' })),
    M(N('G4', 2, { tie: 'start' }) + N('G4', 2, { tie: 'stop', lyric: '셋' })),
  ]));
  assert.deepEqual(song.notes, [
    { t: 0, d: 1, m: 64 }, { t: 1, d: 1, m: 62 }, { t: 2, d: 3, m: 60 }, { t: 5, d: 3, m: 60 },
    { t: 8, d: 2, m: 67 }, { t: 10, d: 2, m: 67 },
  ]);
  assert.equal(song.lyricText, '하 나 둘 _ _ 셋');
  assert.deepEqual(aligned(song).starts, [0, 1, 2, 10]);
  assert.deepEqual(song.warnings, []);
});

test('chords: melody keeps the top note (lyric taken from any chord note); melodyOnly false keeps all', () => {
  const xml = partwise([M(attrs() + tempo(60)
    + N('C4', 1, { lyric: 'la' }) + N('E4', 1, { chord: true }) + N('G4', 1, { chord: true })
    + N('F4', 1) + N('A4', 1, { chord: true, lyric: 'li' })
    + N('D4', 2, { lyric: 'lo' }))]);
  const mel = convert(xml);
  assert.deepEqual(ms(mel), [67, 69, 62]);
  assert.deepEqual(ts(mel), [0, 1, 2]);
  assert.equal(mel.lyricText, 'la li lo');
  assert.deepEqual(aligned(mel).starts, [0, 1, 2]);

  const all = convert(xml, { melodyOnly: false });
  assert.deepEqual(all.notes.map((n) => [n.t, n.m]), [[0, 60], [0, 64], [0, 67], [1, 65], [1, 69], [2, 62]]);
  assert.equal(all.lyricText, 'la li lo');
  assert.deepEqual(aligned(all).starts, [0, 1, 2]);
});

test('backup/forward: voices become separate tracks; the merged staff track follows the top line', () => {
  const xml = partwise([
    M(attrs() + tempo(60)
      + N('C5', 2, { voice: 1, lyric: '가' }) + N('D5', 2, { voice: 1, lyric: '나' })
      + backup(4) + forward(1) + N('A3', 1, { voice: 2 }) + N('B3', 2, { voice: 2 })),
    M(R(4, { voice: 1 }) + backup(4) + N('E4', 4, { voice: 2 })),
  ]);
  const score = parseMusicXml(xml);
  const part = score.parts[0];
  assert.deepEqual(part.voices, ['1', '2']);
  assert.deepEqual(part.tracks.map((t) => t.key), ['P1|s1|v1', 'P1|s1|v2', 'P1|s1|*']);
  assert.equal(part.tracks[2].label, '보컬 · 1단 · 모든 성부');
  assert.equal(part.tracks[2].voice, null);

  const v1 = scoreToSong(score, { trackKey: 'P1|s1|v1' });
  assert.deepEqual(v1.notes, [{ t: 0, d: 2, m: 72 }, { t: 2, d: 2, m: 74 }]);
  const v2 = scoreToSong(score, { trackKey: 'P1|s1|v2' });
  assert.deepEqual(v2.notes, [{ t: 1, d: 1, m: 57 }, { t: 2, d: 2, m: 59 }, { t: 4, d: 4, m: 64 }]);
  assert.equal(v2.lyricText, '');
  assert.ok(v2.warnings.includes('선택한 성부에는 가사가 없어요. 가사가 있는 성부: 보컬 · 1단 · 성부 1'));
  const merged = scoreToSong(score, { trackKey: 'P1|s1|*' });
  assert.deepEqual(ms(merged), [72, 74, 64]);
  assert.deepEqual(ts(merged), [0, 2, 4]);
  assert.equal(recommendTrack(score), 'P1|s1|v1');
});

test('two staves: melody staff vs bass staff; a brief cross-staff melody note stays in the melody track', () => {
  const xml = partwise([{ id: 'P1', name: 'Piano', measures: [
    M(attrs({ staves: 2 }) + tempo(60)
      + N('E5', 1, { staff: 1, lyric: '하' }) + N('D5', 1, { staff: 1, lyric: '나' })
      + N('C5', 1, { staff: 1, lyric: '둘' }) + N('G4', 1, { staff: 1, lyric: '셋' })
      + backup(4) + N('C3', 2, { staff: 2, voice: 5 }) + N('G2', 2, { staff: 2, voice: 5 })),
    M(N('C5', 1, { staff: 1, lyric: '넷' }) + N('E3', 1, { staff: 2, lyric: '다' }) + N('C5', 2, { staff: 1, lyric: '섯' })
      + backup(4) + N('C3', 4, { staff: 2, voice: 5 })),
  ] }]);
  const score = parseMusicXml(xml);
  const part = score.parts[0];
  assert.equal(part.name, '피아노');
  assert.equal(part.staves, 2);
  assert.deepEqual(part.tracks.map((t) => [t.key, t.label]), [
    ['P1|s1|v1', '피아노 · 1단 · 성부 1'],
    ['P1|s2|v5', '피아노 · 2단 · 성부 5'],
    ['P1|*|*', '피아노 · 전체'],
  ]);
  assert.equal(recommendTrack(score), 'P1|s1|v1');
  const melody = scoreToSong(score);
  assert.deepEqual(ms(melody), [76, 74, 72, 67, 72, 52, 72]);
  assert.equal(melody.lyricText, '하 나 둘 셋 넷 다 섯');
  aligned(melody);
  const bass = scoreToSong(score, { trackKey: 'P1|s2|v5' });
  assert.deepEqual(bass.notes, [{ t: 0, d: 2, m: 48 }, { t: 2, d: 2, m: 43 }, { t: 4, d: 4, m: 48 }]);
  const all = scoreToSong(score, { trackKey: 'P1|*|*' });
  assert.deepEqual(ms(all), [76, 74, 72, 67, 72, 52, 72]);
});

test('transposing instruments sound at concert pitch (<transpose><chromatic> + octave-change)', () => {
  const bb = convert(partwise([M(attrs({ extra: '<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>' })
    + tempo(60) + N('D5', 1) + N('E5', 1) + N('F#5', 2))]));
  assert.deepEqual(ms(bb), [72, 74, 76]);
  const oct = convert(partwise([M(attrs({ extra: '<transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>' })
    + tempo(60) + N('C5', 2) + N('Bb4', 2))]));
  assert.deepEqual(ms(oct), [60, 58]);
});

test('tempo map: <sound tempo> mid-measure and <metronome> (half = 30) change note seconds', () => {
  const song = convert(partwise([
    M(attrs() + tempo(60) + N('C4', 1) + N('C4', 1) + N('C4', 1) + N('C4', 1)),
    M(N('D4', 1) + N('D4', 1) + words('a tempo', '<sound tempo="120"/>') + N('E4', 1) + N('E4', 1)),
    M('<direction><direction-type><metronome><beat-unit>half</beat-unit><per-minute>30</per-minute></metronome></direction-type></direction>'
      + N('F4', 2) + N('F4', 2)),
  ]));
  closeAll(ts(song), [0, 1, 2, 3, 4, 5, 6, 6.5, 7, 9]);
  closeAll(song.notes.map((n) => n.d), [1, 1, 1, 1, 1, 1, 0.5, 0.5, 2, 2]);
  assert.equal(song.bpm, 60);
  assert.equal(song.beatsPerBar, 4);
  assert.equal(song.offset, 0);
  assert.ok(song.warnings.some((w) => w.includes('빠르기가 바뀌어요')));
});

test('tempo printed only as text (typical OMR output) is still used', () => {
  const tempoOf = (w) => parseMusicXml(partwise([M(attrs() + words(w) + N('C4', 4))])).tempo;
  assert.equal(tempoOf('♩ = 76'), 76);
  assert.equal(tempoOf('Moderato J=72'), 72);
  assert.equal(tempoOf('♩. = 40'), 60);
  assert.equal(tempoOf('♪ = 120'), 60);
  assert.equal(tempoOf('= 88'), 88);
  assert.equal(tempoOf('(♩ = c. 100)'), 100);
  for (const none of ['a tempo', '2 = 3', 'rit.', '♩ = 7', 'D.C. al Fine']) assert.equal(tempoOf(none), null, none);
  const song = convert(partwise([M(attrs() + words('♩=120') + N('C4', 1) + N('D4', 1) + N('E4', 2))]));
  assert.deepEqual(ts(song), [0, 0.5, 1]);
  assert.equal(song.bpm, 120);
  assert.ok(!song.warnings.some((w) => w.includes('빠르기 표시가 없어')));
});

test('no tempo → BPM 100 with a warning; bpm override; 6/8 grid counts eighth notes', () => {
  const xml = partwise([M(attrs() + N('C4', 1) + N('D4', 1) + N('E4', 2))]);
  const def = convert(xml);
  closeAll(ts(def), [0, 0.6, 1.2]);
  assert.equal(def.bpm, 100);
  assert.ok(def.warnings.some((w) => w.includes('빠르기 표시가 없어')));
  const fast = convert(xml, { bpm: 120 });
  closeAll(ts(fast), [0, 0.5, 1]);
  assert.equal(fast.bpm, 120);
  assert.deepEqual(fast.warnings, ['악보에 가사가 없어요.']);

  const six = convert(partwise([M(attrs({ div: 2, beats: 6, type: 8 })
    + '<direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>40</per-minute>'
    + '</metronome></direction-type></direction>'
    + N('C4', 3) + N('D4', 1) + N('E4', 2))]));
  assert.equal(six.beatsPerBar, 6);
  assert.equal(six.bpm, 120); // dotted quarter 40 = quarter 60 = eighth 120
  closeAll(ts(six), [0, 1.5, 2]);
  const sixSlower = convert(partwise([M(attrs({ div: 2, beats: 6, type: 8 }) + tempo(60) + N('C4', 3) + N('D4', 3))]), { bpm: 60 });
  assert.equal(sixSlower.bpm, 60); // 60 eighths per minute
  closeAll(ts(sixSlower), [0, 3]);

  // Eighth-note beats would exceed 300 BPM here, so the grid (and an override) counts quarter notes.
  const fastSix = partwise([M(attrs({ div: 2, beats: 6, type: 8 }) + tempo(160) + N('C4', 3) + N('D4', 3))]);
  const natural = convert(fastSix);
  assert.equal(natural.bpm, 160);
  assert.equal(natural.beatsPerBar, 3);
  closeAll(ts(natural), [0, 0.5625], 0.001); // times are rounded to 1 ms
  const overridden = convert(fastSix, { bpm: 150 });
  assert.equal(overridden.bpm, 150);
  assert.equal(overridden.beatsPerBar, 3);
  closeAll(ts(overridden), [0, 0.6]);
});

test('pickup measure (implicit or just short) starts so that bar lines stay on the grid', () => {
  const pick = (implicit) => convert(partwise([
    M(attrs() + tempo(60) + N('G4', 1, { lyric: '라' }), { implicit }),
    M(N('C5', 2, { lyric: '라' }) + N('E5', 2, { lyric: '라' })),
  ]));
  for (const implicit of [true, false]) {
    const song = pick(implicit);
    assert.deepEqual(ts(song), [3, 4, 6]);
    assert.deepEqual(aligned(song).starts, [3, 4, 6]);
  }
});

test('lenient OMR input: no divisions/voice/staff, unknown elements, type-only durations, microtones, bad measure lengths', () => {
  const xml = '<score-partwise><part-list><score-part id="P1"><part-name></part-name></score-part></part-list><part id="P1">'
    + '<measure number="1"><attributes><time><beats>4</beats><beat-type>4</beat-type></time></attributes>'
    + '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><foo>bar</foo></note>'
    + '<note><pitch><step>D</step><octave>4</octave></pitch><type>eighth</type></note>'
    + '<note><pitch><step>E</step><octave>4</octave></pitch><type>quarter</type><dot/></note>'
    + '<note><pitch><step>F</step><alter>0.5</alter><octave>4</octave></pitch><duration>1</duration></note></measure>'
    + '<measure number="2"><note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note>'
    + '<note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration></note></measure>'
    + '<measure number="3"><note><pitch><step>B</step><octave>4</octave></pitch><duration>5</duration></note></measure>'
    + '<measure number="4"><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note>'
    + '<bogus/></measure></part></score-partwise>';
  const score = parseMusicXml(xml);
  assert.equal(score.parts[0].name, '파트 1');
  assert.equal(score.parts[0].tracks[0].key, 'P1|s1|v1');
  const song = scoreToSong(score);
  const q = 0.6; // default 100 BPM
  closeAll(ts(song), [0, 1, 1.5, 3, 4, 5, 8, 13].map((x) => x * q));
  assert.deepEqual(ms(song), [60, 62, 64, 66, 67, 69, 71, 72]);
});

test('grace notes, cue notes and unpitched notes are not melody notes (cue/unpitched still take time)', () => {
  const song = convert(partwise([M(attrs() + tempo(60)
    + N('G4', null, { grace: true, type: 'eighth' }) + N('C4', 1, { lyric: '가' }) + N('D4', 1, { cue: true })
    + N('X', 1) + N('E4', 1, { lyric: '나' }))]));
  assert.deepEqual(song.notes, [{ t: 0, d: 1, m: 60 }, { t: 3, d: 1, m: 64 }]);
  assert.equal(song.lyricText, '가\n나'); // two silent beats in between start a new line
  assert.deepEqual(aligned(song).starts, [0, 3]);
});

// ---------------------------------------------------------------- repeats

function voltaScore() {
  const L2 = (a, b) => [{ t: a, n: 1 }, { t: b, n: 2 }];
  return partwise([
    M(attrs() + tempo(60) + N('C4', 2, { lyric: L2('가', '다') }) + N('D4', 2, { lyric: L2('나', '라') }), { left: REPEAT_FWD }),
    M(N('E4', 2, { lyric: '마' }) + N('F4', 2, { lyric: '바' }), { left: ending(1, 'start', 'left'), right: ending(1, 'stop', 'right') }),
    M(N('G4', 2, { lyric: { t: '사', n: 2 } }) + N('A4', 2, { lyric: { t: '아', n: 2 } }),
      { left: ending(2, 'start', 'left'), right: ending(2, 'discontinue', 'right') }),
    M(N('C5', 2, { lyric: '자' }) + N('C5', 2, { lyric: '차' })),
  ]);
}

test('repeats with 1st/2nd endings unfold; verse auto sings verse 2 on the second pass', () => {
  const score = parseMusicXml(voltaScore());
  assert.deepEqual(score.parts[0].verses, [1, 2]);
  const song = scoreToSong(score);
  assert.deepEqual(ms(song), [60, 62, 64, 65, 60, 62, 67, 69, 72, 72]);
  assert.deepEqual(ts(song), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  assert.equal(song.lyricText, '가 나 마 바\n다 라 사 아 자 차');
  const { starts, texts } = aligned(song);
  assert.deepEqual(starts, ts(song));
  assert.deepEqual(texts, ['가', '나', '마', '바', '다', '라', '사', '아', '자', '차']);
  assert.deepEqual(song.stats, { notes: 10, syllables: 10 });

  const flat = scoreToSong(score, { unfoldRepeats: false });
  assert.deepEqual(ms(flat), [60, 62, 64, 65, 67, 69, 72, 72]);
  assert.equal(flat.lyricText, '가 나 마 바 사 아 자 차');
  aligned(flat);

  const v2 = scoreToSong(score, { verse: 2 });
  assert.equal(v2.lyricText, '다 라 마 바\n다 라 사 아 자 차');
  aligned(v2);
  const v3 = scoreToSong(score, { verse: 3 });
  assert.ok(v3.warnings.some((w) => w.includes('3절 가사')));
  aligned(v3);
});

test('repeat without forward sign goes back to the start; times="3" plays three passes', () => {
  const song = convert(partwise([
    M(attrs() + tempo(60) + N('C4', 4)),
    M(N('D4', 4), { right: '<barline location="right"><repeat direction="backward" times="3"/></barline>' }),
    M(N('E4', 4)),
  ]));
  assert.deepEqual(ms(song), [60, 62, 60, 62, 60, 62, 64]);
});

test('D.C. al Fine via <sound> attributes, and inferred from words only (with a warning)', () => {
  const build = (fine, dc) => partwise([
    M(attrs() + tempo(60) + N('C4', 4, { lyric: '가' })),
    M(N('D4', 4, { lyric: '나' }) + fine, { right: '<barline location="right"><bar-style>light-heavy</bar-style></barline>' }),
    M(N('E4', 4, { lyric: '다' }) + dc),
  ]);
  const explicit = convert(build(words('Fine', '<sound fine="yes"/>'), words('D.C. al Fine', '<sound dacapo="yes"/>')));
  assert.deepEqual(ms(explicit), [60, 62, 64, 60, 62]);
  assert.deepEqual(ts(explicit), [0, 4, 8, 12, 16]);
  assert.equal(explicit.lyricText, '가 나 다\n가 나');
  assert.deepEqual(explicit.warnings, []);
  aligned(explicit);

  const inferred = convert(build(words('Fine'), words('D.C. al Fine')));
  assert.deepEqual(ms(inferred), [60, 62, 64, 60, 62]);
  assert.ok(inferred.warnings.some((w) => w.includes('추정')));

  const flat = convert(build(words('Fine'), words('D.C. al Fine')), { unfoldRepeats: false });
  assert.deepEqual(ms(flat), [60, 62, 64]);
});

test('D.S. al Coda jumps to the segno, then from To Coda to the coda', () => {
  const song = convert(partwise([
    M(attrs() + tempo(60) + N('C4', 4)),
    M('<direction><direction-type><segno/></direction-type><sound segno="segno"/></direction>' + N('D4', 4)),
    M(N('E4', 4) + words('To Coda', '<sound tocoda="coda"/>')),
    M(N('F4', 4) + words('D.S. al Coda', '<sound dalsegno="segno"/>')),
    M('<direction><direction-type><coda/></direction-type><sound coda="coda"/></direction>' + N('G4', 4)),
  ]));
  assert.deepEqual(ms(song), [60, 62, 64, 65, 62, 64, 67]);
});

// ---------------------------------------------------------------- lyrics

test('syllabic begin/middle/end join words; Korean and Latin; melisma inside a word', () => {
  const song = convert(partwise([
    M(attrs() + tempo(60) + N('C4', 1, { lyric: { t: 'pi', s: 'begin' } }) + N('D4', 1, { lyric: { t: 'a', s: 'middle' } })
      + N('E4', 1, { lyric: { t: 'no', s: 'end' } }) + N('F4', 1, { lyric: { t: 'keys', s: 'single' } })),
    M(N('C4', 1, { lyric: { t: '하', s: 'begin' } }) + N('D4', 1, { lyric: { t: '나', s: 'end' } })
      + N('E4', 1, { lyric: { t: '둘', s: 'single' } }) + N('F4', 1, { lyric: '셋' })),
    M(N('G4', 1, { lyric: { t: 'Sun', s: 'begin' } }) + N('A4', 1) + N('B4', 1, { lyric: { t: 'ny', s: 'end' } })
      + N('C5', 1, { lyric: 'day' })),
  ]));
  assert.equal(song.lyricText, 'pi-a-no keys 하나 둘 셋 Sun~ny day');
  const { lines, starts } = aligned(song);
  assert.equal(lyricsPlainText(lines), 'piano keys 하나 둘 셋 Sunny day');
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11]);
  assert.equal(lines[0].syllables[8].d, 2); // 'Sun' held over the melisma note
});

test('<extend/> → "~" for the following notes; extend stop ends it; other lyric-less notes → "_"', () => {
  const song = convert(partwise([
    M(attrs() + tempo(60) + N('C4', 1) + N('D4', 1, { lyric: { t: '라', ext: true } }) + N('E4', 1) + N('F4', 1)),
    M(N('G4', 1, { lyric: '마' }) + N('A4', 1, { lyric: { t: '오', ext: 'start' } }) + N('B4', 1, { lyric: { ext: 'stop' } })
      + N('A4', 1)),
    M(N('C5', 2, { lyric: '예' }) + R(1) + N('C5', 1)),
  ]));
  assert.equal(song.lyricText, '_ 라~~ 마 오~ _ 예\n_');
  const { syls, starts } = aligned(song);
  assert.deepEqual(starts, [1, 4, 5, 8]);
  assert.equal(syls[0].d, 3);
  assert.equal(syls[2].d, 2);
});

test('several syllables on one note become one {group}; elisions and split <text> are joined', () => {
  const song = convert(partwise([M(attrs() + tempo(60)
    + N('C4', 1, { lyric: '하나' }) + N('D4', 1, { lyric: 'so far' })
    + N('E4', 1, { raw: '<lyric number="1"><syllabic>single</syllabic><text>a</text><elision>‿</elision><syllabic>single</syllabic><text>e</text></lyric>' })
    + N('F4', 1, { raw: '<lyric number="1"><text>la</text><text>la</text></lyric>' }))]));
  assert.equal(song.lyricText, '{하나} {so far} {a e} lala');
  const { texts, starts } = aligned(song);
  assert.deepEqual(texts, ['하나', 'so far', 'a e', 'lala']);
  assert.deepEqual(starts, [0, 1, 2, 3]);
  assert.equal(tokenizeLine(song.lyricText).length, 4);
});

test('messy lyric text: extra spaces, punctuation-only syllables, odd syllabic values, hyphens, brackets', () => {
  const song = convert(partwise([
    M(attrs() + tempo(60) + N('C4', 1, { lyric: '  가  ' }) + N('D4', 1, { lyric: ',' })
      + N('E4', 1, { lyric: { t: '나', s: 'weird' } }) + N('F4', 1, { lyric: '!' })),
    M(N('G4', 1, { lyric: 'Mor-' }) + N('A4', 1, { lyric: '-ning' }) + N('B4', 1, { lyric: '[오]' }) + N('C5', 1, { lyric: '___' })),
    M(N('C5', 1, { lyric: '{예}' }) + N('D5', 1, { lyric: '#둘' }) + N('E5', 2, { lyric: '-' })),
  ]));
  assert.equal(song.lyricText, '가, _ 나! _ Mor-ning (오)~ 예 둘~');
  const { lines, starts } = aligned(song);
  assert.deepEqual(starts, [0, 2, 4, 5, 6, 8, 9]);
  assert.equal(lyricsPlainText(lines), '가, 나! Morning (오) 예 둘');
});

test('line breaks: new system, rests of a beat or more, 16 syllables; never inside a word', () => {
  const song = convert(partwise([
    M(attrs({ div: 2 }) + tempo(60) + N('C4', 2, { lyric: '가' }) + N('D4', 2, { lyric: '나' }) + R(2)
      + N('E4', 2, { lyric: '다' })),
    M(N('F4', 2, { lyric: '라' }) + N('G4', 1, { lyric: '마' }) + R(1) + N('A4', 2, { lyric: '바' })
      + N('B4', 2, { lyric: { t: 'Sun', s: 'begin' } })),
    M(N('C5', 4, { lyric: { t: 'ny', s: 'end' } }) + N('D5', 4, { lyric: '아' }), { print: true }),
  ]));
  assert.equal(song.lyricText, '가 나\n다 라 마 바 Sun-ny\n아');
  aligned(song);

  const words20 = ['하', '나', '둘', '셋', '넷'];
  const measures = [];
  for (let k = 0; k < 5; k++) {
    let notes = k === 0 ? attrs() + tempo(120) : '';
    for (let j = 0; j < 4; j++) notes += N('C4', 1, { lyric: words20[(k * 4 + j) % 5] });
    measures.push(M(notes));
  }
  const long = convert(partwise(measures));
  assert.deepEqual(long.lyricText.split('\n').map((l) => tokenizeLine(l).length), [16, 4]);
  aligned(long);
});

test('assignLyrics gets exactly one syllable per lyric note across a busy score (zero warnings)', () => {
  const xml = partwise([
    M(attrs({ div: 2 }) + tempo(84) + N('G4', 2) + N('C5', 2, { lyric: [{ t: '하', n: 1, s: 'begin' }, { t: 'la', n: 2 }] })
      + N('D5', 1, { lyric: [{ t: '나', n: 1, s: 'end', ext: true }, { t: 'li', n: 2 }] }) + N('E5', 1)
      + N('C5', 2, { lyric: [{ t: '둘셋', n: 1 }, { t: 'lo', n: 2 }] }), { left: REPEAT_FWD }),
    M(N('B4', 4, { tie: 'start', lyric: '넷' }) + N('B4', 2, { tie: 'stop' }) + R(1) + N('A4', 1, { lyric: 'la' })),
    M(N('G4', 2, { lyric: 'li' }) + N('E4', 2, { chord: true }) + N('A4', 2) + N('G4', 4, { lyric: { t: 'lo', ext: true } }),
      { right: '<barline location="right"><repeat direction="backward"/></barline>' }),
    M(N('C5', 8, { lyric: '끝' }), { print: true }),
  ]);
  const score = parseMusicXml(xml);
  const song = scoreToSong(score);
  const { starts, texts } = aligned(song);
  // pass 1 sings verse 1, pass 2 verse 2 where it exists (measure 1) and verse 1 elsewhere
  assert.deepEqual(texts, ['하', '나', '둘셋', '넷', 'la', 'li', 'lo', 'la', 'li', 'lo', '넷', 'la', 'li', 'lo', '끝']);
  // the extend on the last note before the repeat does not leak into the next pass
  assert.equal(song.lyricText, '_ 하나~ {둘셋} 넷 la li _ lo\n_ la li _ lo 넷 la li _ lo\n끝');
  // every syllable starts exactly on a note
  const noteStarts = new Set(ts(song));
  for (const t of starts) assert.ok(noteStarts.has(t), `syllable at ${t} has no note`);
  for (const melodyOnly of [true, false]) {
    for (const unfoldRepeats of [true, false]) aligned(scoreToSong(score, { melodyOnly, unfoldRepeats }));
  }
});

test('recommendTrack: the lyric track wins over a higher, busier one; otherwise the highest line with ≥ 8 notes', () => {
  const run = (pitch, n, lyric) => {
    let s = attrs() + tempo(100);
    for (let k = 0; k < n; k++) s += N(pitch, 1, lyric ? { lyric: 'la' } : {});
    return [M(s)];
  };
  const withLyrics = parseMusicXml(partwise([
    { id: 'P1', name: 'Piano', measures: run('C6', 12, false) },
    { id: 'P2', name: 'Voice', measures: run('E4', 10, true) },
  ]));
  assert.equal(recommendTrack(withLyrics), 'P2|s1|v1');
  assert.equal(scoreToSong(withLyrics).stats.syllables, 10);

  const noLyrics = parseMusicXml(partwise([
    { id: 'P1', name: 'Flute', measures: run('C7', 3, false) },
    { id: 'P2', name: 'Violin', measures: run('A5', 10, false) },
    { id: 'P3', name: 'Cello', measures: run('C3', 10, false) },
  ]));
  assert.equal(recommendTrack(noLyrics), 'P2|s1|v1');
  assert.equal(recommendTrack({ parts: [] }), null);
});

test('score-timewise is converted and gives the same result as partwise', () => {
  const m1a = attrs() + tempo(60) + N('C4', 2, { lyric: '하' }) + N('E4', 2, { lyric: '나' });
  const m2a = N('G4', 4, { lyric: '둘' });
  const m1b = attrs() + N('C3', 4, { voice: 5 });
  const m2b = N('G2', 4, { voice: 5 });
  const list = '<part-list><score-part id="P1"><part-name>Voice</part-name></score-part>'
    + '<score-part id="P2"><part-name>Bass</part-name></score-part></part-list>';
  const timewise = `<?xml version="1.0"?><score-timewise version="4.0">${list}`
    + `<measure number="1"><part id="P1">${m1a}</part><part id="P2">${m1b}</part></measure>`
    + `<measure number="2"><part id="P1">${m2a}</part><part id="P2">${m2b}</part></measure></score-timewise>`;
  const pw = partwise([
    { id: 'P1', name: 'Voice', measures: [M(m1a), M(m2a)] },
    { id: 'P2', name: 'Bass', measures: [M(m1b), M(m2b)] },
  ]);
  const a = parseMusicXml(timewise);
  const b = parseMusicXml(pw);
  assert.equal(a.measureCount, 2);
  assert.deepEqual(a.parts.map((p) => p.tracks.map((t) => t.key)), [['P1|s1|v1'], ['P2|s1|v5']]);
  assert.deepEqual(scoreToSong(a), scoreToSong(b));
  assert.deepEqual(scoreToSong(a, { trackKey: 'P2|s1|v5' }).notes, [{ t: 0, d: 4, m: 48 }, { t: 4, d: 4, m: 43 }]);
});

test('.mxl end to end: unzip → parse → song', async () => {
  const xml = partwise([
    M(attrs() + tempo(60) + N('E4', 1, { lyric: '하' }) + N('G4', 1, { lyric: '나' }) + N('C5', 2, { lyric: { t: '둘', ext: true } })),
    M(N('B4', 2) + N('C5', 2, { lyric: '셋' })),
  ]);
  const zip = await makeZip([
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="song.xml"/></rootfiles></container>' },
    { name: 'song.xml', data: xml },
  ]);
  const song = scoreToSong(parseMusicXml(await readScoreText(zip)));
  assert.deepEqual(ts(song), [0, 1, 2, 4, 6]);
  assert.equal(song.lyricText, '하 나 둘~ 셋');
  assert.deepEqual(aligned(song).starts, [0, 1, 2, 6]);
});

// ---------------------------------------------------------------- two-hand accompaniment (scoreToArrangement)

// Chord: first note normal, the rest with <chord/>.
const CH = (ps, dur, o = {}) => ps.map((p, k) => N(p, dur, { ...o, chord: k > 0 })).join('');

// Mimics OMR output of a "piano 3-stave" score: 3 parts (one staff, one voice each), generic part names, no tempo.
// P1 = sung melody (placeholder words, optional), P2 = right-hand chords, P3 = left-hand bass.
// OMR damage: P2 measure 2 is over-full (a misread duration: 5 quarters in 4/4), P3 measure 3 is short.
const OMR_WORDS = ['하', '나', '둘', '셋', '넷', '다', '섯', '여', '덟', '아', '홉'];
function omrScore({ lyrics = true } = {}) {
  let w = 0;
  const v = (p, dur) => N(p, dur, lyrics ? { lyric: OMR_WORDS[w++] } : {});
  const vocal = [
    M(attrs() + v('E4', 1) + v('D4', 1) + v('C4', 2)),
    M(v('F4', 1) + v('A4', 1) + v('G4', 2)),
    M(v('G4', 1) + v('F4', 1) + v('E4', 1) + v('D4', 1)),
    M(v('C4', 4)),
  ];
  const rh = [
    M(attrs() + CH(['E4', 'G4', 'C5'], 2) + CH(['E4', 'G4', 'C5'], 2)),
    M(CH(['F4', 'A4', 'C5'], 2) + CH(['F4', 'A4', 'C5'], 3)), // over-full
    M(CH(['D4', 'G4', 'B4'], 2) + CH(['D4', 'F4', 'B4'], 2)),
    M(CH(['E4', 'G4', 'C5'], 4)),
  ];
  const lh = [
    M(attrs() + N('C3', 4)),
    M(N('F2', 2) + N('F3', 2)),
    M(N('G2', 2)), // short: the second half was not recognized
    M(N('C3', 2) + N('C2', 2)),
  ];
  return partwise([
    { id: 'P1', name: 'MusicXML Part', measures: vocal },
    { id: 'P2', name: 'MusicXML Part', measures: rh },
    { id: 'P3', name: 'MusicXML Part', measures: lh },
  ]);
}

const OMR_KEYS = { vocalKey: 'P1|s1|v1', playKeys: ['P2|s1|v1', 'P3|s1|v1'] };
const at = (notes, t) => notes.filter((n) => Math.abs(n.t - t) < 1e-6).map((n) => n.m);

test('scoreToArrangement: OMR 3-part score → both hands + vocal on ONE timeline despite bad measures', () => {
  const score = parseMusicXml(omrScore());
  const res = scoreToArrangement(score, OMR_KEYS);
  const q = 0.6; // no tempo → 100 BPM
  assert.equal(res.bpm, 100);
  assert.equal(res.beatsPerBar, 4);
  assert.equal(res.offset, 0);

  // vocal: the sung melody, measure starts 0 / 4 / 8 / 12 quarters
  assert.deepEqual(res.vocal.map((n) => n.m), [64, 62, 60, 65, 69, 67, 67, 65, 64, 62, 60]);
  closeAll(res.vocal.map((n) => n.t), [0, 1, 2, 4, 5, 6, 8, 9, 10, 11, 12].map((x) => x * q));
  assert.equal(res.vocal.some((n) => 'h' in n), false);

  // hands: P2 (higher) → right, P3 → left; chords are kept
  const rh = res.notes.filter((n) => n.h === 'R');
  const lh = res.notes.filter((n) => n.h === 'L');
  assert.equal(rh.length + lh.length, res.notes.length);
  assert.deepEqual(lh.map((n) => n.m), [48, 41, 53, 43, 48, 36]);
  assert.deepEqual(at(rh, 0), [64, 67, 72]);
  assert.deepEqual(res.stats, { right: 21, left: 6, vocal: 11, syllables: 11 });

  // the over-full right-hand measure 2 is squeezed into its 4 quarters …
  closeAll([...new Set(rh.filter((n) => n.t >= 4 * q - 1e-6 && n.t < 8 * q).map((n) => n.t))], [4 * q, 5.6 * q], 0.001);
  // … so measures 3 and 4 line up: chord, bass and sung note written on the same beat share one time
  for (const beat of [8, 12]) {
    const t = beat * q;
    assert.ok(at(rh, t).length >= 3, `right-hand chord at beat ${beat}`);
    assert.equal(at(lh, t).length, 1, `bass at beat ${beat}`);
    assert.equal(at(res.vocal, t).length, 1, `sung note at beat ${beat}`);
  }
  assert.deepEqual(at(res.notes, 8 * q), [43, 62, 67, 71]);
  assert.deepEqual(at(res.notes, 12 * q), [48, 64, 67, 72]);
  assert.deepEqual(at(lh, 14 * q), [36]);
  assert.deepEqual(res.notes, [...res.notes].sort((a, b) => a.t - b.t || a.m - b.m));

  // per-track conversion (scoreToSong) would have drifted by the extra quarter
  const alone = scoreToSong(score, { trackKey: 'P2|s1|v1', melodyOnly: false });
  close(alone.notes.find((n) => n.m === 71).t, 9 * q);

  assert.ok(res.warnings.some((w) => w.includes('빠르기 표시가 없어')));
  assert.ok(res.warnings.some((w) => w.includes('맞춰 정렬한 마디') && w.includes('2번째 마디')), res.warnings.join(' / '));
});

test('scoreToArrangement: lyric text aligns with the vocal notes (one token per vocal note event)', () => {
  const res = scoreToArrangement(parseMusicXml(omrScore()), OMR_KEYS);
  assert.equal(tokenizeLine(res.lyricText.replace(/\n/g, ' ')).length, groupNoteEvents(res.vocal).length);
  const fit = assignLyrics(res.lyricText, res.vocal);
  assert.deepEqual(fit.warnings, []);
  const syls = fit.lines.flatMap((l) => l.syllables);
  assert.deepEqual(syls.map((x) => x.text.trim()), OMR_WORDS);
  assert.deepEqual(syls.map((x) => x.t), res.vocal.map((n) => n.t));

  // what the editor stores: simplified notes + vocal; lyrics are timed on the vocal line, not on the chords
  const song = normalizeSong({
    title: '연습', arrangement: 'accompaniment', bpm: res.bpm, beatsPerBar: res.beatsPerBar, offset: res.offset,
    notes: simplifyAccompaniment(res.notes, { right: 2, left: 1 }), vocal: res.vocal,
    lyrics: { text: res.lyricText, source: 'notes' },
  });
  assert.equal(song.arrangement, 'accompaniment');
  assert.deepEqual(song.lyrics.lines.flatMap((l) => l.syllables).map((x) => x.t), res.vocal.map((n) => n.t));
  assert.equal(at(song.notes, 0).length, 3); // 2 right-hand notes + 1 bass note
  assert.equal(song.notes.every((n) => n.h === 'R' || n.h === 'L'), true);
});

test('scoreToArrangement: vocal without lyrics (typical OMR) → empty lyric text, same timeline', () => {
  const withWords = scoreToArrangement(parseMusicXml(omrScore()), OMR_KEYS);
  const res = scoreToArrangement(parseMusicXml(omrScore({ lyrics: false })), OMR_KEYS);
  assert.equal(res.lyricText, '');
  assert.equal(res.stats.syllables, 0);
  assert.ok(res.warnings.includes('악보에 가사가 없어요.'));
  assert.deepEqual(res.vocal, withWords.vocal);
  assert.deepEqual(res.notes, withWords.notes);
  // lyrics the user pastes later are timed against the vocal line
  const pasted = assignLyrics('la la la la la la la la la la la', res.vocal);
  assert.deepEqual(pasted.warnings, []);
  const off = scoreToArrangement(parseMusicXml(omrScore()), { ...OMR_KEYS, includeLyrics: false });
  assert.equal(off.lyricText, '');
  assert.ok(!off.warnings.includes('악보에 가사가 없어요.'));
});

test('scoreToArrangement: a pickup shorter in one part than in the others is aligned to the downbeat', () => {
  const build = (fullPianoPickup) => partwise([
    { id: 'P1', name: 'Voice', measures: [
      M(attrs() + N('G4', 1, { lyric: '라' })),
      M(N('C5', 4, { lyric: '라' })),
    ] },
    { id: 'P2', name: 'Piano', measures: [
      M(attrs() + (fullPianoPickup ? R(3) : '') + CH(['B3', 'D4', 'G4'], 1)),
      M(CH(['E4', 'G4', 'C5'], 4)),
    ] },
    { id: 'P3', name: 'Piano', measures: [
      M(attrs() + (fullPianoPickup ? R(3) : '') + N('G2', 1)),
      M(N('C3', 4)),
    ] },
  ]);
  for (const full of [false, true]) {
    const res = scoreToArrangement(parseMusicXml(build(full)), OMR_KEYS);
    assert.deepEqual(res.vocal.map((n) => n.t), [1.8, 2.4], `full piano pickup: ${full}`);
    assert.deepEqual(at(res.notes, 1.8), [43, 59, 62, 67]);
    assert.deepEqual(at(res.notes, 2.4), [48, 64, 67, 72]);
    assert.deepEqual(assignLyrics(res.lyricText, res.vocal).warnings, []);
  }
});

test('scoreToArrangement: repeats written in one part only unfold every track the same way', () => {
  const back = '<barline location="right"><repeat direction="backward"/></barline>';
  const xml = partwise([
    { id: 'P1', name: 'Voice', measures: [
      M(attrs() + words('♩ = 120') + N('C4', 2, { lyric: '가' }) + N('E4', 2, { lyric: '나' })),
      M(N('G4', 4, { lyric: '다' }), { right: back }),
      M(N('C5', 4, { lyric: '라' })),
    ] },
    { id: 'P2', name: 'Piano', measures: [
      M(attrs() + CH(['E4', 'G4'], 4)), M(CH(['D4', 'B4'], 4)), M(CH(['E4', 'C5'], 4)),
    ] },
    { id: 'P3', name: 'Piano', measures: [M(attrs() + N('C3', 4)), M(N('G2', 4)), M(N('C3', 4))] },
  ]);
  const score = parseMusicXml(xml);
  const res = scoreToArrangement(score, OMR_KEYS);
  assert.equal(res.bpm, 120);
  assert.deepEqual(res.vocal.map((n) => n.t), [0, 1, 2, 4, 5, 6, 8]);
  assert.deepEqual(res.notes.filter((n) => n.h === 'L').map((n) => [n.t, n.m]), [[0, 48], [2, 43], [4, 48], [6, 43], [8, 48]]);
  assert.equal(res.notes.length, 15);
  assert.equal(res.lyricText.replace(/\s+/g, ' '), '가 나 다 가 나 다 라');
  assert.deepEqual(assignLyrics(res.lyricText, res.vocal).warnings, []);
  const flat = scoreToArrangement(score, { ...OMR_KEYS, unfoldRepeats: false });
  assert.deepEqual(flat.vocal.map((n) => n.t), [0, 1, 2, 4]);
  assert.equal(flat.notes.length, 9);
});

test('scoreToArrangement: hands option, single play track split at middle C, bpm override, no vocal', () => {
  const score = parseMusicXml(omrScore());
  const swapped = scoreToArrangement(score, { ...OMR_KEYS, hands: { 'P2|s1|v1': 'L', 'P3|s1|v1': 'R' } });
  assert.deepEqual(swapped.notes.filter((n) => n.h === 'R').map((n) => n.m), [48, 41, 53, 43, 48, 36]);
  assert.deepEqual(swapped.stats, { right: 6, left: 21, vocal: 11, syllables: 11 });
  const partial = scoreToArrangement(score, { ...OMR_KEYS, hands: { 'P3|s1|v1': 'L', 'P2|s1|v1': 'x' } });
  assert.equal(partial.stats.right, 21);

  const single = scoreToArrangement(score, { vocalKey: 'P1|s1|v1', playKeys: ['P3|s1|v1', 'P3|s1|v1'] });
  assert.equal(single.notes.length, 6);
  for (const n of single.notes) assert.equal(n.h, n.m >= 60 ? 'R' : 'L');
  const vocalToo = scoreToArrangement(score, { vocalKey: 'P1|s1|v1', playKeys: ['P1|s1|v1'] });
  assert.deepEqual(vocalToo.notes.map((n) => n.h), vocalToo.notes.map((n) => (n.m >= 60 ? 'R' : 'L')));
  assert.deepEqual(vocalToo.notes.map((n) => n.t), vocalToo.vocal.map((n) => n.t));

  const fast = scoreToArrangement(score, { ...OMR_KEYS, bpm: 120 });
  assert.equal(fast.bpm, 120);
  assert.deepEqual(at(fast.notes, 4), [43, 62, 67, 71]);
  assert.ok(!fast.warnings.some((w) => w.includes('빠르기 표시가 없어')));

  const noVocal = scoreToArrangement(score, { playKeys: OMR_KEYS.playKeys });
  assert.deepEqual(noVocal.vocal, []);
  assert.equal(noVocal.lyricText, '');
  assert.equal(noVocal.stats.vocal, 0);
  assert.ok(noVocal.warnings.some((w) => w.includes('노래 멜로디 성부를 고르지 않아')));
  // without the vocal part the two piano parts tie on measure 2 → the longer length is kept, still aligned
  assert.deepEqual(at(noVocal.notes, 9 * 0.6), [43, 62, 67, 71]);
  assert.ok(noVocal.warnings.some((w) => w.includes('(2번째 마디)')), noVocal.warnings.join(' / '));
});

test('scoreToArrangement: a part that only ends early (closing partial measure) needs no alignment warning', () => {
  const xml = partwise([
    { id: 'P1', name: 'Voice', measures: [M(attrs() + tempo(60) + N('E4', 4)), M(N('C4', 2))] },
    { id: 'P2', name: 'Piano', measures: [M(attrs() + CH(['G4', 'C5'], 4)), M(CH(['E4', 'C5'], 4))] },
    { id: 'P3', name: 'Piano', measures: [M(attrs() + N('C3', 4)), M(N('C3', 4))] },
  ]);
  const res = scoreToArrangement(parseMusicXml(xml), OMR_KEYS);
  assert.deepEqual(res.vocal.map((n) => [n.t, n.d]), [[0, 4], [4, 2]]);
  assert.deepEqual(at(res.notes, 4), [48, 64, 72]);
  assert.deepEqual(res.warnings, ['악보에 가사가 없어요.']);
});

test('scoreToArrangement: first and last measures follow the longest part (the short parts are the incomplete ones)', () => {
  const KEYS = OMR_KEYS;
  const notesOf = (res, h) => res.notes.filter((n) => !h || n.h === h).map((n) => [n.t, n.d, n.m]);
  // 60 BPM: one quarter = 1 s. (A) The sung pickup is two quarters; both piano parts wrote only their one-beat entry.
  const xmlA = partwise([
    { id: 'P1', name: 'Voice', measures: [M(attrs() + tempo(60) + N('E4', 1) + N('G4', 1)), M(N('C5', 4))] },
    { id: 'P2', name: 'Piano', measures: [M(attrs() + CH(['B3', 'D4', 'G4'], 1)), M(CH(['E4', 'G4', 'C5'], 4))] },
    { id: 'P3', name: 'Piano', measures: [M(attrs() + N('G2', 1)), M(N('C3', 4))] },
  ]);
  const a = scoreToArrangement(parseMusicXml(xmlA), KEYS);
  assert.deepEqual(a.vocal.map((n) => [n.t, n.d, n.m]), [[2, 1, 64], [3, 1, 67], [4, 4, 72]]);
  assert.deepEqual(a.vocal.map((n) => n.t), scoreToSong(parseMusicXml(xmlA), { trackKey: 'P1|s1|v1' }).notes.map((n) => n.t),
    'the sung line keeps the times it has on its own');
  assert.deepEqual(at(a.notes, 3), [43, 59, 62, 67], 'the piano entry is on the last beat of the pickup');
  assert.deepEqual(at(a.notes, 4), [48, 64, 67, 72]);

  // (B) The right hand wrote a full-bar pickup (rests, then a chord on beat 4); the vocal and the bass only their entry.
  const xmlB = partwise([
    { id: 'P1', name: 'Voice', measures: [M(attrs() + tempo(60) + N('G4', 1)), M(N('C5', 4))] },
    { id: 'P2', name: 'Piano', measures: [M(attrs() + R(3) + CH(['B3', 'D4', 'G4'], 1)), M(CH(['E4', 'G4', 'C5'], 4))] },
    { id: 'P3', name: 'Piano', measures: [M(attrs() + N('G2', 1)), M(N('C3', 4))] },
  ]);
  const b = scoreToArrangement(parseMusicXml(xmlB), KEYS);
  assert.deepEqual(b.vocal.map((n) => [n.t, n.d, n.m]), [[3, 1, 67], [4, 4, 72]]);
  assert.deepEqual(notesOf(b).filter((x) => x[0] < 4), [[3, 1, 43], [3, 1, 59], [3, 1, 62], [3, 1, 67]],
    'the full-bar chord keeps its beat and length');

  // (C) Last measure: the sung line and the bass stop after two beats (trailing rests not recognised), the right hand
  // plays chords on beats 1 and 3.
  const xmlC = partwise([
    { id: 'P1', name: 'Voice', measures: [M(attrs() + tempo(60) + N('E4', 4)), M(N('C4', 2))] },
    { id: 'P2', name: 'Piano', measures: [M(attrs() + CH(['G4', 'C5'], 4)), M(CH(['E4', 'G4'], 2) + CH(['E4', 'C5'], 2))] },
    { id: 'P3', name: 'Piano', measures: [M(attrs() + N('C3', 4)), M(N('C3', 2))] },
  ]);
  const c = scoreToArrangement(parseMusicXml(xmlC), KEYS);
  assert.deepEqual(notesOf(c, 'R').filter((x) => x[0] >= 4), [[4, 2, 64], [4, 2, 67], [6, 2, 64], [6, 2, 72]]);
  assert.deepEqual(c.warnings, ['악보에 가사가 없어요.']);

  // An over-full first measure (a misread duration) is still squeezed into the time signature's length.
  const xmlD = partwise([
    { id: 'P1', name: 'Voice', measures: [M(attrs() + tempo(60) + N('C4', 4)), M(N('E4', 4))] },
    { id: 'P2', name: 'Piano', measures: [M(attrs() + CH(['E4', 'G4'], 2) + CH(['F4', 'A4'], 3)), M(CH(['G4', 'C5'], 4))] },
    { id: 'P3', name: 'Piano', measures: [M(attrs() + N('C3', 4)), M(N('C3', 4))] },
  ]);
  const d = scoreToArrangement(parseMusicXml(xmlD), KEYS);
  assert.deepEqual(at(d.notes, 1.6), [65, 69]);
  assert.deepEqual(at(d.notes, 4), [48, 67, 72]);
  assert.deepEqual(d.vocal.map((n) => n.t), [0, 4]);
  assert.ok(d.warnings.some((w) => w.includes('(1번째 마디)')), d.warnings.join(' / '));
});

test('scoreToArrangement: a part that missed a time signature change keeps its notes when they fit', () => {
  // 60 BPM. Measure 2 is a 2/4 bar; the OMR missed the change in the left-hand part only (still 4/4 there, but its
  // content is the 2 beats of the bar).
  const ts24 = '<attributes><time><beats>2</beats><beat-type>4</beat-type></time></attributes>';
  const ts44 = '<attributes><time><beats>4</beats><beat-type>4</beat-type></time></attributes>';
  const xml = partwise([
    { id: 'P1', name: 'Voice', measures: [M(attrs() + tempo(60) + N('C4', 4)), M(ts24 + N('D4', 2)), M(ts44 + N('E4', 4))] },
    { id: 'P2', name: 'Piano', measures: [M(attrs() + CH(['E4', 'G4'], 4)), M(ts24 + CH(['F4', 'A4'], 2)), M(ts44 + CH(['G4', 'C5'], 4))] },
    { id: 'P3', name: 'Piano', measures: [M(attrs() + N('C3', 4)), M(N('D3', 1) + N('A2', 1)), M(N('C3', 4))] },
  ]);
  const res = scoreToArrangement(parseMusicXml(xml), OMR_KEYS);
  assert.deepEqual(res.notes.filter((n) => n.h === 'L').map((n) => [n.t, n.d, n.m]), [[0, 4, 48], [4, 1, 50], [5, 1, 45], [6, 4, 48]]);
  assert.deepEqual(at(res.notes, 6), [48, 67, 72]);
  assert.deepEqual(res.vocal.map((n) => n.t), [0, 4, 6]);
  assert.ok(!res.warnings.some((w) => w.includes('맞춰 정렬한 마디')), res.warnings.join(' / '));
});

test('scoreToArrangement: errors', () => {
  const score = parseMusicXml(omrScore());
  assert.throws(() => scoreToArrangement(score, { vocalKey: 'P1|s1|v1' }), { message: '연주할 성부를 하나 이상 골라 주세요.' });
  assert.throws(() => scoreToArrangement(score, { playKeys: [] }), { message: '연주할 성부를 하나 이상 골라 주세요.' });
  assert.throws(() => scoreToArrangement(score, { playKeys: ['P9|s1|v1'] }), { message: '선택한 성부를 찾을 수 없어요.' });
  assert.throws(() => scoreToArrangement(score, { vocalKey: 'P9|s1|v1', playKeys: ['P2|s1|v1'] }),
    { message: '선택한 성부를 찾을 수 없어요.' });
  assert.throws(() => scoreToArrangement({}, OMR_KEYS), { message: '악보 정보가 올바르지 않아요.' });
  assert.throws(() => scoreToArrangement(null), { message: '악보 정보가 올바르지 않아요.' });
});

// ---------------------------------------------------------------- recommendArrangement

test('recommendArrangement: OMR 3-part score with or without lyrics', () => {
  const expected = {
    vocalKey: 'P1|s1|v1', playKeys: ['P2|s1|v1', 'P3|s1|v1'], hands: { 'P2|s1|v1': 'R', 'P3|s1|v1': 'L' },
  };
  assert.deepEqual(recommendArrangement(parseMusicXml(omrScore())), expected);
  assert.deepEqual(recommendArrangement(parseMusicXml(omrScore({ lyrics: false }))), expected);
});

test('recommendArrangement without lyrics: the singable one-note line, not the higher busy chord part', () => {
  const run = (k, fn) => {
    const out = [];
    for (let j = 0; j < k; j++) out.push(fn(j));
    return out;
  };
  const mel = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'G4', 'E4'];
  const xml = partwise([
    { id: 'P1', name: '', measures: [M(attrs() + mel.slice(0, 4).map((p) => N(p, 1)).join('')), M(mel.slice(4).map((p) => N(p, 1)).join(''))] },
    { id: 'P2', name: '', measures: run(2, (j) => M((j ? '' : attrs()) + run(4, () => CH(['E5', 'G5', 'C6'], 1)).join(''))) },
    { id: 'P3', name: '', measures: run(2, (j) => M((j ? '' : attrs()) + ['C3', 'G2', 'C3', 'G2'].map((p) => N(p, 1)).join(''))) },
  ]);
  const score = parseMusicXml(xml);
  assert.equal(recommendTrack(score), 'P2|s1|v1'); // the plain melody heuristic picks the top line
  assert.deepEqual(recommendArrangement(score), {
    vocalKey: 'P1|s1|v1', playKeys: ['P2|s1|v1', 'P3|s1|v1'], hands: { 'P2|s1|v1': 'R', 'P3|s1|v1': 'L' },
  });

  // a part named like a voice wins when that singles it out
  const named = parseMusicXml(partwise([
    { id: 'P1', name: 'Flute', measures: [M(attrs() + ['C6', 'D6', 'E6', 'F6'].map((p) => N(p, 1)).join(''))] },
    { id: 'P2', name: 'Voice', measures: [M(attrs() + ['C4', 'D4', 'E4', 'F4'].map((p) => N(p, 1)).join(''))] },
    { id: 'P3', name: 'Piano', measures: [M(attrs() + N('C3', 4))] },
  ]));
  assert.equal(recommendArrangement(named).vocalKey, 'P2|s1|v1');
});

test('recommendArrangement: solo piano grand staff → melody staff times the lyrics and is played too', () => {
  const melody = ['E5', 'D5', 'C5', 'D5', 'E5', 'E5', 'E5', 'D5'];
  const xml = partwise([{ id: 'P1', name: 'Piano', measures: [
    M(attrs({ staves: 2 }) + melody.slice(0, 4).map((p) => N(p, 1, { staff: 1 })).join('')
      + backup(4) + N('C3', 4, { staff: 2, voice: 5 })),
    M(melody.slice(4).map((p) => N(p, 1, { staff: 1 })).join('') + backup(4) + N('G2', 4, { staff: 2, voice: 5 })),
  ] }]);
  const score = parseMusicXml(xml);
  const rec = recommendArrangement(score);
  assert.deepEqual(rec, {
    vocalKey: 'P1|s1|v1', playKeys: ['P1|s1|v1', 'P1|s2|v5'], hands: { 'P1|s1|v1': 'R', 'P1|s2|v5': 'L' },
  });
  const res = scoreToArrangement(score, rec);
  assert.equal(res.stats.right, 8);
  assert.equal(res.stats.left, 2);
  assert.equal(res.vocal.length, 8);
  assert.deepEqual(res.warnings.filter((w) => w.includes('마디')), []);
});

test('recommendArrangement: lyrics on a chord staff (piano + words) keep that staff played; merged keys skipped', () => {
  const xml = partwise([
    { id: 'P1', name: 'Piano', measures: [
      M(attrs({ staves: 2 }) + CH(['C4', 'E4', 'G4'], 2, { staff: 1, lyric: '하' }) + CH(['D4', 'F4', 'A4'], 2, { staff: 1, lyric: '나' })
        + backup(4) + N('C3', 4, { staff: 2, voice: 5 })),
    ] },
  ]);
  const rec = recommendArrangement(parseMusicXml(xml));
  assert.equal(rec.vocalKey, 'P1|s1|v1');
  assert.deepEqual(rec.playKeys, ['P1|s1|v1', 'P1|s2|v5']);

  // a vocal part plus a one-staff piano part with two voices: the merged key is not listed
  const twoVoices = parseMusicXml(partwise([
    { id: 'P1', name: 'Voice', measures: [M(attrs() + N('E4', 2, { lyric: 'la' }) + N('G4', 2, { lyric: 'la' }))] },
    { id: 'P2', name: 'Piano', measures: [M(attrs() + N('C5', 4, { voice: 1 }) + backup(4) + N('C4', 4, { voice: 2 }))] },
  ]));
  assert.deepEqual(twoVoices.parts[1].tracks.map((t) => t.key), ['P2|s1|v1', 'P2|s1|v2', 'P2|s1|*']);
  assert.deepEqual(recommendArrangement(twoVoices), { vocalKey: 'P1|s1|v1', playKeys: ['P2|s1|v1', 'P2|s1|v2'], hands: {} });
});

test('recommendArrangement: one part with a sung staff above a piano grand staff (3 staves) → the sung staff is not played', () => {
  const build = (lyrics) => partwise([{ id: 'P1', name: 'Piano', measures: [0, 1, 2, 3].map((i) => M((i ? '' : attrs({ staves: 3 }))
    + ['E4', 'D4', 'C4', 'D4'].map((p) => N(p, 1, { staff: 1, voice: 1, lyric: lyrics ? 'la' : undefined })).join('') + backup(4)
    + CH(['E4', 'G4', 'C5'], 2, { staff: 2, voice: 5 }) + CH(['F4', 'A4', 'C5'], 2, { staff: 2, voice: 5 }) + backup(4)
    + N('C3', 2, { staff: 3, voice: 9 }) + N('F3', 2, { staff: 3, voice: 9 }))) }]);
  const expected = { vocalKey: 'P1|s1|v1', playKeys: ['P1|s2|v5', 'P1|s3|v9'], hands: { 'P1|s2|v5': 'R', 'P1|s3|v9': 'L' } };
  for (const lyrics of [true, false]) {
    const score = parseMusicXml(build(lyrics));
    assert.equal(score.parts[0].staves, 3);
    const rec = recommendArrangement(score);
    assert.deepEqual(rec, expected, `lyrics: ${lyrics}`);
    const res = scoreToArrangement(score, rec);
    assert.deepEqual(at(res.notes.filter((n) => n.h === 'R'), 0), [64, 67, 72], 'the chords are the right hand');
    assert.deepEqual(at(res.notes.filter((n) => n.h === 'L'), 0), [48]);
    assert.ok(!res.notes.some((n) => n.m === 62), 'the sung D4 is not played');
    assert.equal(res.vocal.length, 16);
  }
});

test('recommendArrangement without lyrics: a part that is one line on its own beats a higher right-hand line', () => {
  const sung = [['E4', 'D4', 'C4', 'D4'], ['E4', 'E4', 'E4', 'R'], ['D4', 'D4', 'D4', 'R'], ['E4', 'G4', 'G4', 'R']];
  const sungPart = { id: 'P1', name: 'MusicXML Part', measures: sung.map((ps, i) => M((i ? '' : attrs()) + ps.map((p) => N(p, 1)).join(''))) };
  const bassPart = (id) => ({ id, name: 'MusicXML Part', measures: [0, 1, 2, 3].map((i) => M((i ? '' : attrs()) + N('C3', 2) + N('F2', 2))) });
  // (a) right hand as broken-chord eighths (single notes, one voice), higher on average than the sung line
  const broken = ['C4', 'G4', 'E5', 'G4', 'F4', 'A4', 'F5', 'A4'];
  const a = parseMusicXml(partwise([
    sungPart,
    { id: 'P2', name: 'MusicXML Part', measures: [0, 1, 2, 3].map((i) => M((i ? '' : attrs({ div: 2 })) + broken.map((p) => N(p, 1)).join(''))) },
    bassPart('P3'),
  ]));
  const trackOf = (score, key) => score.parts.flatMap((p) => p.tracks).find((t) => t.key === key);
  assert.ok(trackOf(a, 'P2|s1|v1').avgPitch > trackOf(a, 'P1|s1|v1').avgPitch);
  assert.deepEqual(recommendArrangement(a), {
    vocalKey: 'P1|s1|v1', playKeys: ['P2|s1|v1', 'P3|s1|v1'], hands: { 'P2|s1|v1': 'R', 'P3|s1|v1': 'L' },
  });

  // (b) the OMR split the right hand into a top line (voice 1) and inner dyads (voice 2)
  const rhVoices = { id: 'P2', name: 'MusicXML Part', measures: [0, 1, 2, 3].map((i) => M((i ? '' : attrs())
    + ['C5', 'D5', 'E5', 'G5'].map((p) => N(p, 1, { voice: 1 })).join('') + backup(4)
    + CH(['E4', 'G4'], 2, { voice: 2 }) + CH(['F4', 'A4'], 2, { voice: 2 }))) };
  const b = parseMusicXml(partwise([sungPart, rhVoices, bassPart('P3')]));
  assert.deepEqual(recommendArrangement(b), {
    vocalKey: 'P1|s1|v1',
    playKeys: ['P2|s1|v1', 'P2|s1|v2', 'P3|s1|v1'],
    hands: { 'P2|s1|v1': 'R', 'P2|s1|v2': 'R', 'P3|s1|v1': 'L' },
  });

  // (c) a sung part and a grand-staff piano whose right hand has two voices, generic names
  const piano = { id: 'P2', name: 'MusicXML Part', measures: [0, 1, 2, 3].map((i) => M((i ? '' : attrs({ staves: 2 }))
    + ['C5', 'D5', 'E5', 'G5'].map((p) => N(p, 1, { staff: 1, voice: 1 })).join('') + backup(4)
    + CH(['E4', 'G4'], 2, { staff: 1, voice: 2 }) + CH(['F4', 'A4'], 2, { staff: 1, voice: 2 }) + backup(4)
    + N('C3', 2, { staff: 2, voice: 5 }) + N('G2', 2, { staff: 2, voice: 5 }))) };
  const c = parseMusicXml(partwise([sungPart, piano]));
  const rc = recommendArrangement(c);
  assert.equal(rc.vocalKey, 'P1|s1|v1');
  assert.deepEqual(rc.playKeys, ['P2|s1|v1', 'P2|s1|v2', 'P2|s2|v5']);
  const res = scoreToArrangement(c, rc);
  assert.deepEqual(res.vocal.slice(0, 4).map((n) => n.m), [64, 62, 60, 62]);
  assert.deepEqual(at(res.notes.filter((n) => n.h === 'R'), 0), [64, 67, 72]);
});

test('recommendArrangement: one track, or nothing to play', () => {
  const one = parseMusicXml(partwise([M(attrs() + N('C4', 2, { lyric: 'la' }) + N('E4', 2, { lyric: 'la' }))]));
  assert.deepEqual(recommendArrangement(one), { vocalKey: 'P1|s1|v1', playKeys: ['P1|s1|v1'], hands: {} });
  const plain = parseMusicXml(partwise([M(attrs() + N('C4', 2) + N('E4', 2))]));
  assert.deepEqual(recommendArrangement(plain), { vocalKey: null, playKeys: ['P1|s1|v1'], hands: {} });
  const empty = { vocalKey: null, playKeys: [], hands: {} };
  assert.deepEqual(recommendArrangement(parseMusicXml(partwise([M(attrs() + R(4))]))), empty);
  assert.deepEqual(recommendArrangement(null), empty);
  assert.deepEqual(recommendArrangement({ parts: [] }), empty);
});

test('parts with the same name (OMR: every part "Piano") get their position in the label', () => {
  const xml = partwise([
    { id: 'P1', name: 'Piano', measures: [M(attrs() + N('E4', 1) + N('D4', 1) + N('C4', 2))] },
    { id: 'P2', name: 'Piano', measures: [M(attrs() + N('C4', 4) + N('E4', 4, { chord: true }) + N('G4', 4, { chord: true }))] },
    { id: 'P3', name: 'Strings', measures: [M(attrs() + N('C3', 4))] },
  ]);
  const score = parseMusicXml(xml);
  assert.deepEqual(score.parts.map((p) => p.name), ['피아노 (파트 1)', '피아노 (파트 2)', 'Strings']);
  assert.equal(score.parts[1].tracks[0].label, '피아노 (파트 2) · 1단 · 성부 1');
  // The melody view counts the top line; allNotes / allMin / allMax count every chord tone.
  const chords = score.parts[1].tracks[0];
  assert.deepEqual([chords.noteCount, chords.min, chords.max], [1, 67, 67]);
  assert.deepEqual([chords.allNotes, chords.allMin, chords.allMax], [3, 60, 67]);
});
