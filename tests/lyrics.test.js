import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenizeLine, parseLyricText, groupNoteEvents, assignLyrics, solfegeLyricText,
  lineStart, lineEnd, lyricsPlainText, parseLRC, toLRC, formatLrcTime,
} from '../js/core/lyrics.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const syl = (text) => ({ type: 'syl', text });
const EXT = { type: 'ext' };
const SKIP = { type: 'skip' };
const texts = (tokens) => tokens.filter((t) => t.type === 'syl').map((t) => t.text);
const seq = (n, step = 0.5, d = 0.4, m = 60) => Array.from({ length: n }, (_, i) => ({ t: i * step, d, m }));

// ---------------------------------------------------------------- tokenizeLine

test('tokenizeLine: spec examples', () => {
  assert.deepEqual(tokenizeLine('반짝 반짝'), [syl('반'), syl('짝 '), syl('반'), syl('짝')]);
  assert.deepEqual(tokenizeLine('Twin-kle, twin-kle'), [syl('Twin'), syl('kle, '), syl('twin'), syl('kle')]);
  assert.deepEqual(tokenizeLine('사~랑해'), [syl('사'), EXT, syl('랑'), syl('해')]);
  assert.deepEqual(tokenizeLine('_ 하나'), [SKIP, syl('하'), syl('나')]);
  assert.deepEqual(tokenizeLine('(오) 예'), [syl('(오) '), syl('예')]);
  assert.deepEqual(tokenizeLine('도# 레'), [syl('도# '), syl('레')]);
  assert.deepEqual(tokenizeLine("don't stop"), [syl("don't "), syl('stop')]);
});

test('tokenizeLine: markers, spacing and punctuation', () => {
  assert.deepEqual(tokenizeLine('사～랑'), [syl('사'), EXT, syl('랑')]);
  assert.deepEqual(tokenizeLine('사 ~랑'), [syl('사 '), EXT, syl('랑')]);
  assert.deepEqual(tokenizeLine('사~ 랑'), [syl('사 '), EXT, syl('랑')]);
  assert.deepEqual(tokenizeLine('하나_둘'), [syl('하'), syl('나'), SKIP, syl('둘')]);
  assert.deepEqual(tokenizeLine('  안녕   하세요  '), [syl('안'), syl('녕 '), syl('하'), syl('세'), syl('요')]);
  assert.deepEqual(texts(tokenizeLine('안녕, 친구야!')), ['안', '녕, ', '친', '구', '야!']);
  assert.deepEqual(texts(tokenizeLine('정말?! 그래…')), ['정', '말?! ', '그', '래…']);
  assert.deepEqual(texts(tokenizeLine('"안녕" 하고')), ['"안', '녕" ', '하', '고']);
  assert.deepEqual(texts(tokenizeLine('“그대” 라고')), ['“그', '대” ', '라', '고']);
  assert.deepEqual(texts(tokenizeLine('[오] {예}')), ['[오] ', '{예}']);
  assert.deepEqual(texts(tokenizeLine('파♯ 시♭')), ['파♯ ', '시♭']);
  assert.deepEqual(texts(tokenizeLine('하나: 둘;')), ['하', '나: ', '둘;']);
  assert.deepEqual(texts(tokenizeLine("rock 'n' roll")), ['rock ', "'n' ", 'roll']);
  assert.deepEqual(texts(tokenizeLine('I’m here')), ['I’m ', 'here']);
  assert.deepEqual(texts(tokenizeLine('사랑OK야')), ['사', '랑', 'OK', '야']);
  assert.deepEqual(texts(tokenizeLine('1, 2, 3')), ['1, ', '2, ', '3']);
  assert.deepEqual(texts(tokenizeLine('a-b-c')), ['a', 'b', 'c']);
  assert.deepEqual(texts(tokenizeLine('ありがとう')), ['あ', 'り', 'が', 'と', 'う']);
  assert.deepEqual(texts(tokenizeLine('感謝')), ['感', '謝']);
  assert.deepEqual(tokenizeLine(''), []);
  assert.deepEqual(tokenizeLine('   '), []);
  assert.deepEqual(tokenizeLine('...'), []);
  assert.deepEqual(tokenizeLine(null), []);
});

