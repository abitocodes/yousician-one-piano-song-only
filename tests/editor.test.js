import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importScreen } from './helpers-screen-stubs.js';
import { parseNotation, notesToNotation } from '../js/core/notation.js';

const ed = await importScreen('../js/screens/editor.js');

test('recordedEventsToNotes: latency/start compensation, durations, last note = 1 beat', () => {
  const start = 10;
  const latency = 0.1;
  const events = [
    { time: 10.1, midi: 60, strength: 0.8 },
    { time: 10.6, midi: 62, strength: 0.7 },
    { time: 11.1, midi: 64, strength: 0.9 },
  ];
  const notes = ed.recordedEventsToNotes(events, { start, latency, bpm: 120 });
  assert.deepEqual(notes.map((n) => n.m), [60, 62, 64]);
  assert.deepEqual(notes.map((n) => n.t), [0, 0.5, 1]);
  assert.deepEqual(notes.map((n) => n.d), [0.5, 0.5, 0.5]); // last = 60/120
  for (const n of notes) assert.ok(n.v > 0 && n.v <= 1);
});

test('recordedEventsToNotes: same onset within 30 ms keeps the strongest event', () => {
  const notes = ed.recordedEventsToNotes([
    { time: 1.0, midi: 60, strength: 0.3 },
    { time: 1.02, midi: 67, strength: 0.9 },
    { time: 1.025, midi: 64, strength: 0.5 },
    { time: 2.0, midi: 62, strength: 0.5 },
  ], { start: 0, latency: 0, bpm: 100 });
  assert.equal(notes.length, 2);
  assert.equal(notes[0].m, 67);
  assert.equal(notes[0].t, 1);
  assert.equal(notes[1].m, 62);
});

test('recordedEventsToNotes: caps gaps at 2 s, drops early / invalid events, sorts', () => {
  const notes = ed.recordedEventsToNotes([
    { time: 9, midi: 64, strength: 1 },
    { time: 0.5, midi: 60, strength: 1 },
    { time: -1, midi: 61, strength: 1 }, // before count-in end
    { time: 3, midi: 130, strength: 1 }, // out of piano range
    { time: NaN, midi: 60 },
    null,
    { time: -0.1, midi: 59.6, strength: 0.4 }, // slightly early → clamped to 0, midi rounded
  ], { start: 0, latency: 0, bpm: 60 });
  assert.deepEqual(notes.map((n) => n.m), [60, 60, 64]);
  assert.equal(notes[0].t, 0);
  assert.equal(notes[0].d, 0.5);
  assert.equal(notes[1].t, 0.5);
  assert.equal(notes[1].d, 2);
  assert.equal(notes[2].d, 1);
  assert.deepEqual(ed.recordedEventsToNotes([], {}), []);
});

test('gridStart / appendStartTime', () => {
  assert.equal(ed.gridStart(0, 120, 4), 0);
  assert.equal(ed.gridStart(0.5, 120, 4), 0.5);
  assert.equal(ed.gridStart(-1, 120, 4), 1); // bar = 2 s → first bar line ≥ 0
  assert.equal(ed.gridStart(-4, 120, 4), 0);
  assert.equal(ed.gridStart(NaN, 120, 4), 0);

  const notes = [{ t: 0, d: 1, m: 60 }, { t: 2.5, d: 0.6, m: 62 }];
  assert.equal(ed.appendStartTime(notes, { bpm: 120, beatsPerBar: 4, offset: 0 }), 4);
  assert.equal(ed.appendStartTime(notes, { bpm: 120, beatsPerBar: 3, offset: 0 }), 4.5);
  assert.equal(ed.appendStartTime([{ t: 0, d: 2, m: 60 }], { bpm: 120, beatsPerBar: 4, offset: 0 }), 2);
  assert.equal(ed.appendStartTime(notes, { bpm: 120, beatsPerBar: 4, offset: 0.25 }), 4.25);
  assert.equal(ed.appendStartTime([], { bpm: 120, beatsPerBar: 4, offset: 0.5 }), 0.5);
});

test('appended notation continues on the next bar', () => {
  const opts = { bpm: 120, beatsPerBar: 4, offset: 0 };
  const first = parseNotation('C4 D4 E4', { bpm: 120, offset: ed.gridStart(0, 120, 4) }).notes;
  const base = ed.appendStartTime(first, opts);
  const more = parseNotation('F4 G4', { bpm: 120, offset: base }).notes;
  assert.equal(base, 2);
  assert.deepEqual(more.map((n) => n.t), [2, 2.5]);
  const text = notesToNotation([...first, ...more], opts);
  const again = parseNotation(text, { bpm: 120, offset: 0 }).notes;
  assert.deepEqual(again.map((n) => [n.t, n.m]), [...first, ...more].map((n) => [n.t, n.m]));
});

test('recommendMelodyTrack', () => {
  const tracks = [
    { index: 0, name: 'Piano LH', count: 300, min: 36, max: 60, isDrum: false },
    { index: 1, name: 'Strings', count: 120, min: 55, max: 79, isDrum: false },
    { index: 2, name: 'Drums', count: 500, min: 35, max: 81, isDrum: true },
    { index: 3, name: 'Bell', count: 4, min: 84, max: 96, isDrum: false },
  ];
  assert.equal(ed.recommendMelodyTrack(tracks), 1);
  assert.equal(ed.recommendMelodyTrack([...tracks, { index: 4, name: '멜로디', count: 90, min: 50, max: 70 }]), 4);
  assert.equal(ed.recommendMelodyTrack([{ index: 0, name: 'Vocal Lead', count: 10, min: 60, max: 72 }, tracks[1]]), 0);
  assert.equal(ed.recommendMelodyTrack([tracks[2]]), 2);
  assert.equal(ed.recommendMelodyTrack([]), -1);
});

test('validateBasics', () => {
  assert.deepEqual(ed.validateBasics({ title: '감사', bpm: 80, beatsPerBar: 4, offset: 0 }), {});
  const e = ed.validateBasics({ title: '  ', bpm: 20, beatsPerBar: 0, offset: NaN });
  assert.ok(e.title && e.bpm && e.beatsPerBar && e.offset);
  assert.ok(ed.validateBasics({ title: 'x', bpm: 301, beatsPerBar: 4, offset: 0 }).bpm);
  assert.equal(ed.validateBasics({ title: 'x', bpm: 300, beatsPerBar: 4, offset: -2 }).bpm, undefined);
});

test('looksLikeLrc', () => {
  assert.equal(ed.looksLikeLrc('[00:01.00]하나\n[00:02.50]둘'), true);
  assert.equal(ed.looksLikeLrc('[ti:제목]\n[00:01.00]하나'), false);
  assert.equal(ed.looksLikeLrc('[1절]\n반짝 반짝\n[후렴]'), false);
  assert.equal(ed.looksLikeLrc(''), false);
});

test('scaleTempo stretches notes, offset and LRC lyrics', () => {
  const song = {
    bpm: 100,
    offset: 0.5,
    notes: [{ t: 1, d: 0.5, m: 60 }, { t: 2, d: 1, m: 62 }],
    lyrics: { text: '가 나', source: 'lrc', lines: [{ syllables: [{ text: '가 ', t: 1, d: 0.5 }, { text: '나', t: 2, d: 1 }] }] },
  };
  const r = ed.scaleTempo(song, 50);
  assert.equal(r.bpm, 50);
  assert.equal(r.offset, 1);
  assert.deepEqual(r.notes.map((n) => [n.t, n.d]), [[2, 1], [4, 2]]);
  assert.deepEqual(r.lyrics.lines[0].syllables.map((y) => [y.t, y.d]), [[2, 1], [4, 2]]);
  assert.equal(song.notes[0].t, 1, 'input not mutated');

  const notesLyrics = { ...song, lyrics: { text: '가', source: 'notes', lines: [] } };
  assert.equal(ed.scaleTempo(notesLyrics, 200).lyrics, notesLyrics.lyrics);
});

