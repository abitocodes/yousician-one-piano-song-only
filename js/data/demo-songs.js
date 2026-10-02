// Built-in songs. Only original or public-domain content lives here; '감사' is an empty template the user fills in.

import { parseNotation } from '../core/notation.js';
import { assignLyrics } from '../core/lyrics.js';

const GAMSA_DESCRIPTION = '저작권 보호를 위해 악보와 가사는 포함되어 있지 않아요. 편집 화면에서 악보 파일 가져오기(MIDI·MusicXML)·악보 보고 입력·피아노로 녹음으로 멜로디를 만들고, 가사를 붙여넣으면 바로 연주할 수 있어요. 만든 곡은 이 기기에만 저장돼요.';

const WALK_VERSE = 'C4 E4 G4 E4 | F4 A4 G4:2 | E4 G4 C5 B4 | A4 G4:3 | F4 F4 E4 D4 | E4 G4 F4:2 | D4 E4 F4 D4 | C4:4';

const WALK_LYRICS = [
  '손끝으로 톡톡 톡',
  '소리가 피어나',
  '천천히 한 걸음씩',
  '함께 걸어요',
  '높은 음 낮은 음도',
  '모두 내 친구야',
  '틀려도 괜찮아요',
  '다시 해봐요',
].join('\n');

const TWINKLE_NOTATION = [
  'C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2',
  'G4 G4 F4 F4 | E4 E4 D4:2 | G4 G4 F4 F4 | E4 E4 D4:2',
  'C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2',
].join('\n');

const TWINKLE_LYRICS = [
  '도 도 솔 솔 라 라 솔',
  '파 파 미 미 레 레 도',
  '솔 솔 파 파 미 미 레',
  '솔 솔 파 파 미 미 레',
  '도 도 솔 솔 라 라 솔',
  '파 파 미 미 레 레 도',
].join('\n');

const DEFS = [
  {
    slug: 'gamsa',
    title: '감사',
    artist: '김동률',
    description: GAMSA_DESCRIPTION,
    bpm: 80,
    notation: '',
    lyrics: '',
    template: true,
  },
  {
    slug: 'walk',
    title: '건반 위의 산책',
    artist: '피아노 노래방 (오리지널)',
    description: '처음 시작하기 좋은 오리지널 연습곡이에요. 가운데 도부터 높은 도까지, 오른손으로 천천히 따라 쳐 보세요.',
    bpm: 96,
    notation: `${WALK_VERSE}\n${WALK_VERSE}`,
    lyrics: WALK_LYRICS,
  },
  {
    slug: 'twinkle',
    title: '작은 별 (계이름 노래)',
    artist: '프랑스 민요',
    description: '계이름을 소리 내어 부르면서 치는 연습곡이에요. 마이크 판정에 익숙해지기 좋아요.',
    bpm: 100,
    notation: TWINKLE_NOTATION,
    lyrics: TWINKLE_LYRICS,
  },
];

function buildSong(def, problems) {
  const bpm = def.bpm;
  let notes = [];
  if (def.notation.trim()) {
    const parsed = parseNotation(def.notation, { bpm, offset: 0 });
    notes = parsed.notes;
    for (const e of parsed.errors) problems.errors.push(`${def.slug}: ${e}`);
  }
  let lines = [];
  if (def.lyrics.trim()) {
    const assigned = assignLyrics(def.lyrics, notes);
    lines = assigned.lines;
    for (const w of assigned.warnings) problems.warnings.push(`${def.slug}: ${w}`);
  }
  return {
    format: 'piano-karaoke-song',
    version: 1,
    id: `builtin:${def.slug}`,
    title: def.title,
    artist: def.artist,
    description: def.description,
    bpm,
    beatsPerBar: 4,
    offset: 0,
    notes,
    lyrics: { text: def.lyrics, source: 'notes', lines },
    audio: null,
    builtin: true,
    template: !!def.template,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Builds fresh copies of the builtin songs. → { songs, warnings, errors } */
export function buildBuiltinSongs() {
  const problems = { warnings: [], errors: [] };
  const songs = DEFS.map((def) => buildSong(def, problems));
  return { songs, warnings: problems.warnings, errors: problems.errors };
}

const built = buildBuiltinSongs();
for (const msg of [...built.errors, ...built.warnings]) console.warn('[demo-songs]', msg);

export const BUILTIN_SONGS = Object.freeze(built.songs);
export const BUILTIN_IDS = Object.freeze(built.songs.map((s) => s.id));