test('tokenizeLine: concatenated syllables reproduce the displayed line', () => {
  const cases = [
    ['반짝 반짝 빛나는 건반', '반짝 반짝 빛나는 건반'],
    ['Hel-lo, hel-lo pi-a-no keys', 'Hello, hello piano keys'],
    ['사~랑_해 (요)', '사랑해 (요)'],
    ['손끝으로 톡톡 톡', '손끝으로 톡톡 톡'],
  ];
  for (const [line, shown] of cases) assert.equal(texts(tokenizeLine(line)).join(''), shown);
});

test('tokenizeLine: decomposed Hangul is normalized', () => {
  const decomposed = '한글'.normalize('NFD');
  assert.deepEqual(texts(tokenizeLine(decomposed)), ['한', '글']);
});

// ---------------------------------------------------------------- parseLyricText

test('parseLyricText ignores empty lines, comments, section tags and token-less lines', () => {
  const parsed = parseLyricText('[1절]\n# 메모\n\n반짝 반짝\r\n  [Chorus]  \n...\n높은 음\r~');
  assert.equal(parsed.length, 3);
  assert.deepEqual(texts(parsed[0].tokens), ['반', '짝 ', '반', '짝']);
  assert.deepEqual(texts(parsed[1].tokens), ['높', '은 ', '음']);
  assert.deepEqual(parsed[2].tokens, [EXT]);
  assert.deepEqual(parseLyricText(''), []);
  assert.deepEqual(parseLyricText(undefined), []);
});

// ---------------------------------------------------------------- groupNoteEvents

test('groupNoteEvents groups near-simultaneous onsets', () => {
  const notes = [
    { t: 0, d: 0.5, m: 60 },
    { t: 0.02, d: 1, m: 64 },
    { t: 0.5, d: 0.4, m: 62 },
    { t: 0.53, d: 0.2, m: 65 },
    { t: 0.6, d: 0.2, m: 67 },
  ];
  const ev = groupNoteEvents(notes);
  assert.equal(ev.length, 3);
  assert.deepEqual(ev[0], { t: 0, end: 1.02, idx: [0, 1] });
  assert.deepEqual(ev[1].idx, [2, 3]);
  close(ev[1].end, 0.9);
  assert.deepEqual(ev[2].idx, [4]);
  assert.deepEqual(groupNoteEvents([]), []);
  assert.equal(groupNoteEvents(notes, 0.2).length, 2);
});

// ---------------------------------------------------------------- assignLyrics

test('assignLyrics: one syllable per note event', () => {
  const notes = seq(4);
  const { lines, warnings, stats } = assignLyrics('반짝 반짝', notes);
  assert.deepEqual(warnings, []);
  assert.deepEqual(stats, { syllables: 4, events: 4, used: 4 });
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].syllables, [
    { text: '반', t: 0, d: 0.4 },
    { text: '짝 ', t: 0.5, d: 0.4 },
    { text: '반', t: 1, d: 0.4 },
    { text: '짝', t: 1.5, d: 0.4 },
  ]);
});

test('assignLyrics: lines are split as in the text, chords count once', () => {
  const notes = [
    { t: 0, d: 0.4, m: 60 }, { t: 0, d: 0.4, m: 64 },
    { t: 0.5, d: 0.4, m: 62 },
    { t: 1, d: 0.4, m: 64 },
  ];
  const { lines, warnings } = assignLyrics('하나\n둘', notes);
  assert.deepEqual(warnings, []);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].syllables.map((s) => s.t), [0, 0.5]);
  assert.deepEqual(lines[1].syllables, [{ text: '둘', t: 1, d: 0.4 }]);
});

test('assignLyrics: ext extends the previous syllable over the next event', () => {
  const { lines, warnings, stats } = assignLyrics('사~랑해', seq(4));
  assert.deepEqual(warnings, []);
  assert.deepEqual(stats, { syllables: 3, events: 4, used: 4 });
  assert.deepEqual(lines[0].syllables, [
    { text: '사', t: 0, d: 0.9 },
    { text: '랑', t: 1, d: 0.4 },
    { text: '해', t: 1.5, d: 0.4 },
  ]);
});

