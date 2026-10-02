import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzip } from '../js/core/unzip.js';
import { makeZip } from './helpers-zip.js';

const dec = new TextDecoder();
const BAD = { message: '압축 파일을 읽을 수 없어요.' };
const text = (files, name) => dec.decode(files.get(name));

test('unzip: stored and deflated entries, directories skipped', async () => {
  const long = '<score>'.padEnd(5000, 'x') + '</score>';
  const zip = await makeZip([
    { name: 'mimetype', data: 'application/vnd.recordare.musicxml', method: 0 },
    { name: 'META-INF', dir: true },
    { name: 'META-INF/container.xml', data: '<container/>', method: 8 },
    { name: 'score.musicxml', data: long, method: 8 },
  ]);
  const files = await unzip(zip);
  assert.deepEqual([...files.keys()], ['mimetype', 'META-INF/container.xml', 'score.musicxml']);
  assert.equal(text(files, 'mimetype'), 'application/vnd.recordare.musicxml');
  assert.equal(text(files, 'META-INF/container.xml'), '<container/>');
  assert.equal(text(files, 'score.musicxml'), long);
  assert.ok(files.get('score.musicxml') instanceof Uint8Array);
});

test('unzip: accepts ArrayBuffer and Buffer input, UTF-8 names, archive comment', async () => {
  const zip = await makeZip([{ name: '악보/노래 1.musicxml', data: '하나 둘 셋 넷' }], { comment: 'made by a test' });
  const fromBuffer = await unzip(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
  assert.equal(text(fromBuffer, '악보/노래 1.musicxml'), '하나 둘 셋 넷');
  const fromNodeBuffer = await unzip(Buffer.from(zip));
  assert.equal(text(fromNodeBuffer, '악보/노래 1.musicxml'), '하나 둘 셋 넷');
});

test('unzip: names without the UTF-8 flag still decode when they are valid UTF-8', async () => {
  const zip = await makeZip([{ name: '곡.xml', data: 'la la', utf8Flag: false, method: 0 }]);
  const files = await unzip(zip);
  assert.equal(text(files, '곡.xml'), 'la la');
});

test('unzip: tolerates bytes prepended before the archive', async () => {
  const prefix = new Uint8Array(37).fill(7);
  const proper = await makeZip([{ name: 'a.xml', data: 'one' }], { prefix });
  assert.equal(text(await unzip(proper), 'a.xml'), 'one');
  const naive = await makeZip([{ name: 'b.xml', data: 'two', method: 0 }], { prefix, prefixAware: true });
  assert.equal(text(await unzip(naive), 'b.xml'), 'two');
});

test('unzip: empty archive → empty map', async () => {
  const files = await unzip(await makeZip([]));
  assert.equal(files.size, 0);
});

test('unzip: bad input throws the Korean error', async () => {
  await assert.rejects(unzip(new Uint8Array(0)), BAD);
  await assert.rejects(unzip(new TextEncoder().encode('PK this is not really a zip file at all')), BAD);
  const zip = await makeZip([{ name: 'a.xml', data: 'x'.repeat(200) }]);
  await assert.rejects(unzip(zip.slice(0, zip.length - 30)), BAD); // EOCD cut off
  const broken = zip.slice();
  broken[0] = 0; // local header signature destroyed
  await assert.rejects(unzip(broken), BAD);
  await assert.rejects(unzip('not bytes'), BAD);
});

test('unzip: corrupt deflate data throws the Korean error', async () => {
  const zip = await makeZip([{ name: 'a.xml', data: 'hello hello hello hello', method: 8 }]);
  const bad = zip.slice();
  // Overwrite the compressed body (after the 30-byte local header + 5-byte name) with an invalid block type.
  bad.fill(0xff, 35, 40);
  await assert.rejects(unzip(bad), BAD);
});
