/* PixelVault robust mode: survives JPEG recompression (e.g. WhatsApp photo sharing).
 * Hides a small JPEG thumbnail of the secret in 8x8 DCT coefficients of the cover's
 * luma, using quantization index modulation (QIM), repetition and Reed-Solomon coding.
 * Plain script: works inside the Web Worker and in Node (module.exports) for tests. */

const RB_K = 1.8;   // QIM step = RB_K x JPEG Q50 step of the coefficient (lower = less visible noise, less robust)
const RB_K_ENCODE = 2.6; // strength used by new files. Measured: 2.6 survives JPEG q32 and several re-compressions; 1.8 broke below q55, 2.4/2.8 were erratic (QIM step vs JPEG step)
const RB_CAP = 2;   // repeat count (2 = minimum; every extra repeat only adds visible noise)
const RB_NSYM = 32;   // Reed-Solomon parity bytes per 255-byte block
const JPEG_Q50 = [[16, 11, 10, 16, 24, 40, 51, 61], [12, 12, 14, 19, 26, 58, 60, 55], [14, 13, 16, 24, 40, 57, 69, 56], [14, 17, 22, 29, 51, 87, 80, 62], [18, 22, 37, 56, 68, 109, 103, 77]];
/* 13 coefficients (u = vertical, v = horizontal frequency), ordered by ascending JPEG step: the cheapest-to-hide
 * (least visible) ones are used first, so a partly-filled cover only receives the gentlest changes. */
const RB_COEFS = [[0, 2], [0, 1], [1, 1], [1, 0], [2, 1], [1, 2], [2, 0], [3, 0], [0, 3], [2, 2], [3, 1], [1, 3], [3, 2],
  /* appended after the original 13 (older files never use them): only touched when the payload needs the extra room */
  [4, 0], [4, 1], [2, 3], [0, 4], [1, 4], [3, 3]];
const RB_QSTEP = RB_COEFS.map(([u, v]) => JPEG_Q50[u][v]);
let RB_DELTAS = RB_QSTEP.map((q) => Math.round(q * RB_K * 2) / 2);
function rbSetK(k) { RB_DELTAS = RB_QSTEP.map((q) => Math.round(q * k * 2) / 2); }
const RB_K_LIST = [2.6, 1.8, 1.0]; // strengths the decoder tries, newest first (2.6 = current files, 1.8 = files made before this fix, 1.0 = legacy HQ)
const RB_HEADER_BITS = 64;
const RB_HEADER_REPEAT = 40;
const RB_HEADER_SLOTS = RB_HEADER_BITS * RB_HEADER_REPEAT;
const RB_MIN_REPEAT = 2;
const RB_MAGIC = [0x50, 0x52];       // "PR"
const RB_VERSION = 6;   // v6: Reed-Solomon bytes interleaved across blocks; v5 = 20-bit length; v4/v5 files are still readable
const RB_MAX_BYTES = 0xFFFFF;

/* ---------- Galois field + Reed-Solomon ---------- */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);
const gfDiv = (a, b) => (a === 0 ? 0 : GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255]);

function rsGenerator(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i += 1) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j += 1) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = next;
  }
  return g; // highest degree first
}

function rsEncodeBlock(msg, nsym) {
  const gen = rsGenerator(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);
  for (let i = 0; i < msg.length; i += 1) {
    const c = out[i];
    if (c !== 0) for (let j = 1; j < gen.length; j += 1) out[i + j] ^= gfMul(gen[j], c);
  }
  out.set(msg);
  return out;
}