test('trimLeadingSilence shifts notes, beat grid, audio and LRC lyrics together', () => {
  const song = {
    offset: 0,
    notes: [{ t: 3, d: 1, m: 60 }, { t: 4, d: 1, m: 62 }],
    audio: { name: 'mr.mp3', offset: -1, volume: 0.8 },
    lyrics: { text: '가', source: 'lrc', lines: [{ syllables: [{ text: '가', t: 3.2, d: 0.5 }] }] },
  };
  const r = ed.trimLeadingSilence(song);
  assert.equal(r.shift, -3);
  assert.deepEqual(r.notes.map((n) => n.t), [0, 1]);
  assert.equal(r.offset, -3);
  assert.equal(r.audio.offset, -4);
  assert.equal(r.audio.name, 'mr.mp3');
  assert.equal(r.lyrics.lines[0].syllables[0].t, 0.2);
  assert.equal(song.notes[0].t, 3, 'input not mutated');

  assert.equal(ed.trimLeadingSilence({ ...song, notes: [{ t: 0, d: 1, m: 60 }] }), null);
  assert.equal(ed.trimLeadingSilence({ ...song, notes: [] }), null);
  const noAudio = ed.trimLeadingSilence({ offset: 0, notes: [{ t: 1, d: 1, m: 60 }], audio: null, lyrics: { text: '', source: 'notes', lines: [] } });
  assert.equal(noAudio.audio, null);
});

const bytesOf = (...parts) => {
  const out = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const ch of p) out.push(ch.charCodeAt(0) & 0xff);
    else out.push(...p);
  }
  return new Uint8Array(out);
};

test('detectScoreFileKind: magic bytes win over the file name', () => {
  const kind = ed.detectScoreFileKind;
  assert.equal(kind(bytesOf('MThd', [0, 0, 0, 6, 0, 1, 0, 2, 1, 224]), 'a.mid'), 'midi');
  assert.equal(kind(bytesOf('MThd', [0, 0, 0, 6]), 'song.xml'), 'midi');
  assert.equal(kind(bytesOf('RIFF', [0, 0, 0, 0], 'RMID', 'data'), 'x.rmi'), 'midi');
  assert.equal(kind(bytesOf('RIFF', [0, 0, 0, 0], 'WAVE', 'fmt '), 'x.mid'), null);
  assert.equal(kind(bytesOf('PK', [3, 4, 20, 0]), 'score.mxl'), 'musicxml');
  assert.equal(kind(bytesOf('PK', [3, 4, 20, 0]), 'download'), 'musicxml');
  assert.equal(kind(bytesOf('<?xml version="1.0"?><score-partwise/>'), 'a.musicxml'), 'musicxml');
  assert.equal(kind(bytesOf([0xef, 0xbb, 0xbf], '\r\n  <score-partwise>'), 'a.txt'), 'musicxml');
  assert.equal(kind(bytesOf([0xff, 0xfe], '<', [0], '?', [0]), ''), 'musicxml'); // UTF-16LE + BOM
  assert.equal(kind(bytesOf([0xfe, 0xff, 0], '<', [0], '?'), ''), 'musicxml'); // UTF-16BE + BOM
  assert.equal(kind(new Uint8Array([0x3c, 0x73]).buffer, 'noext'), 'musicxml'); // ArrayBuffer input
  assert.equal(kind(bytesOf('%PDF-1.7\n'), 'sheet.pdf'), 'pdf');
  assert.equal(kind(bytesOf([0x89], 'PNG\r\n'), 'photo.png'), 'image');
  assert.equal(kind(bytesOf([0xff, 0xd8, 0xff, 0xe0]), 'photo'), 'image');
  assert.equal(kind(bytesOf('{"format":"piano-karaoke-song"}'), 'song.json'), 'json');
  assert.equal(kind(bytesOf('[{"title":"x"}]'), 'songs.json'), 'json');
  assert.equal(kind(bytesOf('[00:01.00]la la'), 'lyrics.lrc'), null);
});

test('detectScoreFileKind: falls back to the extension, else null', () => {
  const kind = ed.detectScoreFileKind;
  assert.equal(kind(bytesOf('garbage'), 'Song.MID'), 'midi');
  assert.equal(kind(bytesOf('garbage'), 'tune.midi'), 'midi');
  assert.equal(kind(new Uint8Array(0), 'empty.MusicXML'), 'musicxml');
  assert.equal(kind(bytesOf('garbage'), 'x.mxl'), 'musicxml');
  assert.equal(kind(bytesOf('garbage'), 'scan.PDF'), 'pdf');
  assert.equal(kind(bytesOf('garbage'), 'scan.heic'), 'image');
  assert.equal(kind(bytesOf('garbage'), 'notes.txt'), null);
  assert.equal(kind(null, ''), null);
});

test('step entry: note value → beats (dot ×1.5, triplet ×2/3) and ticks stay integral', () => {
  assert.deepEqual(ed.STEP_VALUES.map((v) => v.value), [4, 2, 1, 0.5, 0.25]);
  assert.equal(ed.stepValueBeats(1), 1);
  assert.equal(ed.stepValueBeats(0.5, { dotted: true }), 0.75);
  assert.equal(ed.stepValueBeats(2, { dotted: true }), 3);
  assert.equal(ed.stepValueBeats(1, { triplet: true }), 2 / 3);
  assert.equal(ed.stepValueBeats(0.5, { triplet: true }), 1 / 3);
  assert.equal(ed.stepValueBeats(1, { dotted: true, triplet: true }), 1);
  assert.equal(ed.stepValueBeats(0), 0);
  for (const v of ed.STEP_VALUES) {
    for (const dotted of [false, true]) {
      for (const triplet of [false, true]) {
        const ticks = ed.stepTicks(v.value, { dotted, triplet });
        assert.ok(Number.isInteger(ticks) && ticks > 0, `${v.value} ${dotted} ${triplet}`);
      }
    }
  }
  // three triplet eighths fill exactly one beat
  assert.equal(3 * ed.stepTicks(0.5, { triplet: true }), ed.STEP_TPB);
});

test('formatStepBeats uses notation-compatible numbers', () => {
  assert.equal(ed.formatStepBeats(2), '2');
  assert.equal(ed.formatStepBeats(1.5), '1.5');
  assert.equal(ed.formatStepBeats(0.5), '0.5');
  assert.equal(ed.formatStepBeats(0.25), '1/4');
  assert.equal(ed.formatStepBeats(0.75), '3/4');
  assert.equal(ed.formatStepBeats(2 / 3), '2/3');
  assert.equal(ed.formatStepBeats(1 / 3), '1/3');
  assert.equal(ed.formatStepBeats(4 / 3), '4/3');
  assert.equal(ed.formatStepBeats(0.375), '3/8');
});