test('assignLyrics: ext at line start acts like skip; skip consumes an event', () => {
  const { lines, warnings, stats } = assignLyrics('하나\n~둘_셋', seq(6));
  assert.deepEqual(warnings, []);
  assert.deepEqual(stats, { syllables: 4, events: 6, used: 6 });
  assert.deepEqual(lines[1].syllables, [
    { text: '둘', t: 1.5, d: 0.4 },
    { text: '셋', t: 2.5, d: 0.4 },
  ]);
  const r = assignLyrics('_ 하나', seq(3));
  assert.deepEqual(r.lines[0].syllables.map((s) => s.t), [0.5, 1]);
});

test('assignLyrics: ext does not cross into the next line', () => {
  const { lines } = assignLyrics('하\n~나', seq(3));
  assert.deepEqual(lines[0].syllables, [{ text: '하', t: 0, d: 0.4 }]);
  assert.deepEqual(lines[1].syllables, [{ text: '나', t: 1, d: 0.4 }]);
});

test('assignLyrics: overflow syllables go after the last used time, 0.4 s each', () => {
  const { lines, warnings, stats } = assignLyrics('하나둘\n셋넷', seq(2, 1, 0.5));
  assert.deepEqual(warnings, ['가사 음절이 노트보다 3개 많아요. 남는 가사는 마지막 노트 뒤에 배치됩니다.']);
  assert.deepEqual(stats, { syllables: 5, events: 2, used: 2 });
  assert.deepEqual(lines[0].syllables, [
    { text: '하', t: 0, d: 0.5 },
    { text: '나', t: 1, d: 0.5 },
    { text: '둘', t: 1.5, d: 0.4 },
  ]);
  assert.deepEqual(lines[1].syllables, [
    { text: '셋', t: 1.9, d: 0.4 },
    { text: '넷', t: 2.3, d: 0.4 },
  ]);
});

test('assignLyrics: unused note events are reported', () => {
  const { lines, warnings, stats } = assignLyrics('하나', seq(5));
  assert.deepEqual(warnings, ['가사가 없는 노트가 3개 있어요.']);
  assert.deepEqual(stats, { syllables: 2, events: 5, used: 2 });
  assert.equal(lines[0].syllables.length, 2);
});

test('assignLyrics: no notes → 0.5 s placeholder timing + warning', () => {
  const { lines, warnings, stats } = assignLyrics('하나\n둘', []);
  assert.deepEqual(warnings, ['노트가 없어 가사를 임시 시간으로 배치했어요.']);
  assert.deepEqual(stats, { syllables: 3, events: 0, used: 0 });
  assert.deepEqual(lines, [
    { syllables: [{ text: '하', t: 0, d: 0.5 }, { text: '나', t: 0.5, d: 0.5 }] },
    { syllables: [{ text: '둘', t: 1, d: 0.5 }] },
  ]);
});

test('assignLyrics: empty text gives no lines and no warnings', () => {
  assert.deepEqual(assignLyrics('', seq(3)), { lines: [], warnings: [], stats: { syllables: 0, events: 3, used: 0 } });
  assert.deepEqual(assignLyrics('', []), { lines: [], warnings: [], stats: { syllables: 0, events: 0, used: 0 } });
});

test('assignLyrics: minimum syllable duration and unsorted notes', () => {
  const notes = [{ t: 1, d: 0.01, m: 62 }, { t: 0, d: 0.3, m: 60 }];
  const { lines } = assignLyrics('도레', notes);
  assert.deepEqual(lines[0].syllables, [
    { text: '도', t: 0, d: 0.3 },
    { text: '레', t: 1, d: 0.05 },
  ]);
});

// ---------------------------------------------------------------- solfegeLyricText