function rsDecodeBlock(block, nsym) {
  const n = block.length;
  const S = new Array(nsym).fill(0);
  let clean = true;
  for (let j = 0; j < nsym; j += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) s = gfMul(s, GF_EXP[j]) ^ block[i];
    S[j] = s;
    if (s) clean = false;
  }
  if (clean) return block.slice(0, n - nsym);

  // Berlekamp-Massey (lowest degree first)
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let k = 0; k < nsym; k += 1) {
    let d = S[k];
    for (let i = 1; i <= L; i += 1) d ^= gfMul(C[i] || 0, S[k - i]);
    if (d === 0) { m += 1; continue; }
    const T = C.slice();
    const coef = gfDiv(d, b);
    while (C.length < B.length + m) C.push(0);
    for (let i = 0; i < B.length; i += 1) C[i + m] ^= gfMul(coef, B[i]);
    if (2 * L <= k) { L = k + 1 - L; B = T; b = d; m = 1; } else m += 1;
  }
  if (L > nsym / 2) return null;

  const positions = [];
  for (let p = 0; p < n; p += 1) {
    const xInv = GF_EXP[(255 - p) % 255];
    let v = 0, pw = 1;
    for (let i = 0; i < C.length; i += 1) { v ^= gfMul(C[i], pw); pw = gfMul(pw, xInv); }
    if (v === 0) positions.push(p);
  }
  if (positions.length !== L) return null;

  // Omega = S(x) * Lambda(x) mod x^nsym
  const omega = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i += 1) for (let j = 0; j < C.length && i + j < nsym; j += 1) omega[i + j] ^= gfMul(S[i], C[j]);
  const out = block.slice();
  for (const p of positions) {
    const x = GF_EXP[p % 255];
    const xInv = GF_EXP[(255 - p) % 255];
    let om = 0, pw = 1;
    for (let i = 0; i < omega.length; i += 1) { om ^= gfMul(omega[i], pw); pw = gfMul(pw, xInv); }
    let dv = 0;
    pw = 1;
    for (let i = 1; i < C.length; i += 2) { dv ^= gfMul(C[i], pw); pw = gfMul(pw, gfMul(xInv, xInv)); }
    if (dv === 0) return null;
    out[n - 1 - p] ^= gfMul(x, gfDiv(om, dv));
  }
  // verify
  for (let j = 0; j < nsym; j += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) s = gfMul(s, GF_EXP[j]) ^ out[i];
    if (s) return null;
  }
  return out.slice(0, n - nsym);
}

function rsEncode(data) {
  const k = 255 - RB_NSYM;
  const blocks = [];
  for (let off = 0; off < data.length; off += k) blocks.push(rsEncodeBlock(data.subarray(off, Math.min(off + k, data.length)), RB_NSYM));
  const out = new Uint8Array(blocks.reduce((sum, blk) => sum + blk.length, 0));
  let pos = 0;
  for (const blk of blocks) { out.set(blk, pos); pos += blk.length; }
  return out;
}

function rsDecode(coded, dataLength) {
  const k = 255 - RB_NSYM;
  const out = new Uint8Array(dataLength);
  let inPos = 0, outPos = 0;
  while (outPos < dataLength) {
    const m = Math.min(k, dataLength - outPos);
    const block = coded.subarray(inPos, inPos + m + RB_NSYM);
    const fixed = rsDecodeBlock(block, RB_NSYM);
    if (!fixed) throw new Error('Error correction failed: the image was damaged too much by compression.');
    out.set(fixed, outPos);
    inPos += m + RB_NSYM;
    outPos += m;
  }
  return out;
}

const rsCodedLength = (n) => n + RB_NSYM * Math.ceil(n / (255 - RB_NSYM));

/* v6: the coded bytes of all RS blocks are interleaved (byte j of every block, then byte j+1, ...). Bit errors are not
 * uniform over the payload (the first, lowest-frequency slots suffer most), so without interleaving a few blocks fail
 * while others are nearly clean. Interleaving gives every block the average error rate. */
function rsEncodeInterleaved(data) {
  const k = 255 - RB_NSYM;
  const blocks = [];
  for (let off = 0; off < data.length; off += k) blocks.push(rsEncodeBlock(data.subarray(off, Math.min(off + k, data.length)), RB_NSYM));
  const out = new Uint8Array(blocks.reduce((sum, blk) => sum + blk.length, 0));
  let pos = 0;
  for (let j = 0; j < 255; j += 1) for (const blk of blocks) if (j < blk.length) out[pos++] = blk[j];
  return out;
}
function rsDecodeInterleaved(coded, dataLength) {
  const k = 255 - RB_NSYM;
  const nb = Math.ceil(dataLength / k);
  const blocks = [];
  for (let b = 0; b < nb; b += 1) blocks.push(new Uint8Array(Math.min(k, dataLength - b * k) + RB_NSYM));
  let pos = 0;
  for (let j = 0; j < 255; j += 1) for (const blk of blocks) if (j < blk.length) blk[j] = coded[pos++];
  const out = new Uint8Array(dataLength);
  let outPos = 0;
  for (const blk of blocks) {
    const fixed = rsDecodeBlock(blk, RB_NSYM);
    if (!fixed) throw new Error('Error correction failed: the image was damaged too much by compression.');
    out.set(fixed, outPos);
    outPos += fixed.length;
  }
  return out;
}