test('stepCursor: bar / beat readout', () => {
  assert.deepEqual(ed.stepCursor(0, 4), { bar: 1, beat: 1, text: '마디 1 · 박 1' });
  assert.equal(ed.stepCursor(1.5, 4).text, '마디 1 · 박 2.5');
  assert.equal(ed.stepCursor(4, 4).text, '마디 2 · 박 1');
  assert.equal(ed.stepCursor(7, 3).text, '마디 3 · 박 2');
  assert.equal(ed.stepCursor(4 + 1 / 3, 4).text, '마디 2 · 박 1.33');
  // floating-point sums of triplets still land on the bar line
  assert.equal(ed.stepCursor((2 / 3) * 6 - 1e-12, 4).text, '마디 2 · 박 1');
  assert.equal(ed.stepCursor(-1, 4).text, '마디 1 · 박 1');
});

test('step entry: notes timed from bpm/origin, rests advance the cursor, ties extend the previous note', () => {
  const q = ed.stepTicks(1);
  const e8 = ed.stepTicks(0.5);
  const entries = [
    { kind: 'note', m: 60, ticks: q },
    { kind: 'note', m: 62, ticks: e8 },
    { kind: 'tie', ticks: e8 }, // 레 = 1박
    { kind: 'rest', ticks: q },
    { kind: 'note', m: 64, ticks: ed.stepTicks(1, { dotted: true }) },
  ];
  const notes = ed.stepEntriesToNotes(entries, { bpm: 120, origin: 0.5 });
  assert.deepEqual(notes.map((n) => [n.t, n.d, n.m]), [[0.5, 0.5, 60], [1, 0.5, 62], [2, 0.75, 64]]);
  assert.equal(ed.stepTotalTicks(entries), 4.5 * ed.STEP_TPB);
  assert.equal(ed.stepNoteCount(entries), 3);
  // startTick shifts everything (continue after existing notes)
  const later = ed.stepEntriesToNotes(entries.slice(0, 1), { bpm: 60, origin: 0, startTick: 2 * ed.STEP_TPB });
  assert.deepEqual(later.map((n) => [n.t, n.d]), [[2, 1]]);
  // triplets
  const trip = ed.stepTicks(0.5, { triplet: true });
  const t3 = ed.stepEntriesToNotes([60, 62, 64].map((m) => ({ kind: 'note', m, ticks: trip })), { bpm: 60, origin: 0 });
  assert.deepEqual(t3.map((n) => n.t), [0, 0.333, 0.667]);
  assert.deepEqual(ed.stepEntriesToNotes([], { bpm: 100 }), []);
});

test('step entry: tie only after a note; backspace restores the cursor', () => {
  const q = ed.stepTicks(1);
  const entries = [];
  assert.equal(ed.stepCanTie(entries), false);
  entries.push({ kind: 'note', m: 67, ticks: q });
  assert.equal(ed.stepCanTie(entries), true);
  entries.push({ kind: 'tie', ticks: q });
  assert.equal(ed.stepCanTie(entries), true);
  const before = ed.stepTotalTicks(entries);
  entries.push({ kind: 'rest', ticks: q });
  assert.equal(ed.stepCanTie(entries), false);
  entries.push({ kind: 'note', m: 69, ticks: ed.stepTicks(2) });
  assert.equal(ed.stepCursor(ed.stepTotalTicks(entries) / ed.STEP_TPB, 4).text, '마디 2 · 박 2');
  entries.pop(); // ⌫ removes the note
  entries.pop(); // ⌫ removes the rest
  assert.equal(ed.stepTotalTicks(entries), before);
  assert.equal(ed.stepCursor(before / ed.STEP_TPB, 4).text, '마디 1 · 박 3');
  entries.pop(); // ⌫ removes the tie → note back to one beat
  assert.deepEqual(ed.stepEntriesToNotes(entries, { bpm: 60 }).map((n) => n.d), [1]);
});

test('step entry text: bar separators, ties merged, re-parses to the same notes', () => {
  const t = (v, o) => ed.stepTicks(v, o);
  const entries = [
    { kind: 'rest', ticks: t(1) },
    { kind: 'note', m: 60, ticks: t(1) },
    { kind: 'note', m: 62, ticks: t(0.5) },
    { kind: 'tie', ticks: t(0.5) },
    { kind: 'note', m: 64, ticks: t(1) },
    { kind: 'note', m: 65, ticks: t(1, { dotted: true }) },
    { kind: 'note', m: 67, ticks: t(0.5) },
    { kind: 'note', m: 66, ticks: t(1, { triplet: true }) },
    { kind: 'note', m: 64, ticks: t(1, { triplet: true }) },
    { kind: 'note', m: 62, ticks: t(1, { triplet: true }) },
    { kind: 'note', m: 60, ticks: t(0.25) },
  ];
  const text = ed.stepEntriesText(entries, { beatsPerBar: 4 });
  assert.equal(text, 'R 도4 레4 미4 | 파4:1.5 솔4:0.5 파#4:2/3 미4:2/3 레4:2/3 | 도4:1/4');
  const bpm = 90;
  const origin = 0.25;
  const expected = ed.stepEntriesToNotes(entries, { bpm, origin });
  const parsed = parseNotation(text, { bpm, offset: origin });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.notes.length, expected.length);
  parsed.notes.forEach((n, i) => {
    assert.equal(n.m, expected[i].m);
    assert.ok(Math.abs(n.t - expected[i].t) < 0.002, `t ${i}`);
    assert.ok(Math.abs(n.d - expected[i].d) < 0.002, `d ${i}`);
  });
  // continuing mid-bar: the separator follows the absolute bar grid
  assert.equal(ed.stepEntriesText([{ kind: 'note', m: 60, ticks: t(1) }, { kind: 'note', m: 72, ticks: t(1) }],
    { beatsPerBar: 3, startTick: t(2) }), '도4 | 도5');
  assert.equal(ed.stepEntriesText([], {}), '');
});

test('stepResumeTick: continues right after the last note, snapped up to 1/12 beat', () => {
  const tpb = ed.STEP_TPB;
  assert.equal(ed.stepResumeTick([], { bpm: 120, origin: 0 }), 0);
  assert.equal(ed.stepResumeTick([{ t: 0, d: 0.5, m: 60 }, { t: 1.5, d: 0.75, m: 62 }], { bpm: 120, origin: 0 }), 4.5 * tpb);
  assert.equal(ed.stepResumeTick([{ t: 0.5, d: 1, m: 60 }], { bpm: 60, origin: 0.5 }), tpb);
  const off = ed.stepResumeTick([{ t: 0, d: 1.01, m: 60 }], { bpm: 60, origin: 0 });
  assert.equal(off % 4, 0);
  assert.ok(off > tpb && off <= tpb + 4);
  assert.equal(ed.stepResumeTick([{ t: 0, d: 0.2, m: 60 }], { bpm: 60, origin: 1 }), 0); // before the grid → 0
  // notes entered earlier (stored rounded to 1 ms) resume exactly where the input stopped
  const trip = ed.stepTicks(1, { triplet: true });
  for (const bpm of [37, 80, 133, 251]) {
    const entries = Array.from({ length: 7 }, (_, i) => ({ kind: 'note', m: 60 + i, ticks: trip }));
    const notes = ed.stepEntriesToNotes(entries, { bpm, origin: 0.123 });
    assert.equal(ed.stepResumeTick(notes, { bpm, origin: 0.123 }), ed.stepTotalTicks(entries), `bpm ${bpm}`);
  }
});

test('lyricTokensAt: which syllable lands on the next note', () => {
  const text = '[1절]\n하나 둘 셋~\n_ la-la 넷\n';
  assert.deepEqual(ed.lyricTokensAt(text, 0, 3), ['하', '나', '둘']);
  assert.deepEqual(ed.lyricTokensAt(text, 3, 4), ['셋', '~', '_', 'la']);
  assert.deepEqual(ed.lyricTokensAt(text, 7, 4), ['la', '넷']);
  assert.deepEqual(ed.lyricTokensAt(text, 9, 4), []);
  assert.deepEqual(ed.lyricTokensAt('', 0, 4), []);
});

