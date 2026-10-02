// Generates the PWA icons (icons/icon-192.png, icons/icon-512.png, icons/icon-maskable-512.png) with no dependencies.
// Usage: node tools/make-icons.mjs
// The icon is drawn analytically (gradient rounded square, falling note bars, hit line, piano keys) with 4×4
// supersampling and encoded as an RGBA PNG using node:zlib.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../icons/', import.meta.url));

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- drawing

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const C_VIOLET = hex('#7c5cff');
const C_BLUE = hex('#5b7cfa');
const C_CYAN = hex('#22d3ee');
const C_WHITE = [255, 255, 255];
const C_KEY = hex('#f6f7ff');
const C_KEY_SHADE = hex('#d7dcf3');
const C_BLACK = hex('#141833');
const C_NOTE = hex('#e6fbff');
const C_NOTE_2 = hex('#9eefff');
const C_GOLD = hex('#ffd84d');
const C_GOLD_2 = hex('#ffb020');

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Painter: straight-alpha "over" compositing into [r, g, b, a].
function over(dst, rgb, a) {
  if (a <= 0) return;
  const outA = a + dst[3] * (1 - a);
  if (outA <= 0) return;
  for (let i = 0; i < 3; i++) dst[i] = (rgb[i] * a + dst[i] * dst[3] * (1 - a)) / outA;
  dst[3] = outA;
}

// Content layout in unit coordinates of the "any" icon.
const KB = { x0: 0.17, x1: 0.83, y0: 0.62, y1: 0.85 };
const WHITE_KEYS = 7;
const KW = (KB.x1 - KB.x0) / WHITE_KEYS;
const BLACK_AFTER = [0, 1, 3, 4, 5]; // C#, D#, F#, G#, A#
const HIT_Y = 0.585;
const NOTES = [
  { key: 0, y0: 0.4, y1: 0.555, gold: false },
  { key: 2, y0: 0.19, y1: 0.33, gold: false },
  { key: 4, y0: 0.29, y1: 0.5, gold: true },
  { key: 6, y0: 0.11, y1: 0.24, gold: false },
];

function background(u, v, maskable) {
  // Diagonal violet → blue → cyan gradient with a soft highlight and darker bottom.
  const t = Math.min(1, Math.max(0, (u * 0.55 + v * 0.75) / 1.3));
  let c = t < 0.5 ? mix(C_VIOLET, C_BLUE, t / 0.5) : mix(C_BLUE, C_CYAN, (t - 0.5) / 0.5);
  const hx = u - 0.22;
  const hy = v - 0.08;
  const hd = Math.sqrt(hx * hx + hy * hy);
  const hl = Math.max(0, 1 - hd / 0.75);
  c = mix(c, C_WHITE, 0.16 * hl * hl);
  c = mix(c, [10, 12, 30], 0.18 * Math.max(0, v - 0.55) / 0.45);
  if (maskable) return { rgb: c, a: 1 };
  return { rgb: c, a: inRoundRect(u, v, 0, 0, 1, 1, 0.225) ? 1 : 0 };
}

function drawContent(px, x, y) {
  // Dark plate behind the keyboard.
  if (inRoundRect(x, y, KB.x0 - 0.025, KB.y0 - 0.025, KB.x1 + 0.025, KB.y1 + 0.025, 0.04)) {
    over(px, [11, 13, 23], 0.55);
  }

  // Hit line glow + line.
  if (x >= KB.x0 - 0.02 && x <= KB.x1 + 0.02) {
    const dy = Math.abs(y - HIT_Y);
    if (dy < 0.045) over(px, C_WHITE, 0.28 * Math.pow(1 - dy / 0.045, 2));
    if (dy < 0.0075) over(px, C_WHITE, 0.95);
  }

  // Falling note bars.
  for (const n of NOTES) {
    const nx0 = KB.x0 + n.key * KW + 0.012;
    const nx1 = KB.x0 + (n.key + 1) * KW - 0.012;
    if (inRoundRect(x, y, nx0, n.y0, nx1, n.y1, 0.022)) {
      const g = (y - n.y0) / (n.y1 - n.y0);
      over(px, n.gold ? mix(C_GOLD, C_GOLD_2, g) : mix(C_NOTE, C_NOTE_2, g), 0.97);
    }
  }

  // Sparkle where the lowest note meets the hit line (astroid star).
  const sx = KB.x0 + 0.5 * KW;
  const sy = HIT_Y;
  const ax = Math.abs(x - sx);
  const ay = Math.abs(y - sy);
  const r = 0.06;
  if (Math.sqrt(ax) + Math.sqrt(ay) < Math.sqrt(r)) over(px, C_WHITE, 1);

  // White keys.
  for (let k = 0; k < WHITE_KEYS; k++) {
    const kx0 = KB.x0 + k * KW + 0.004;
    const kx1 = KB.x0 + (k + 1) * KW - 0.004;
    if (x >= kx0 && x <= kx1 && y >= KB.y0 && inRoundRect(x, y, kx0, KB.y0 - 0.03, kx1, KB.y1, 0.016)) {
      const g = (y - KB.y0) / (KB.y1 - KB.y0);
      const lit = k === 0 || k === 4; // keys being "played"
      let c = mix(C_KEY, C_KEY_SHADE, g * g);
      if (lit) c = mix(c, k === 4 ? C_GOLD : C_NOTE_2, 0.45);
      over(px, c, 1);
    }
  }

  // Black keys.
  const bh = (KB.y1 - KB.y0) * 0.6;
  const bw = KW * 0.58;
  for (const i of BLACK_AFTER) {
    const cx = KB.x0 + (i + 1) * KW;
    if (inRoundRect(x, y, cx - bw / 2, KB.y0 - 0.02, cx + bw / 2, KB.y0 + bh, 0.012) && y >= KB.y0) {
      over(px, C_BLACK, 1);
    }
  }
}

function render(size, maskable) {
  const SS = 4;
  const scale = maskable ? 0.8 : 1; // maskable: keep artwork inside the 80% safe zone
  const out = Buffer.alloc(size * size * 4);
  const px = [0, 0, 0, 0];
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (pxi + (sx + 0.5) / SS) / size;
          const v = (py + (sy + 0.5) / SS) / size;
          const bg = background(u, v, maskable);
          px[0] = bg.rgb[0];
          px[1] = bg.rgb[1];
          px[2] = bg.rgb[2];
          px[3] = bg.a;
          if (bg.a > 0) {
            const cx = (u - 0.5) / scale + 0.5;
            const cy = (v - 0.5) / scale + 0.5;
            drawContent(px, cx, cy);
          }
          ar += px[0] * px[3];
          ag += px[1] * px[3];
          ab += px[2] * px[3];
          aa += px[3];
        }
      }
      const o = (py * size + pxi) * 4;
      if (aa > 0) {
        out[o] = Math.round(Math.min(255, ar / aa));
        out[o + 1] = Math.round(Math.min(255, ag / aa));
        out[o + 2] = Math.round(Math.min(255, ab / aa));
      }
      out[o + 3] = Math.round(Math.min(255, (aa / (SS * SS)) * 255));
    }
  }
  return encodePng(size, size, out);
}

mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
];
for (const [name, size, maskable] of targets) {
  const png = render(size, maskable);
  writeFileSync(new URL(name, new URL('../icons/', import.meta.url)), png);
  console.log(`icons/${name}  ${size}×${size}  ${png.length} bytes`);
}