/* ---------- DCT helpers ---------- */
const DCT = (() => {
  const m = [];
  for (let u = 0; u < 8; u += 1) {
    const row = new Float64Array(8);
    for (let x = 0; x < 8; x += 1) row[x] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    m.push(row);
  }
  return m;
})();
const BASIS = RB_COEFS.map(([u, v]) => {
  const pattern = new Float64Array(64);
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) pattern[y * 8 + x] = DCT[u][y] * DCT[v][x];
  return pattern;
});

function blockLuma(rgba, width, bx, by, out) {
  for (let y = 0; y < 8; y += 1) {
    let idx = ((by * 8 + y) * width + bx * 8) * 4;
    for (let x = 0; x < 8; x += 1, idx += 4) out[y * 8 + x] = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
  }
}
function coefficient(luma, ci) {
  const basis = BASIS[ci];
  let sum = 0;
  for (let i = 0; i < 64; i += 1) sum += luma[i] * basis[i];
  return sum;
}

/* ---------- capacity & framing ---------- */
function rbBlocks(width, height) { return Math.floor(width / 8) * Math.floor(height / 8); }
function rbSlots(width, height) { return rbBlocks(width, height) * RB_COEFS.length; }

/** Maximum number of bytes (before AES overhead) that can be embedded keeping >= minRepeat repetitions. */
function rbCapacity(width, height, minRepeat = RB_MIN_REPEAT) {
  const available = rbSlots(width, height) - RB_HEADER_SLOTS;
  if (rbBlocks(width, height) < RB_HEADER_SLOTS || available <= 0) return 0;
  const codedBytes = Math.floor(Math.floor(available / minRepeat) / 8);
  const k = 255 - RB_NSYM;
  const full = Math.floor(codedBytes / 255);
  const rest = codedBytes - full * 255;
  return Math.min(RB_MAX_BYTES, full * k + (rest > RB_NSYM ? rest - RB_NSYM : 0));
}

/* Blocks are visited in a golden-ratio order so that when the payload uses only part of the capacity the
 * changes are spread evenly over the whole picture instead of piling up in its top rows. */
const strideCache = new Map();
function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }
function blockStride(blocks) {
  let s = strideCache.get(blocks);
  if (s) return s;
  s = Math.max(1, Math.round(blocks * 0.6180339887));
  while (gcd(s, blocks) !== 1) s += 1;
  strideCache.set(blocks, s);
  return s;
}
function slotPosition(slot, blocks, blocksPerRow) {
  const block = ((slot % blocks) * blockStride(blocks)) % blocks;
  return { bx: block % blocksPerRow, by: Math.floor(block / blocksPerRow), ci: Math.floor(slot / blocks) };
}

function bytesToBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i += 1) for (let b = 0; b < 8; b += 1) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
  return bits;
}
function bitsToBytes(bits) {
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i += 1) { let v = 0; for (let b = 0; b < 8; b += 1) v = (v << 1) | bits[i * 8 + b]; bytes[i] = v; }
  return bytes;
}
function headerChecksum(h) { let s = 0; for (let i = 0; i < 6; i += 1) s = (s + h[i] * (i + 1) * 31) & 0xffff; return s; }

/** slotsPlan: list of {slot, bit}. Applies QIM changes to rgba in place. */
function embedSlots(rgba, width, height, plan) {
  const blocksPerRow = Math.floor(width / 8);
  const blocks = rbBlocks(width, height);
  const delta = new Map();
  const luma = new Float64Array(64);
  const byBlock = new Map();
  for (const item of plan) {
    const pos = slotPosition(item.slot, blocks, blocksPerRow);
    const key = pos.by * blocksPerRow + pos.bx;
    if (!byBlock.has(key)) byBlock.set(key, []);
    byBlock.get(key).push({ ci: pos.ci, bit: item.bit });
  }
  for (const [key, items] of byBlock) {
    const bx = key % blocksPerRow, by = Math.floor(key / blocksPerRow);
    blockLuma(rgba, width, bx, by, luma);
    const change = new Float64Array(64);
    for (const { ci, bit } of items) {
      const c = coefficient(luma, ci);
      const D = RB_DELTAS[ci];
      const offset = bit * D / 2;
      const target = Math.round((c - offset) / D) * D + offset;
      const d = target - c;
      const basis = BASIS[ci];
      for (let i = 0; i < 64; i += 1) change[i] += d * basis[i];
    }
    for (let y = 0; y < 8; y += 1) {
      let idx = ((by * 8 + y) * width + bx * 8) * 4;
      for (let x = 0; x < 8; x += 1, idx += 4) {
        const dv = change[y * 8 + x];
        rgba[idx] = Math.max(0, Math.min(255, Math.round(rgba[idx] + dv)));
        rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(rgba[idx + 1] + dv)));
        rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(rgba[idx + 2] + dv)));
        rgba[idx + 3] = 255;
      }
    }
  }
}