test('stepDefaultBase keeps the melody on the on-screen keyboard', () => {
  assert.equal(ed.stepDefaultBase([]), 60);
  assert.equal(ed.stepDefaultBase([{ m: 67 }, { m: 69 }, { m: 72 }]), 60);
  assert.equal(ed.stepDefaultBase([{ m: 57 }, { m: 60 }, { m: 62 }]), 48);
  assert.equal(ed.stepDefaultBase([{ m: 21 }]), 24);
  assert.equal(ed.stepDefaultBase([{ m: 108 }]), 84);
  for (const med of [40, 55, 60, 64, 71, 79, 90]) {
    const base = ed.stepDefaultBase([{ m: med }]);
    assert.ok(med >= base && med <= base + 24, `median ${med} visible from ${base}`);
  }
});

test('MusicXML import contract used by the editor (original 2-bar 6/8 tune)', async (t) => {
  let mx;
  try {
    mx = await import('../js/core/musicxml.js');
  } catch {
    t.skip('js/core/musicxml.js is not available');
    return;
  }
  const { assignLyrics } = await import('../js/core/lyrics.js');
  const note = (step, oct, dur, type, word) => `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch>`
    + `<duration>${dur}</duration><voice>1</voice><type>${type}</type>`
    + `${word ? `<lyric number="1"><syllabic>single</syllabic><text>${word}</text></lyric>` : ''}</note>`;
  const xml = '<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1">'
    + '<work><work-title>연습 멜로디</work-title></work>'
    + '<part-list><score-part id="P1"><part-name>Voice</part-name></score-part>'
    + '<score-part id="P2"><part-name>Piano</part-name></score-part></part-list>'
    + '<part id="P1"><measure number="1"><attributes><divisions>2</divisions><time><beats>6</beats><beat-type>8</beat-type></time></attributes>'
    + `<direction><sound tempo="60"/></direction>${note('C', 4, 2, 'quarter', '하')}${note('D', 4, 1, 'eighth', '나')}`
    + `${note('E', 4, 2, 'quarter', '둘')}${note('F', 4, 1, 'eighth', '셋')}</measure>`
    + `<measure number="2">${note('G', 4, 3, 'quarter', '넷')}${note('E', 4, 3, 'quarter', 'la')}</measure></part>`
    + '<part id="P2"><measure number="1"><attributes><divisions>2</divisions><time><beats>6</beats><beat-type>8</beat-type></time></attributes>'
    + `${note('C', 3, 6, 'half')}</measure><measure number="2">${note('G', 2, 6, 'half')}</measure></part></score-partwise>`;
  const bytes = new TextEncoder().encode(xml);
  assert.equal(ed.detectScoreFileKind(bytes, 'tune.musicxml'), 'musicxml');
  const score = mx.parseMusicXml(await mx.readScoreText(bytes));
  assert.equal(score.title, '연습 멜로디');
  const tracks = score.parts.flatMap((p) => p.tracks);
  for (const tr of tracks) {
    assert.equal(typeof tr.key, 'string');
    assert.ok(score.parts.some((p) => p.id === tr.partId && Array.isArray(p.verses)));
    assert.ok(Number.isFinite(tr.noteCount) && Number.isFinite(tr.lyricCount));
  }
  const key = mx.recommendTrack(score);
  const vocal = tracks.find((tr) => tr.key === key);
  assert.equal(vocal.lyricCount, 6);

  const res = mx.scoreToSong(score, { trackKey: key, verse: 'auto', melodyOnly: true, unfoldRepeats: true, includeLyrics: true });
  assert.equal(res.notes.length, 6);
  assert.equal(res.stats.syllables, 6);
  assert.ok(Array.isArray(res.warnings));
  assert.equal(res.beatsPerBar, 6);
  // the MIDI importer uses the same beat grid for the same time signature and ♩ tempo
  const grid = ed.midiBeatGrid({ num: 6, den: 8 }, 60);
  assert.equal(grid.bpm, res.bpm);
  assert.equal(grid.beatsPerBar, res.beatsPerBar);
  assert.deepEqual(assignLyrics(res.lyricText, res.notes).warnings, []);
  // The BPM override is in the same beat unit as the returned bpm (the editor prefills its field with it).
  const same = mx.scoreToSong(score, { trackKey: key, includeLyrics: false, bpm: res.bpm });
  assert.deepEqual(same.notes.map((n) => n.t), res.notes.map((n) => n.t));
  const faster = mx.scoreToSong(score, { trackKey: key, includeLyrics: false, bpm: res.bpm * 2 });
  assert.ok(Math.abs(faster.notes[5].t - res.notes[5].t / 2) < 0.002);
});

// --- recovery (unsaved drafts) ------------------------------------------------

const draftOf = (id, title, n = 1) => ({
  id, title, notes: Array.from({ length: n }, (_, i) => ({ t: i, d: 1, m: 60 + i })),
  lyrics: { text: '', source: 'notes', lines: [] },
});

test('recovery store: an old single-slot value migrates into the per-song map', () => {
  const legacy = { id: 'song-a', isNew: true, savedAt: 1000, draft: draftOf('song-a', '새 곡 A', 3) };
  const slots = ed.parseRecoveryStore(JSON.stringify(legacy));
  assert.deepEqual(Object.keys(slots), ['song-a']);
  assert.equal(slots['song-a'].isNew, true);
  assert.equal(slots['song-a'].savedAt, 1000);
  assert.equal(slots['song-a'].draft.notes.length, 3);
  // id missing on the record → taken from the draft
  assert.deepEqual(Object.keys(ed.parseRecoveryStore({ savedAt: 5, draft: draftOf('song-z', 'z') })), ['song-z']);

  // new format round trip
  const text = ed.serializeRecoveryStore(slots);
  assert.equal(JSON.parse(text).v, 2);
  assert.deepEqual(ed.parseRecoveryStore(text), slots);

  // junk is ignored
  assert.deepEqual(ed.parseRecoveryStore('not json'), {});
  assert.deepEqual(ed.parseRecoveryStore(null), {});
  assert.deepEqual(ed.parseRecoveryStore('[]'), {});
  assert.deepEqual(ed.parseRecoveryStore({ v: 2, slots: { x: { id: 'x' }, y: null, z: { draft: [] } } }), {});
});

test('recovery store: editing another song never overwrites a pending draft; capped to the newest entries', () => {
  let slots = ed.parseRecoveryStore({ id: 'new-a', isNew: true, savedAt: 1000, draft: draftOf('new-a', 'A') });
  // the user opens existing song B and edits it → B gets its own slot, A stays
  slots = ed.recoveryPut(slots, 'song-b', { id: 'song-b', isNew: false, savedAt: 2000, draft: draftOf('song-b', 'B') });
  assert.deepEqual(Object.keys(slots).sort(), ['new-a', 'song-b']);
  assert.equal(slots['new-a'].draft.title, 'A');
  // saving B clears only B
  const afterSave = ed.recoveryDrop(slots, (e) => e.id === 'song-b');
  assert.deepEqual(Object.keys(afterSave), ['new-a']);

  // cap: the slot being written is always kept, the oldest others are dropped
  let many = {};
  for (let i = 0; i < 8; i++) many = ed.recoveryPut(many, `s${i}`, { id: `s${i}`, isNew: false, savedAt: 100 + i, draft: draftOf(`s${i}`, '') }, 5);
  assert.deepEqual(Object.keys(many).sort(), ['s3', 's4', 's5', 's6', 's7']);
  const old = ed.recoveryPut(many, 'old', { id: 'old', isNew: false, savedAt: 1, draft: draftOf('old', '') }, 5);
  assert.ok(old.old, 'the slot just written survives even when it is the oldest');
  assert.equal(Object.keys(old).length, 5);
});