test('solfegeLyricText: names, chord top note, breaks on gaps and every 8', () => {
  const ms = [60, 62, 64, 65, 67, 69, 71, 72, 74];
  const notes = ms.map((m, i) => ({ t: i * 0.5, d: 0.45, m }));
  notes.push({ t: 0, d: 0.45, m: 55 }); // chord under the first note
  notes.push({ t: 6, d: 0.5, m: 61 }); // after a gap ≥ 0.6 s
  notes.push({ t: 6.5, d: 0.5, m: 66 });
  const text = solfegeLyricText(notes);
  assert.equal(text, '도 레 미 파 솔 라 시 도\n레\n도# 파#');
  const { warnings, stats } = assignLyrics(text, notes);
  assert.deepEqual(warnings, []);
  assert.equal(stats.used, stats.events);
  assert.equal(solfegeLyricText([]), '');
});

// ---------------------------------------------------------------- helpers

test('lineStart / lineEnd / lyricsPlainText', () => {
  const lines = [
    { syllables: [{ text: '반', t: 1, d: 2 }, { text: '짝 ', t: 1.5, d: 0.2 }, { text: '별', t: 2, d: 0.5 }] },
    { syllables: [{ text: 'hi', t: 4, d: 1 }] },
  ];
  assert.equal(lineStart(lines[0]), 1);
  assert.equal(lineEnd(lines[0]), 3);
  assert.equal(lineEnd({ syllables: [] }), 0);
  assert.equal(lyricsPlainText(lines), '반짝 별\nhi');
  assert.equal(lyricsPlainText([]), '');
});

// ---------------------------------------------------------------- LRC

test('formatLrcTime', () => {
  assert.equal(formatLrcTime(65.5), '01:05.50');
  assert.equal(formatLrcTime(0), '00:00.00');
  assert.equal(formatLrcTime(3.456), '00:03.46');
  assert.equal(formatLrcTime(59.999), '01:00.00');
  assert.equal(formatLrcTime(-1), '00:00.00');
  assert.equal(formatLrcTime(6000), '100:00.00');
});

test('parseLRC: line stamps, metadata, durations (90% of min(next−start, 10 s), last 4 s)', () => {
  const lrc = '\uFEFF[ti:건반 산책]\r\n[ar:오리지널]\n[al:연습곡]\n[by:someone]\n'
    + '[00:01.00]반짝 반짝\n[00:03.000]높은 음\n[00:20]천천히요\n[00:22.5]걸어요';
  const { lines, meta, wordTimed } = parseLRC(lrc);
  assert.equal(wordTimed, false);
  assert.deepEqual(meta, { offset: 0, ti: '건반 산책', ar: '오리지널', al: '연습곡' });
  assert.equal(lines.length, 4);
  assert.equal(lyricsPlainText(lines), '반짝 반짝\n높은 음\n천천히요\n걸어요');
  // line 1: 2 s → 1.8 s over 4 syllables
  assert.deepEqual(lines[0].syllables.map((s) => s.t), [1, 1.45, 1.9, 2.35]);
  lines[0].syllables.forEach((s) => close(s.d, 0.45));
  // line 2: next start 17 s away → capped at 10 s → 9 s / 3
  assert.deepEqual(lines[1].syllables.map((s) => s.t), [3, 6, 9]);
  close(lines[1].syllables[0].d, 3);
  // line 3: 2.5 s → 2.25 / 4
  close(lines[2].syllables[1].t, 20.5625, 0.001);
  // last line: 4 s → 3.6 / 3
  assert.deepEqual(lines[3].syllables.map((s) => s.t), [22.5, 23.7, 24.9]);
  close(lines[3].syllables[2].d, 1.2);
});

test('parseLRC: multiple stamps per line duplicate it; output sorted by time', () => {
  const { lines } = parseLRC('[00:10.00][00:02.00]후렴\n[00:05.00]절\n[00:12.00]끝');
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((l) => [lineStart(l), lyricsPlainText([l])]), [[2, '후렴'], [5, '절'], [10, '후렴'], [12, '끝']]);
  // first copy lasts until 5 s, second until 12 s
  close(lines[0].syllables[1].t, 2 + 1.35);
  close(lines[2].syllables[1].t, 10 + 0.9);
});