/** Reads soft values (-1..1; positive favours bit 1) for the requested slots. */
function readSoft(rgba, width, height, slots) {
  const blocksPerRow = Math.floor(width / 8);
  const blocks = rbBlocks(width, height);
  const cache = new Map();
  const result = new Float32Array(slots.length);
  for (let n = 0; n < slots.length; n += 1) {
    const pos = slotPosition(slots[n], blocks, blocksPerRow);
    const key = pos.by * blocksPerRow + pos.bx;
    let entry = cache.get(key);
    if (!entry) {
      entry = { luma: new Float64Array(64), coefs: new Float64Array(RB_COEFS.length).fill(NaN) };
      blockLuma(rgba, width, pos.bx, pos.by, entry.luma);
      if (cache.size > 4096) cache.clear();
      cache.set(key, entry);
    }
    if (Number.isNaN(entry.coefs[pos.ci])) entry.coefs[pos.ci] = coefficient(entry.luma, pos.ci);
    const c = entry.coefs[pos.ci];
    const D = RB_DELTAS[pos.ci];
    const d0 = Math.abs(c - Math.round(c / D) * D);
    const shifted = c - D / 2;
    const d1 = Math.abs(shifted - Math.round(shifted / D) * D);
    result[n] = (d0 - d1) / (D / 2);
  }
  return result;
}


/* Headroom: QIM needs pixels to move both ways. Pure black/white pixels clip and the bits hidden there are lost,
 * so when a cover has clipped areas the deepest shadows / brightest highlights are eased inward with a soft knee
 * (midtones are left exactly as they are). */
const RB_HEAD = 8;       // levels of headroom kept at 0 and 255
const RB_KNEE = 40;      // tones below RB_KNEE (or above 255 - RB_KNEE) are eased inward
const RB_CLIP_FRACTION = 0.002; // only applied when this share of samples sits at the extremes
function applyHeadroom(rgba) {
  let extreme = 0;
  const total = (rgba.length / 4) * 3;
  for (let i = 0; i < rgba.length; i += 4) for (let c = 0; c < 3; c += 1) { const v = rgba[i + c]; if (v <= 6 || v >= 249) extreme += 1; }
  if (extreme / total < RB_CLIP_FRACTION) return false;
  const lut = new Uint8Array(256);
  for (let x = 0; x < 256; x += 1) {
    let y = x;
    if (x < RB_KNEE) y = RB_HEAD + (x * (RB_KNEE - RB_HEAD)) / RB_KNEE;
    else if (x > 255 - RB_KNEE) y = 255 - RB_HEAD - ((255 - x) * (RB_KNEE - RB_HEAD)) / RB_KNEE;
    lut[x] = Math.round(y);
  }
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = lut[rgba[i]]; rgba[i + 1] = lut[rgba[i + 1]]; rgba[i + 2] = lut[rgba[i + 2]]; }
  return true;
}

function rbEncodeSync(rgba, width, height, dataBytes, encrypted, opts) {
  const kUsed = (opts && opts.k) || RB_K_ENCODE;
  const capRepeat = (opts && opts.maxRepeat) || RB_CAP;
  const minRepeat = (opts && opts.minRepeat) || RB_MIN_REPEAT;
  rbSetK(kUsed);
  if (width % 8 || height % 8) throw new Error('Cover dimensions must be multiples of 8.');
  if (dataBytes.length > RB_MAX_BYTES) throw new Error('The data is larger than the allowed limit.');
  const codedBytes = rsEncodeInterleaved(dataBytes);
  const bits = bytesToBits(codedBytes);
  const L = bits.length;
  const available = rbSlots(width, height) - RB_HEADER_SLOTS;
  const repeat = Math.min(capRepeat, Math.floor(available / L));
  if (repeat < minRepeat) throw new Error('The secret image is too large for this cover in compression-resistant mode.');

  applyHeadroom(rgba);
  const header = new Uint8Array(8);
  header[0] = RB_MAGIC[0]; header[1] = RB_MAGIC[1]; header[2] = RB_VERSION; header[3] = (encrypted ? 1 : 0) | ((repeat & 7) << 1) | ((dataBytes.length >> 16) << 4);
  header[4] = (dataBytes.length >> 8) & 255; header[5] = dataBytes.length & 255;
  const check = headerChecksum(header);
  header[6] = check >> 8; header[7] = check & 255;
  const headerBits = bytesToBits(header);

  const plan = [];
  for (let i = 0; i < RB_HEADER_BITS; i += 1) for (let k = 0; k < RB_HEADER_REPEAT; k += 1) plan.push({ slot: i + k * RB_HEADER_BITS, bit: headerBits[i] });
  for (let i = 0; i < L; i += 1) for (let k = 0; k < repeat; k += 1) plan.push({ slot: RB_HEADER_SLOTS + i + k * L, bit: bits[i] });
  embedSlots(rgba, width, height, plan);
  return { repeat, codedBytes: codedBytes.length };
}