test('recovery candidates: same song newer than its last save; new song → every never-saved draft', () => {
  const slots = {
    'song-b': { id: 'song-b', isNew: false, savedAt: 5000, draft: draftOf('song-b', 'B') },
    'song-b@x1': { id: 'song-b', isNew: false, savedAt: 7000, draft: draftOf('song-b', 'B2') },
    'song-c': { id: 'song-c', isNew: false, savedAt: 1000, draft: draftOf('song-c', 'C') },
    'new-a': { id: 'new-a', isNew: true, savedAt: 3000, draft: draftOf('new-a', 'A') },
    'new-d': { id: 'new-d', isNew: true, savedAt: 9000, draft: draftOf('new-d', 'D') },
  };
  assert.deepEqual(ed.recoveryCandidates(slots, { id: 'song-b', updatedAt: 4000 }).map((c) => c.slot), ['song-b@x1', 'song-b']);
  assert.deepEqual(ed.recoveryCandidates(slots, { id: 'song-b', updatedAt: 6000 }).map((c) => c.slot), ['song-b@x1']);
  assert.deepEqual(ed.recoveryCandidates(slots, { id: 'song-c', updatedAt: 1000 }), []); // saved after the draft
  assert.deepEqual(ed.recoveryCandidates(slots, {}).map((c) => c.slot), ['new-d', 'new-a']);
  assert.deepEqual(ed.recoveryCandidates({}, {}), []);
});

test('recovery prompt: one draft → restore/discard; several → one button per draft + discard all', () => {
  const one = ed.recoveryPrompt([{ slot: 'a', entry: { id: 'a', savedAt: 0, draft: draftOf('a', '연습곡', 2) } }]);
  assert.deepEqual(one.options.map((o) => o.value), ['restore:0', 'discard']);
  assert.match(one.message, /연습곡/);
  assert.match(one.message, /다시 물어봐요/);
  const existing = ed.recoveryPrompt([{ slot: 'a', entry: { id: 'a', savedAt: 0, draft: draftOf('a', '') } }], { existing: true });
  assert.match(existing.options[1].label, /저장된 곡/);
  assert.match(existing.message, /제목 없음/);
  const two = ed.recoveryPrompt([
    { slot: 'x', entry: { id: 'x', savedAt: 2, draft: draftOf('x', '둘째', 4) } },
    { slot: 'y', entry: { id: 'y', savedAt: 1, draft: draftOf('y', '첫째', 1) } },
  ]);
  assert.deepEqual(two.options.map((o) => o.value), ['restore:0', 'restore:1', 'discard']);
  assert.match(two.options[0].label, /둘째.*노트 4개/);
  assert.match(two.options[2].label, /모두 버리고/);
});

test('recovery: a draft kept by closing the prompt survives saving the same song and is offered again', () => {
  // the tab was killed while editing song B → its draft is newer than the last save (4000)
  let slots = { 'song-b': { id: 'song-b', isNew: false, savedAt: 5000, draft: draftOf('song-b', 'B 많이 고침', 9) } };
  assert.deepEqual(ed.recoveryCandidates(slots, { id: 'song-b', updatedAt: 4000 }).map((c) => c.slot), ['song-b']);
  // the prompt is closed (backdrop / back key) → kept; this session edits in its own slot
  slots = ed.recoveryKeep(slots, ['song-b']);
  assert.equal(slots['song-b'].kept, true);
  slots = ed.recoveryPut(slots, 'song-b@x1', ed.makeRecoveryEntry(draftOf('song-b', 'B 한 음 고침', 2), { now: 6000 }));
  // the user fixes one note and saves (started at 6500, stamped 7000): only this session's draft goes away
  slots = ed.recoveryAfterSave(slots, { id: 'song-b', slot: 'song-b@x1', before: 6500 });
  assert.deepEqual(Object.keys(slots), ['song-b']);
  // next time B is opened: the kept draft is older than the save but is not pruned, and is offered as older
  slots = ed.recoveryPrune(slots, 'song-b', 7000);
  assert.deepEqual(Object.keys(slots), ['song-b']);
  const cands = ed.recoveryCandidates(slots, { id: 'song-b', updatedAt: 7000 });
  assert.deepEqual(cands.map((c) => c.slot), ['song-b']);
  const prompt = ed.recoveryPrompt(cands, { existing: true, updatedAt: 7000 });
  assert.match(prompt.message, /저장한 곡보다 이전/);
  assert.match(prompt.message, /B 많이 고침/);
  // survives the localStorage round trip
  assert.equal(ed.parseRecoveryStore(ed.serializeRecoveryStore(slots))['song-b'].kept, true);
});

test('recovery: drafts nobody kept are still dropped once a save supersedes them', () => {
  const slots = {
    'song-b': { id: 'song-b', isNew: false, savedAt: 5000, draft: draftOf('song-b', 'old') },
    'song-b@k': { id: 'song-b', isNew: false, savedAt: 4500, kept: true, draft: draftOf('song-b', 'kept') },
    'song-b@late': { id: 'song-b', isNew: false, savedAt: 9000, draft: draftOf('song-b', 'written while saving') },
    'song-c': { id: 'song-c', isNew: false, savedAt: 100, draft: draftOf('song-c', 'C') },
  };
  // after a save that started at 6000: the session slot, and unkept older drafts of the same song
  const after = ed.recoveryAfterSave(slots, { id: 'song-b', slot: 'song-b', before: 6000 });
  assert.deepEqual(Object.keys(after).sort(), ['song-b@k', 'song-b@late', 'song-c']);
  assert.deepEqual(Object.keys(ed.recoveryAfterSave(slots, { id: 'song-b', slot: '', before: 0 })).sort(), Object.keys(slots).sort());
  // opening after a save at 8000 prunes only the unkept older one
  assert.deepEqual(Object.keys(ed.recoveryPrune(slots, 'song-b', 8000)).sort(), ['song-b@k', 'song-b@late', 'song-c']);
  // several candidates: the older-than-saved one is labelled
  const cands = ed.recoveryCandidates(ed.recoveryPrune(slots, 'song-b', 8000), { id: 'song-b', updatedAt: 8000 });
  assert.deepEqual(cands.map((c) => c.slot), ['song-b@late', 'song-b@k']);
  const prompt = ed.recoveryPrompt(cands, { existing: true, updatedAt: 8000 });
  assert.doesNotMatch(prompt.options[0].label, /저장본보다 이전/);
  assert.match(prompt.options[1].label, /저장본보다 이전/);
  // recoveryKeep marks only the listed slots and leaves the input alone
  const kept = ed.recoveryKeep(slots, ['song-c']);
  assert.equal(kept['song-c'].kept, true);
  assert.equal(slots['song-c'].kept, undefined);
  assert.equal(kept['song-b'], slots['song-b']);
});

