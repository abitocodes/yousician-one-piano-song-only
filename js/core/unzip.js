// Minimal ZIP reader (central directory based) for compressed MusicXML (.mxl) files.
// Supports stored (0) and deflate (8) entries; deflate uses the platform DecompressionStream.

const ERR_BAD_ZIP = '압축 파일을 읽을 수 없어요.';
const ERR_NO_INFLATE = '이 브라우저는 압축된 악보(.mxl)를 풀 수 없어요. 압축하지 않은 .musicxml 파일을 사용해 주세요.';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  const tag = Object.prototype.toString.call(input);
  if (input instanceof ArrayBuffer || tag === '[object ArrayBuffer]') return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error(ERR_BAD_ZIP);
}

const u16 = (b, p) => b[p] | (b[p + 1] << 8);
const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 0x1000000;
const u64 = (b, p) => u32(b, p) + u32(b, p + 4) * 0x100000000;

function findEocd(b) {
  const stop = Math.max(0, b.length - EOCD_MIN - MAX_COMMENT);
  for (let p = b.length - EOCD_MIN; p >= stop; p--) {
    if (b[p] === 0x50 && b[p + 1] === 0x4b && u32(b, p) === SIG_EOCD) return p;
  }
  return -1;
}

function decodeName(bytes, utf8Flag) {
  const encodings = utf8Flag ? ['utf-8'] : ['utf-8', 'euc-kr', 'latin1'];
  for (const enc of encodings) {
    try {
      return new TextDecoder(enc, { fatal: enc !== 'latin1' && !utf8Flag }).decode(bytes);
    } catch {
      // try the next encoding
    }
  }
  return String.fromCharCode(...bytes);
}

// Reads ZIP64 values for fields saturated at 0xFFFF / 0xFFFFFFFF from the 0x0001 extra field.
function applyZip64Extra(b, start, end, entry) {
  let p = start;
  while (p + 4 <= end) {
    const id = u16(b, p);
    const size = u16(b, p + 2);
    const body = p + 4;
    if (id === 0x0001) {
      let q = body;
      const limit = Math.min(body + size, end);
      if (entry.size === 0xffffffff && q + 8 <= limit) { entry.size = u64(b, q); q += 8; }
      if (entry.csize === 0xffffffff && q + 8 <= limit) { entry.csize = u64(b, q); q += 8; }
      if (entry.offset === 0xffffffff && q + 8 <= limit) { entry.offset = u64(b, q); }
      return;
    }
    p = body + size;
  }
}

function readDirectory(b) {
  const eocd = findEocd(b);
  if (eocd < 0) throw new Error(ERR_BAD_ZIP);
  let count = u16(b, eocd + 10);
  let cdSize = u32(b, eocd + 12);
  let cdOffset = u32(b, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && u32(b, loc) === SIG_EOCD64_LOCATOR) {
      const p = u64(b, loc + 8);
      if (p + 56 <= b.length && u32(b, p) === SIG_EOCD64) {
        count = u64(b, p + 32);
        cdSize = u64(b, p + 40);
        cdOffset = u64(b, p + 48);
      }
    }
  }
  // Tolerate archives with data prepended (self-extractors): then the directory sits right before
  // the EOCD and every stored offset is shifted by the same amount.
  let shift = 0;
  if (count > 0 && !(cdOffset + 4 <= b.length && u32(b, cdOffset) === SIG_CENTRAL)) {
    const alt = eocd - cdSize;
    if (alt >= 0 && alt + 4 <= b.length && u32(b, alt) === SIG_CENTRAL) shift = alt - cdOffset;
    else throw new Error(ERR_BAD_ZIP);
  }

  const entries = [];
  let p = cdOffset + shift;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || u32(b, p) !== SIG_CENTRAL) {
      if (entries.length) break; // truncated directory: keep what was read
      throw new Error(ERR_BAD_ZIP);
    }
    const flags = u16(b, p + 8);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const nameStart = p + 46;
    const extraStart = nameStart + nameLen;
    if (extraStart + extraLen > b.length) throw new Error(ERR_BAD_ZIP);
    const entry = {
      name: decodeName(b.subarray(nameStart, extraStart), (flags & FLAG_UTF8) !== 0),
      flags,
      method: u16(b, p + 10),
      csize: u32(b, p + 20),
      size: u32(b, p + 24),
      offset: u32(b, p + 42) + shift,
    };
    applyZip64Extra(b, extraStart, extraStart + extraLen, entry);
    entries.push(entry);
    p = extraStart + extraLen + commentLen;
  }
  return entries;
}

function entryData(b, entry) {
  const p = entry.offset;
  if (p + 30 > b.length || u32(b, p) !== SIG_LOCAL) throw new Error(ERR_BAD_ZIP);
  const start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
  const end = start + entry.csize;
  if (end > b.length) throw new Error(ERR_BAD_ZIP);
  return b.subarray(start, end);
}

async function inflateRaw(data) {
  if (typeof DecompressionStream !== 'function') throw new Error(ERR_NO_INFLATE);
  let ds;
  try {
    ds = new DecompressionStream('deflate-raw');
  } catch {
    throw new Error(ERR_NO_INFLATE);
  }
  const writer = ds.writable.getWriter();
  writer.write(data).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch {
    throw new Error(ERR_BAD_ZIP);
  }
  const out = new Uint8Array(total);
  let q = 0;
  for (const c of chunks) {
    out.set(c, q);
    q += c.length;
  }
  return out;
}

/**
 * Extracts every file of a ZIP archive → Map<path, Uint8Array>.
 * Directories are skipped; entries with unsupported compression methods are left out.
 * Throws Error('압축 파일을 읽을 수 없어요.') for anything that is not a readable ZIP.
 */
export async function unzip(bytes) {
  const b = toBytes(bytes);
  const entries = readDirectory(b);
  const files = new Map();
  for (const entry of entries) {
    if (!entry.name || entry.name.endsWith('/') || entry.name.endsWith('\\')) continue;
    if (entry.flags & FLAG_ENCRYPTED) throw new Error(ERR_BAD_ZIP);
    if (entry.method !== 0 && entry.method !== 8) continue;
    const raw = entryData(b, entry);
    const data = entry.method === 0 ? raw.slice() : await inflateRaw(raw);
    files.set(entry.name.replace(/\\/g, '/'), data);
  }
  return files;
}