function rbDecodeSync(rgba, width, height) {
  // The header is repeated 40x, so it often still reads at the wrong strength while the payload does not. Therefore
  // an error-correction failure must NOT stop the search: every strength is tried before giving up.
  let noData = null, damaged = null;
  for (const k of RB_K_LIST) {
    rbSetK(k);
    try { return rbDecodeOnce(rgba, width, height); } catch (error) {
      const message = error.message || '';
      if (/No PixelVault data found/.test(message)) { if (!noData) noData = error; }
      else if (/Error correction failed/.test(message)) { if (!damaged) damaged = error; }
      else throw error;
    }
  }
  throw damaged || noData;
}

function rbDecodeOnce(rgba, width, height) {
  const w = Math.floor(width / 8) * 8;
  const h = Math.floor(height / 8) * 8;
  if (rbBlocks(w, h) < RB_HEADER_SLOTS) throw new Error('The image is too small and contains no PixelVault data.');
  // re-pack to cropped width when needed
  let pixels = rgba, pw = width;
  if (w !== width) {
    pixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) pixels.set(rgba.subarray(y * width * 4, y * width * 4 + w * 4), y * w * 4);
    pw = w;
  }
  const headerSlots = Array.from({ length: RB_HEADER_SLOTS }, (_, i) => i);
  const soft = readSoft(pixels, pw, h, headerSlots);
  const headerBits = new Uint8Array(RB_HEADER_BITS);
  for (let i = 0; i < RB_HEADER_BITS; i += 1) {
    let sum = 0;
    for (let k = 0; k < RB_HEADER_REPEAT; k += 1) sum += soft[i + k * RB_HEADER_BITS];
    headerBits[i] = sum > 0 ? 1 : 0;
  }
  const header = bitsToBytes(headerBits);
  const check = headerChecksum(header);
  if (header[0] !== RB_MAGIC[0] || header[1] !== RB_MAGIC[1] || header[6] !== (check >> 8) || header[7] !== (check & 255)) {
    throw new Error('No PixelVault data found (compression-resistant). Make sure you are using an image created in "compression-resistant" mode, with the same dimensions and no cropping or enlarging.');
  }
  if (header[2] !== RB_VERSION && header[2] !== 5 && header[2] !== 4) throw new Error('This image was created with an older version of the resistant mode and cannot be read. Hide the image again with the new version.');
  const encrypted = (header[3] & 1) === 1;
  const v5 = header[2] >= 5;
  const dataLength = (v5 ? (header[3] >> 4) << 16 : 0) | (header[4] << 8) | header[5];
  const L = rsCodedLength(dataLength) * 8;
  const repeat = v5 ? (header[3] >> 1) & 7 : header[3] >> 1;
  if (!dataLength || repeat < 1) throw new Error('The data structure is corrupted.');
  const slots = [];
  for (let i = 0; i < L; i += 1) for (let k = 0; k < repeat; k += 1) slots.push(RB_HEADER_SLOTS + i + k * L);
  const values = readSoft(pixels, pw, h, slots);
  const bits = new Uint8Array(L);
  for (let i = 0; i < L; i += 1) {
    let sum = 0;
    for (let k = 0; k < repeat; k += 1) sum += values[i * repeat + k];
    bits[i] = sum > 0 ? 1 : 0;
  }
  const data = header[2] >= 6 ? rsDecodeInterleaved(bitsToBytes(bits), dataLength) : rsDecode(bitsToBytes(bits), dataLength);
  return { data, encrypted, repeat };
}

if (typeof module !== 'undefined') module.exports = { rbEncodeSync, rbDecodeSync, rbCapacity, rsEncode, rsDecode, rsEncodeInterleaved, RB_NSYM, readSoft, bytesToBits, rsCodedLength, RB_HEADER_SLOTS, rbSetK };

    