test('recovery entry written after a save that raced with edits is newer than the save', () => {
  const draft = draftOf('song-b', 'edited during save');
  // clock reads the same millisecond as the library stamp (or earlier): still strictly after it
  const e = ed.makeRecoveryEntry(draft, { isNew: false, now: 7000, notBefore: 7000 });
  assert.equal(e.savedAt, 7001);
  assert.equal(e.isNew, false);
  assert.equal(e.id, 'song-b');
  assert.equal(ed.makeRecoveryEntry(draft, { now: 9000, notBefore: 7000 }).savedAt, 9000);
  // so opening the song later offers it instead of pruning it
  const slots = { 'song-b': e };
  assert.deepEqual(Object.keys(ed.recoveryPrune(slots, 'song-b', 7000)), ['song-b']);
  assert.equal(ed.recoveryCandidates(slots, { id: 'song-b', updatedAt: 7000 }).length, 1);
  assert.equal(ed.makeRecoveryEntry(draftOf('new-x', ''), { isNew: true, now: 5 }).isNew, true);
});

/** Minimal localStorage stand-in; quota = max characters of the stored value. */
function fakeStorage(quota = Infinity) {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (String(v).length > quota) {
        const err = new Error('quota');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(k, String(v));
    },
    removeItem: (k) => { map.delete(k); },
  };
}

/** Installs `storage` as globalThis.localStorage for one test (works whether or not Node defines its own). */
function useStorage(t, storage) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const set = (v) => Object.defineProperty(globalThis, 'localStorage', { value: v, configurable: true, writable: true });
  set(storage);
  t.after(() => {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    else delete globalThis.localStorage;
  });
  return set;
}

test('recovery storage: the old single-slot pk.editorRecovery value is migrated on first read', (t) => {
  const ls = fakeStorage();
  useStorage(t, ls);
  ls.setItem('pk.editorRecovery', JSON.stringify({ id: 'new-a', isNew: true, savedAt: 1000, draft: draftOf('new-a', 'A', 2) }));
  const slots = ed.readRecoveryStore();
  assert.deepEqual(Object.keys(slots), ['new-a']);
  const stored = JSON.parse(ls.getItem('pk.editorRecovery'));
  assert.equal(stored.v, 2);
  assert.equal(stored.slots['new-a'].draft.title, 'A');
  // later reads keep it; writing another song adds a slot next to it
  ed.writeRecoveryStore(ed.recoveryPut(ed.readRecoveryStore(), 'song-b', { id: 'song-b', isNew: false, savedAt: 2000, draft: draftOf('song-b', 'B') }));
  assert.deepEqual(Object.keys(ed.readRecoveryStore()).sort(), ['new-a', 'song-b']);
  // empty map removes the key
  ed.writeRecoveryStore({});
  assert.equal(ls.getItem('pk.editorRecovery'), null);
  // broken value → nothing, no throw
  ls.setItem('pk.editorRecovery', '{broken');
  assert.deepEqual(ed.readRecoveryStore(), {});
});

test('recovery storage: when the quota is exceeded the oldest other drafts are dropped first', (t) => {
  let slots = {};
  for (let i = 0; i < 3; i++) slots = ed.recoveryPut(slots, `s${i}`, { id: `s${i}`, isNew: false, savedAt: 10 + i, draft: draftOf(`s${i}`, '', 20) });
  const ls = fakeStorage(ed.serializeRecoveryStore({ s0: slots.s0, s2: slots.s2 }).length);
  const setStorage = useStorage(t, ls);
  assert.equal(ed.writeRecoveryStore(slots, 's0'), true);
  assert.deepEqual(Object.keys(JSON.parse(ls.getItem('pk.editorRecovery')).slots).sort(), ['s0', 's2']);
  setStorage(fakeStorage(10));
  assert.equal(ed.writeRecoveryStore(slots, 's0'), false); // gives up quietly
  setStorage(undefined);
  assert.deepEqual(ed.readRecoveryStore(), {}); // no storage at all
  assert.equal(ed.writeRecoveryStore(slots), false);
});

// --- undo snapshots -------------------------------------------------------------

const songDraft = () => ({
  title: '', artist: '', description: '', bpm: 100, beatsPerBar: 4, offset: 0,
  notes: [{ t: 0, d: 1, m: 60 }, { t: 1, d: 1, m: 62 }],
  lyrics: { text: '가나', source: 'notes', lines: [] },
  audio: { name: 'mr.mp3', offset: 0, volume: 0.8 },
});

test('undo of a note edit keeps lyrics and audio offset typed afterwards', () => {
  const d = songDraft();
  const snap = ed.makeUndoSnapshot(d, '노트 삭제');
  d.notes.splice(1, 1); // the operation
  ed.sealUndoSnapshot(snap, d);
  // later, without their own undo step
  d.lyrics.text = '가나다라 마바사';
  d.audio.offset = -1.25;
  d.title = '내 노래';
  ed.applyUndoSnapshot(d, snap);
  assert.equal(d.notes.length, 2);
  assert.equal(d.lyrics.text, '가나다라 마바사');
  assert.equal(d.audio.offset, -1.25);
  assert.equal(d.title, '내 노래');
});

test('undo of an import restores what it changed, but keeps a title typed after it', () => {
  const d = songDraft();
  const snap = ed.makeUndoSnapshot(d, '악보 파일 가져오기', { basics: true, lyrics: true });
  d.notes = [{ t: 0, d: 0.5, m: 67 }];
  d.bpm = 90;
  d.beatsPerBar = 3;
  d.title = '가져온 제목';
  d.artist = '작곡가';
  d.lyrics = { text: '라라', source: 'notes', lines: [] };
  ed.sealUndoSnapshot(snap, d);
  assert.deepEqual(Object.keys(snap.basics).sort(), ['artist', 'beatsPerBar', 'bpm', 'title']);
  d.title = '직접 고친 제목'; // typed after the import
  ed.applyUndoSnapshot(d, snap);
  assert.deepEqual(d.notes.map((n) => n.m), [60, 62]);
  assert.equal(d.bpm, 100);
  assert.equal(d.beatsPerBar, 4);
  assert.equal(d.lyrics.text, '가나');
  assert.equal(d.title, '직접 고친 제목');
  assert.equal(d.artist, ''); // untouched since the import → restored
  assert.equal(d.offset, 0);
});

test('undo snapshot drops fields the operation did not change (trim with note-based lyrics)', () => {
  const d = songDraft();
  d.notes = [{ t: 2, d: 1, m: 60 }];
  const snap = ed.makeUndoSnapshot(d, '앞 공백 제거', { basics: true, lyrics: true, audio: true });
  const res = ed.trimLeadingSilence(d);
  d.notes = res.notes;
  d.offset = res.offset;
  d.audio = res.audio;
  d.lyrics = res.lyrics; // notes-based lyrics are returned as-is
  ed.sealUndoSnapshot(snap, d);
  assert.equal(snap.lyrics, null);
  assert.equal(snap.audioOffset, 0);
  d.lyrics.text = '새로 쓴 가사';
  ed.applyUndoSnapshot(d, snap);
  assert.equal(d.notes[0].t, 2);
  assert.equal(d.offset, 0);
  assert.equal(d.audio.offset, 0);
  assert.equal(d.lyrics.text, '새로 쓴 가사');
});

test('an unsealed snapshot restores everything it captured', () => {
  const d = songDraft();
  const snap = ed.makeUndoSnapshot(d, 'x', { basics: true, lyrics: true, audio: true });
  d.title = 'changed';
  d.lyrics = { text: 'changed', source: 'notes', lines: [] };
  d.audio.offset = 3;
  ed.applyUndoSnapshot(d, snap);
  assert.equal(d.title, '');
  assert.equal(d.lyrics.text, '가나');
  assert.equal(d.audio.offset, 0);
  assert.equal(ed.applyUndoSnapshot(d, null), d);
});