test('parseLRC: [offset:+ms] moves lyrics earlier, negative later', () => {
  const a = parseLRC('[offset:+500]\n[00:02.00]가\n[00:04.00]나');
  assert.equal(a.meta.offset, 0.5);
  assert.equal(a.lines[0].syllables[0].t, 1.5);
  assert.equal(a.lines[1].syllables[0].t, 3.5);
  const b = parseLRC('[00:02.00]가\n[offset:-250]');
  assert.equal(b.meta.offset, -0.25);
  assert.equal(b.lines[0].syllables[0].t, 2.25);
});

test('parseLRC: empty-text lines only terminate the previous line', () => {
  const { lines } = parseLRC('[00:01.00]하나 둘\n[00:02.00]\n[00:10.00]셋');
  assert.equal(lines.length, 2);
  // 1 s → 0.9 s over 3 syllables
  close(lines[0].syllables[2].t, 1.6);
  close(lines[0].syllables[2].d, 0.3);
  assert.equal(lines[1].syllables[0].t, 10);
});

test('parseLRC: enhanced word stamps (segments split evenly, spacing kept)', () => {
  const lrc = '[00:01.00]<00:01.00>반짝 <00:01.50>반짝<00:02.50> <00:03.00>Twin<00:03.40>kle<00:04.00>\n'
    + '[00:05.00]<00:05.00>사<00:05.20>랑해 <00:06.00>요';
  const { lines, wordTimed } = parseLRC(lrc);
  assert.equal(wordTimed, true);
  assert.equal(lines.length, 2);
  const s = lines[0].syllables;
  assert.deepEqual(s.map((x) => x.text), ['반', '짝 ', '반', '짝 ', 'Twin', 'kle']);
  assert.deepEqual(s.map((x) => x.t), [1, 1.25, 1.5, 2, 3, 3.4]);
  assert.deepEqual(s.map((x) => x.d), [0.25, 0.25, 0.5, 0.5, 0.4, 0.6]);
  const s2 = lines[1].syllables;
  assert.deepEqual(s2.map((x) => x.text), ['사', '랑', '해 ', '요']);
  assert.deepEqual(s2.map((x) => x.t), [5, 5.2, 5.6, 6]);
  close(s2[1].d, 0.4);
  // last segment without an end stamp lasts until the line limit (last line: start + 4 s)
  close(s2[3].d, 3);
});

test('parseLRC: markers in LRC text are ignored; unstamped lines skipped', () => {
  const { lines } = parseLRC('그냥 텍스트\n[00:01.00]사~랑_해\n[xx:yy]무시');
  assert.equal(lines.length, 1);
  assert.equal(lyricsPlainText(lines), '사랑해');
  assert.deepEqual(parseLRC(''), { lines: [], meta: { offset: 0 }, wordTimed: false });
  assert.deepEqual(parseLRC(null).lines, []);
});

test('toLRC: enhanced format with header', () => {
  const lines = [{ syllables: [{ text: '반', t: 1, d: 0.5 }, { text: '짝 ', t: 1.5, d: 0.3 }, { text: '별', t: 2, d: 0.5 }] }];
  const out = toLRC(lines, { ti: '건반 산책', ar: '오리지널', offset: 1 });
  assert.equal(out, '[ti:건반 산책]\n[ar:오리지널]\n[00:01.00]<00:01.00>반<00:01.50>짝 <00:01.80><00:02.00>별<00:02.50>');
  assert.equal(toLRC([]), '');
});

test('toLRC → parseLRC round trip (assigned lyrics)', () => {
  const notes = [];
  for (let i = 0; i < 18; i++) notes.push({ t: 1 + i * 0.6, d: i % 3 === 0 ? 0.6 : 0.35, m: 60 + (i % 5) });
  const text = '반짝 반짝 빛나요\n(손끝으로) 톡톡 톡,\nPlay it a-gain!';
  const { lines, warnings } = assignLyrics(text, notes);
  assert.deepEqual(warnings, []);
  const lrc = toLRC(lines, { ti: '테스트' });
  const back = parseLRC(lrc);
  assert.equal(back.wordTimed, true);
  assert.equal(back.meta.ti, '테스트');
  assert.equal(back.lines.length, lines.length);
  assert.equal(lyricsPlainText(back.lines), lyricsPlainText(lines));
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i].syllables;
    const b = back.lines[i].syllables;
    assert.equal(b.length, a.length);
    for (let k = 0; k < a.length; k++) {
      assert.equal(b[k].text, a[k].text);
      close(b[k].t, a[k].t, 0.0051);
      close(b[k].d, a[k].d, 0.011);
    }
  }
});

