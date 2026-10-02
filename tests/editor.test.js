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
  assert.deepEqual(assignLyrics(res.lyricText, res.notes).warnings, []);
  // The BPM override is in the same beat unit as the returned bpm (the editor prefills its field with it).
  const same = mx.scoreToSong(score, { trackKey: key, includeLyrics: false, bpm: res.bpm });
  assert.deepEqual(same.notes.map((n) => n.t), res.notes.map((n) => n.t));
  const faster = mx.scoreToSong(score, { trackKey: key, includeLyrics: false, bpm: res.bpm * 2 });
  assert.ok(Math.abs(faster.notes[5].t - res.notes[5].t / 2) < 0.002);
});

test('screen module exports mount/unmount/onBack', () => {
  assert.equal(typeof ed.mount, 'function');
  assert.equal(typeof ed.unmount, 'function');
  assert.equal(typeof ed.onBack, 'function');
  assert.equal(ed.onBack(), false); // nothing mounted → let the router handle back
  ed.unmount();
});