// --- LRC lyrics follow the backing audio --------------------------------------------

const lrcLines = () => [
  { syllables: [{ text: '하', t: 5, d: 0.5 }, { text: '나', t: 5.5, d: 0.5 }] },
  { syllables: [{ text: '둘', t: 8, d: 1 }] },
];

test('LRC times are audio time: imported lines move by the audio offset, exported lines move back', () => {
  const song = ed.lrcLinesToSongTime(lrcLines(), -5);
  assert.deepEqual(song.flatMap((l) => l.syllables.map((y) => y.t)), [0, 0.5, 3]);
  assert.deepEqual(song[0].syllables.map((y) => y.d), [0.5, 0.5]);
  const back = ed.songLinesToLrcTime(song, -5);
  assert.deepEqual(back, lrcLines());
  // no audio offset → unchanged
  const same = lrcLines();
  assert.equal(ed.lrcLinesToSongTime(same, 0), same);
  assert.equal(ed.songLinesToLrcTime(same, undefined), same);
  // exported times never go below 0
  assert.equal(ed.songLinesToLrcTime([{ syllables: [{ text: 'a', t: 0.2, d: 0.1 }] }], 1)[0].syllables[0].t, 0);
});

test('changing the audio offset moves LRC lyrics with it (not note-based lyrics)', () => {
  const d = {
    notes: [{ t: 0, d: 1, m: 60 }],
    audio: { name: 'mr.mp3', offset: 0, volume: 1 },
    lyrics: { text: '하나 둘', source: 'lrc', lines: lrcLines() },
  };
  // 「첫 음에서 탭해서 맞추기」: audio intro of 5 s → offset −5
  assert.equal(ed.setDraftAudioOffset(d, -5), -5);
  assert.equal(d.audio.offset, -5);
  assert.deepEqual(d.lyrics.lines.flatMap((l) => l.syllables.map((y) => y.t)), [0, 0.5, 3]);
  assert.equal(d.notes[0].t, 0);
  // fine tuning +0.01
  assert.equal(ed.setDraftAudioOffset(d, -4.99), 0.01);
  assert.equal(d.lyrics.lines[0].syllables[0].t, 0.01);
  assert.equal(ed.setDraftAudioOffset(d, -4.99), 0);

  const n = { audio: { offset: 0 }, lyrics: { text: '가', source: 'notes', lines: [] } };
  const before = n.lyrics;
  ed.setDraftAudioOffset(n, 2);
  assert.equal(n.lyrics, before);
  assert.equal(n.audio.offset, 2);
  assert.equal(ed.setDraftAudioOffset({ audio: null, lyrics: before }, 1), 0);
  assert.equal(ed.setDraftAudioOffset(n, NaN), 0);
  assert.equal(ed.shiftLyricTimes(before, 3), before);
});

const lyricTimes = (d) => d.lyrics.lines.flatMap((l) => l.syllables.map((y) => y.t));
const lrcDraft = (offset = 0) => ({
  ...songDraft(),
  audio: { name: 'mr.mp3', offset, volume: 0.8 },
  lyrics: { text: '하나 둘', source: 'lrc', lines: ed.lrcLinesToSongTime(lrcLines(), offset) },
});

test('undo of an LRC re-import after an offset change puts the old lines at the current offset', () => {
  const d = lrcDraft(0); // LRC A placed at offset 0 → 5, 5.5, 8
  const snap = ed.makeUndoSnapshot(d, 'LRC 가져오기', { basics: true, lyrics: true });
  assert.equal(snap.lyricsAudioOffset, 0);
  // LRC B imported (its own audio times 7)
  d.lyrics = { text: 'B', source: 'lrc', lines: ed.lrcLinesToSongTime([{ syllables: [{ text: 'B', t: 7, d: 1 }] }], ed.lrcAudioOffset(d)) };
  ed.sealUndoSnapshot(snap, d);
  // the offset is typed afterwards (no undo step of its own) → B moves with it
  ed.setDraftAudioOffset(d, -5);
  assert.deepEqual(lyricTimes(d), [2]);
  ed.applyUndoSnapshot(d, snap);
  assert.equal(d.lyrics.lines[0].syllables[0].text, '하');
  assert.deepEqual(lyricTimes(d), [0, 0.5, 3], 'A follows the offset now in effect (−5), not the one it was placed with');
  assert.equal(d.audio.offset, -5);
  // durations are untouched
  assert.deepEqual(d.lyrics.lines[0].syllables.map((y) => y.d), [0.5, 0.5]);
});

test('undo of switching to note-based lyrics after an offset change restores LRC lines at the current offset', () => {
  const d = lrcDraft(-2); // 3, 3.5, 6
  const snap = ed.makeUndoSnapshot(d, '노트 기준으로 바꾸기', { lyrics: true });
  d.lyrics = { text: '하나 둘', source: 'notes', lines: [] };
  ed.sealUndoSnapshot(snap, d);
  ed.setDraftAudioOffset(d, -4.5); // note-based lyrics do not move
  ed.applyUndoSnapshot(d, snap);
  assert.equal(d.lyrics.source, 'lrc');
  assert.deepEqual(lyricTimes(d), [0.5, 1, 3.5]);
});

test('undo that restores the audio offset together with the lyrics does not shift them again', () => {
  const d = lrcDraft(0);
  const snap = ed.makeUndoSnapshot(d, '음원 오프셋 맞추기', { audio: true, lyrics: true });
  ed.setDraftAudioOffset(d, -5);
  ed.sealUndoSnapshot(snap, d);
  ed.setDraftAudioOffset(d, -4.9); // ± fine tuning afterwards
  ed.applyUndoSnapshot(d, snap);
  assert.equal(d.audio.offset, 0);
  assert.deepEqual(lyricTimes(d), [5, 5.5, 8]);

  // trim moves notes, audio offset and LRC lines together; undo restores all of them as they were
  const t = lrcDraft(-1);
  t.notes = [{ t: 2, d: 1, m: 60 }];
  const trimSnap = ed.makeUndoSnapshot(t, '앞 공백 제거', { basics: true, lyrics: true, audio: true });
  const res = ed.trimLeadingSilence(t);
  Object.assign(t, { notes: res.notes, offset: res.offset, audio: res.audio, lyrics: res.lyrics });
  ed.sealUndoSnapshot(trimSnap, t);
  ed.applyUndoSnapshot(t, trimSnap);
  assert.equal(t.audio.offset, -1);
  assert.deepEqual(lyricTimes(t), [4, 4.5, 7]);
});

test('undo after the backing audio was removed puts LRC lines back on LRC file time', () => {
  const d = lrcDraft(-5); // 0, 0.5, 3
  const snap = ed.makeUndoSnapshot(d, '노트 기준으로 바꾸기', { lyrics: true });
  d.lyrics = { text: '하나 둘', source: 'notes', lines: [] };
  ed.sealUndoSnapshot(snap, d);
  ed.removeDraftAudio(d);
  ed.applyUndoSnapshot(d, snap);
  assert.deepEqual(lyricTimes(d), [5, 5.5, 8]);
  // snapshots kept from before this change (no lyricsAudioOffset) restore the lines as stored
  const old = { label: 'x', notes: d.notes, lyrics: { text: 'a', source: 'lrc', lines: lrcLines() } };
  const e = lrcDraft(-3);
  ed.applyUndoSnapshot(e, old);
  assert.deepEqual(lyricTimes(e), [5, 5.5, 8]);
});

