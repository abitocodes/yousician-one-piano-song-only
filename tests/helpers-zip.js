// Tiny ZIP writer for tests: stored (0) and deflate (8, via CompressionStream('deflate-raw')) entries.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

const enc = new TextEncoder();

/**
 * entries: [{ name, data?: string|Uint8Array, method?: 0|8, dir?: boolean, utf8Flag?: boolean }]
 * opts: { prefix?: Uint8Array (bytes prepended, like a self-extractor stub), comment?: string }
 */
export async function makeZip(entries, opts = {}) {
  const chunks = [];
  const central = [];
  let offset = opts.prefix ? opts.prefix.length : 0;
  if (opts.prefix) chunks.push(opts.prefix);
  for (const e of entries) {
    const name = enc.encode(e.dir && !e.name.endsWith('/') ? `${e.name}/` : e.name);
    const raw = e.dir ? new Uint8Array(0) : typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const method = e.dir ? 0 : e.method === undefined ? 8 : e.method;
    const body = method === 8 ? await deflateRaw(raw) : raw;
    const crc = crc32(raw);
    const flags = e.utf8Flag === false ? 0 : 0x800;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, body);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset - (opts.prefix && opts.prefixAware ? opts.prefix.length : 0), true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + body.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    chunks.push(c);
    cdSize += c.length;
  }
  const comment = enc.encode(opts.comment || '');
  const eocd = new Uint8Array(22 + comment.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart - (opts.prefix && opts.prefixAware ? opts.prefix.length : 0), true);
  ev.setUint16(20, comment.length, true);
  eocd.set(comment, 22);
  chunks.push(eocd);

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