test('toLRC → parseLRC round trip (overlapping/irregular syllables keep start times)', () => {
  const lines = [
    { syllables: [{ text: 'a', t: 0.123, d: 0.9 }, { text: 'b ', t: 0.5, d: 0.2 }, { text: '가', t: 0.71, d: 0.05 }] },
  ];
  const back = parseLRC(toLRC(lines));
  assert.deepEqual(back.lines[0].syllables.map((s) => s.text), ['a', 'b ', '가']);
  back.lines[0].syllables.forEach((s, k) => close(s.t, lines[0].syllables[k].t, 0.0051));
  close(back.lines[0].syllables[0].d, 0.38, 0.011); // truncated at the next syllable
});

// ---------------------------------------------------------------- brace groups

test('tokenizeLine: {…} groups several syllables into one (braces hidden, inner text verbatim)', () => {
  assert.deepEqual(tokenizeLine('{abc def} 가{나다}라'), [syl('abc def '), syl('가'), syl('나다'), syl('라')]);
  assert.deepEqual(tokenizeLine('{하나 둘}'), [syl('하나 둘')]);
  assert.deepEqual(tokenizeLine('la {so  far} away'), [syl('la '), syl('so  far '), syl('away')]);
  assert.deepEqual(tokenizeLine('{ 하나 둘 }~ 셋'), [syl('하나 둘 '), EXT, syl('셋')]);
  assert.deepEqual(texts(tokenizeLine('({a b})! c')), ['(a b)! ', 'c']);
  assert.deepEqual(texts(tokenizeLine('Hap-py {a b}{c d}')), ['Hap', 'py ', 'a b', 'c d']);
  assert.deepEqual(texts(tokenizeLine('{a~b_c}')), ['a~b_c']); // markers inside a group are literal
});

test('tokenizeLine: unclosed { groups the rest of the line; single-syllable braces stay punctuation', () => {
  assert.deepEqual(tokenizeLine('x {hello world'), [syl('x '), syl('hello world')]);
  assert.deepEqual(tokenizeLine('하 {나둘셋'), [syl('하 '), syl('나둘셋')]);
  assert.deepEqual(texts(tokenizeLine('[오] {예}')), ['[오] ', '{예}']);
  assert.deepEqual(texts(tokenizeLine('{la} li')), ['{la} ', 'li']);
});

test('assignLyrics: a {group} consumes exactly one note event', () => {
  const res = assignLyrics('{하나 둘} 셋\n{la la}~ _ li', seq(6));
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(res.stats, { syllables: 4, events: 6, used: 6 });
  assert.deepEqual(res.lines.map((l) => l.syllables.map((s) => [s.text, s.t])), [
    [['하나 둘 ', 0], ['셋', 0.5]],
    [['la la ', 1], ['li', 2.5]],
  ]);
  close(res.lines[1].syllables[0].d, 0.9);
  assert.equal(lyricsPlainText(res.lines), '하나 둘 셋\nla la li');
});

test('toLRC → parseLRC keeps a grouped syllable as one syllable', () => {
  const { lines } = assignLyrics('{하나 둘} 셋 {so far}', seq(3));
  const lrc = toLRC(lines);
  assert.ok(lrc.includes('{하나 둘} '));
  const back = parseLRC(lrc);
  assert.deepEqual(back.lines[0].syllables.map((s) => s.text), ['하나 둘 ', '셋 ', 'so far']);
  back.lines[0].syllables.forEach((s, i) => {
    close(s.t, lines[0].syllables[i].t, 0.006);
    close(s.d, lines[0].syllables[i].d, 0.011);
  });
});