test('removing the backing audio returns LRC lines to file time, so re-adding audio and its offset lines up', () => {
  const d = lrcDraft(-5);
  assert.deepEqual(lyricTimes(d), [0, 0.5, 3]);
  assert.equal(ed.removeDraftAudio(d), 5);
  assert.equal(d.audio, null);
  assert.deepEqual(lyricTimes(d), [5, 5.5, 8]);
  assert.equal(ed.lrcAudioOffset(d), 0);
  // exported LRC (no audio) = the original file times
  assert.deepEqual(ed.songLinesToLrcTime(d.lyrics.lines, ed.lrcAudioOffset(d)), lrcLines());
  // pick the recording again (starts at offset 0) and enter the real offset again
  d.audio = ed.pickedAudioInfo(d.audio, 'mr.mp3');
  assert.equal(d.audio.offset, 0);
  ed.setDraftAudioOffset(d, -5);
  assert.deepEqual(lyricTimes(d), [0, 0.5, 3], 'not shifted twice');
  assert.equal(ed.removeDraftAudio({ audio: null, lyrics: d.lyrics }), 0);
  // note-based lyrics never move
  const n = { ...songDraft(), audio: { name: 'a', offset: 2, volume: 1 } };
  const before = n.lyrics;
  ed.removeDraftAudio(n);
  assert.equal(n.lyrics, before);
});

test('JSON import → pick the audio again → enter the offset again keeps LRC lyrics where they belong', () => {
  // exported on tablet A: audio offset −5, LRC lines already in song time
  const exported = lrcDraft(-5);
  // imported on tablet B into a draft without the audio file
  const res = ed.importedAudioState(exported, null, false);
  assert.deepEqual(res.audio, { name: 'mr.mp3', offset: -5, volume: 0.8 });
  assert.equal(res.missing, true);
  assert.notEqual(res.audio, exported.audio);
  const d = { ...songDraft(), audio: res.audio, lyrics: res.lyrics };
  // exporting LRC before the file is back still gives the file times
  assert.deepEqual(ed.songLinesToLrcTime(d.lyrics.lines, ed.lrcAudioOffset(d)), lrcLines());
  // 「다시 선택」 inherits the offset → typing it again (or tap-align landing on it) moves nothing
  d.audio = ed.pickedAudioInfo(d.audio, 'mr-copy.mp3');
  assert.deepEqual(d.audio, { name: 'mr-copy.mp3', offset: -5, volume: 0.8 });
  assert.equal(ed.setDraftAudioOffset(d, -5), 0);
  assert.deepEqual(lyricTimes(d), [0, 0.5, 3]);
  ed.setDraftAudioOffset(d, -4.8);
  assert.deepEqual(lyricTimes(d), [0.2, 0.7, 3.2]);
  // a draft whose stored audio file was missing too takes the imported audio info
  const missing = ed.importedAudioState(exported, { name: 'old.mp3', offset: 1, volume: 1 }, false);
  assert.equal(missing.audio.name, 'mr.mp3');
  assert.equal(missing.audio.offset, -5);
});

test('JSON import: with an audio file the imported offset applies to it; a JSON without audio follows the current offset', () => {
  const exported = lrcDraft(-5);
  const cur = { name: 'mine.mp3', offset: 1, volume: 0.5 };
  const withFile = ed.importedAudioState(exported, cur, true);
  assert.deepEqual(withFile.audio, { name: 'mine.mp3', offset: -5, volume: 0.8 });
  assert.equal(withFile.missing, false);
  assert.equal(withFile.lyrics, exported.lyrics);
  // the JSON has no audio → its LRC lines are file time (offset 0); the current audio keeps its offset (+1)
  const plain = { ...songDraft(), audio: null, lyrics: { text: '하나 둘', source: 'lrc', lines: lrcLines() } };
  const kept = ed.importedAudioState(plain, cur, true);
  assert.equal(kept.audio, cur);
  assert.equal(kept.missing, false);
  assert.deepEqual(kept.lyrics.lines.flatMap((l) => l.syllables.map((y) => y.t)), [6, 6.5, 9]);
  assert.equal(ed.importedAudioState(plain, cur, false).missing, true);
  const none = ed.importedAudioState(plain, null, false);
  assert.equal(none.audio, null);
  assert.equal(none.missing, false);
  assert.equal(none.lyrics, plain.lyrics);
});

// --- MIDI time signatures -------------------------------------------------------

test('midiBeatGrid: bar length matches the time signature (x/8, x/2 like MusicXML)', () => {
  const barSec = (g) => (60 / g.bpm) * g.beatsPerBar;
  const quarterBar = (ts, q) => (60 / q) * (ts.num * 4 / ts.den);
  const cases = [
    [{ num: 4, den: 4 }, 120, { bpm: 120, beatsPerBar: 4, unit: 4 }],
    [{ num: 3, den: 4 }, 100, { bpm: 100, beatsPerBar: 3, unit: 4 }],
    [{ num: 6, den: 8 }, 90, { bpm: 180, beatsPerBar: 6, unit: 8 }],
    [{ num: 9, den: 8 }, 60, { bpm: 120, beatsPerBar: 9, unit: 8 }],
    [{ num: 2, den: 2 }, 120, { bpm: 60, beatsPerBar: 2, unit: 2 }],
    [{ num: 6, den: 8 }, 200, { bpm: 200, beatsPerBar: 3, unit: 4 }], // 8th BPM 400 is out of range → quarter beats
  ];
  for (const [ts, q, want] of cases) {
    const g = ed.midiBeatGrid(ts, q);
    assert.deepEqual(g, want, `${ts.num}/${ts.den} ♩=${q}`);
    assert.ok(Math.abs(barSec(g) - quarterBar(ts, q)) < 1e-9, `${ts.num}/${ts.den} bar length`);
  }
  assert.deepEqual(ed.midiBeatGrid(null, NaN), { bpm: 120, beatsPerBar: 4, unit: 4 });
  assert.equal(ed.midiBeatGrid({ num: 4, den: 4 }, 500).bpm, 300); // clamped to the app range
});

// --- step entry persistence ---------------------------------------------------------

test('stepMergeNotes: append keeps existing notes (copied), replace uses only the entries', () => {
  const existing = [{ t: 0, d: 0.5, m: 60 }];
  const entries = [{ kind: 'note', m: 62, ticks: ed.STEP_TPB }, { kind: 'rest', ticks: ed.STEP_TPB }, { kind: 'note', m: 64, ticks: ed.STEP_TPB }];
  const app = ed.stepMergeNotes(existing, entries, { bpm: 120, origin: 0, startTick: ed.STEP_TPB, append: true });
  assert.deepEqual(app.added.map((n) => [n.t, n.m]), [[0.5, 62], [1.5, 64]]);
  assert.deepEqual(app.notes.map((n) => [n.t, n.m]), [[0, 60], [0.5, 62], [1.5, 64]]);
  assert.notEqual(app.notes[0], existing[0]);
  app.notes[0].m = 1;
  assert.equal(existing[0].m, 60, 'existing notes are not mutated');
  const rep = ed.stepMergeNotes(existing, entries, { bpm: 120 });
  assert.deepEqual(rep.notes.map((n) => [n.t, n.m]), [[0, 62], [1, 64]]);
  assert.deepEqual(ed.stepMergeNotes(existing, [], { append: true }).added, []);
});

test('screen module exports mount/unmount/onBack', () => {
  assert.equal(typeof ed.mount, 'function');
  assert.equal(typeof ed.unmount, 'function');
  assert.equal(typeof ed.onBack, 'function');
  assert.equal(ed.onBack(), false); // nothing mounted → let the router handle back
  ed.unmount();
});
