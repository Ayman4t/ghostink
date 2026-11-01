importScripts('robust.js');

'use strict';

const HEADER_BYTES = 42;
const MAGIC = [0x50, 0x56, 0x4c, 0x54]; // PVLT
const VERSION = 2;
const encoder = new TextEncoder();

function bytesToNibbles(bytes) {
  const nibbles = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i += 1) {
    nibbles[i * 2] = bytes[i] >>> 4;
    nibbles[i * 2 + 1] = bytes[i] & 15;
  }
  return nibbles;
}

function nibblesToBytes(nibbles) {
  const bytes = new Uint8Array(Math.ceil(nibbles.length / 2));
  for (let i = 0; i < nibbles.length; i += 1) {
    if ((i & 1) === 0) bytes[i >>> 1] = nibbles[i] << 4;
    else bytes[i >>> 1] |= nibbles[i];
  }
  return bytes;
}

function packSecret(pixels, pixelCount) {
  const nibbleCount = pixelCount * 4;
  const bytes = new Uint8Array(pixelCount * 2);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const source = pixel * 4;
    const n = pixel * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      const index = n + channel;
      const nibble = pixels[source + channel] >>> 4;
      if ((index & 1) === 0) bytes[index >>> 1] = nibble << 4;
      else bytes[index >>> 1] |= nibble;
    }
  }
  return bytes;
}

function unpackSecret(bytes, width, height) {
  const pixelCount = width * height;
  const pixels = new Uint8ClampedArray(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const n = pixel * 4;
    const target = pixel * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      const index = n + channel;
      const nibble = (index & 1) === 0 ? bytes[index >>> 1] >>> 4 : bytes[index >>> 1] & 15;
      pixels[target + channel] = nibble * 17;
    }
  }
  return pixels;
}

function unpackLegacySecret(bytes, width, height) {
  const pixelCount = width * height;
  const pixels = new Uint8ClampedArray(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const n = pixel * 3;
    const target = pixel * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const index = n + channel;
      const nibble = (index & 1) === 0 ? bytes[index >>> 1] >>> 4 : bytes[index >>> 1] & 15;
      pixels[target + channel] = nibble << 4;
    }
    pixels[target + 3] = 255;
  }
  return pixels;
}

async function deriveKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encode(message) {
  const { width, height, secretWidth, secretHeight, encrypted, password } = message;
  const cover = new Uint8ClampedArray(message.coverPixels);
  const secret = new Uint8ClampedArray(message.secretPixels);
  if (cover.length !== width * height * 4 || secret.length !== secretWidth * secretHeight * 4) throw new Error('The image data is incomplete.');

  const packed = packSecret(secret, secretWidth * secretHeight);
  const salt = new Uint8Array(16);
  const iv = new Uint8Array(12);
  let payload = packed;
  if (encrypted) {
    crypto.getRandomValues(salt);
    crypto.getRandomValues(iv);
    const key = await deriveKey(password, salt);
    payload = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, packed));
  }

  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[4] = VERSION;
  header[5] = encrypted ? 1 : 0;
  const view = new DataView(header.buffer);
  view.setUint16(6, secretWidth, false);
  view.setUint16(8, secretHeight, false);
  view.setUint32(10, payload.length, false);
  header.set(salt, 14);
  header.set(iv, 30);
  const frame = new Uint8Array(header.length + payload.length);
  frame.set(header);
  frame.set(payload, header.length);
  const frameNibbles = bytesToNibbles(frame);
  if (frameNibbles.length > width * height * 3) throw new Error('Not enough space in the cover image. Choose a larger cover or a smaller secret image.');

  let nibbleIndex = 0;
  for (let i = 0; i < cover.length; i += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const nibble = nibbleIndex < frameNibbles.length ? frameNibbles[nibbleIndex] : 0;
      cover[i + channel] = (cover[i + channel] & 0xf0) | nibble;
      nibbleIndex += 1;
    }
    cover[i + 3] = 255;
  }
  return { pixels: cover.buffer, secretWidth, secretHeight, encrypted: Boolean(encrypted) };
}

function extractNibbles(pixels, count) {
  const result = new Uint8Array(count);
  let index = 0;
  for (let i = 0; i < pixels.length && index < count; i += 4) {
    result[index++] = pixels[i] & 15;
    if (index < count) result[index++] = pixels[i + 1] & 15;
    if (index < count) result[index++] = pixels[i + 2] & 15;
  }
  return result;
}

async function decode(message) {
  const { width, height, password } = message;
  const pixels = new Uint8ClampedArray(message.pixels);
  if (pixels.length === width * height * 4) {
    const v3 = readHeaderV3(pixels, width, height);
    if (v3) return decodeV3(v3, pixels, width, height, password);
  }
  if (pixels.length !== width * height * 4 || width * height * 3 < HEADER_BYTES * 2) throw new Error('This image does not contain valid PixelVault data.');
  const headerNibbles = extractNibbles(pixels, HEADER_BYTES * 2);
  const header = nibblesToBytes(headerNibbles);
  if (!MAGIC.every((value, index) => header[index] === value)) throw new Error('No PixelVault data found. Use the original PNG file, without compression or edits.');
  const formatVersion = header[4];
  if (formatVersion !== 1 && formatVersion !== VERSION) throw new Error('This PixelVault data version is not supported.');
  const encrypted = (header[5] & 1) === 1;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const secretWidth = view.getUint16(6, false);
  const secretHeight = view.getUint16(8, false);
  const payloadLength = view.getUint32(10, false);
  const pixelCount = secretWidth * secretHeight;
  const expectedPackedLength = formatVersion === 1 ? Math.ceil(pixelCount * 3 / 2) : pixelCount * 2;
  if (!secretWidth || !secretHeight || pixelCount > 10_000_000) throw new Error('The hidden image dimensions are invalid.');
  if (payloadLength !== expectedPackedLength + (encrypted ? 16 : 0)) throw new Error('The image data structure is invalid or corrupted.');
  if ((HEADER_BYTES + payloadLength) * 2 > width * height * 3) throw new Error('The hidden image data is incomplete.');

  const frameNibbles = extractNibbles(pixels, (HEADER_BYTES + payloadLength) * 2);
  const frame = nibblesToBytes(frameNibbles);
  let payload = frame.slice(HEADER_BYTES);
  if (encrypted) {
    if (!password) throw new Error('This image is password-protected. Enter the password that was used when hiding it.');
    try {
      const salt = header.slice(14, 30);
      const iv = header.slice(30, 42);
      const key = await deriveKey(password, salt);
      payload = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, payload));
    } catch {
      throw new Error('The password is incorrect or the image data was modified.');
    }
  }
  const output = formatVersion === 1
    ? unpackLegacySecret(payload, secretWidth, secretHeight)
    : unpackSecret(payload, secretWidth, secretHeight);
  return { pixels: output.buffer, width: secretWidth, height: secretHeight, encrypted, formatVersion };
}

// ---- v3: high-quality normal mode (LSB matching, +-1 per changed sample, bits spread over the whole cover) ----
const V3 = 3;
function sampleIndex(s) { return ((s / 3) | 0) * 4 + (s % 3); }
function makeRng() { let x = 0x9e3779b9; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }
function setBit(px, idx, bit, rnd) {
  const v = px[idx];
  if ((v & 1) === bit) return;
  if (v === 0) px[idx] = 1;
  else if (v === 255) px[idx] = 254;
  else px[idx] = (rnd() & 1) ? v + 1 : v - 1;
}
function bitPosition(i, total, nbits) { return HEADER_BYTES * 8 + Math.floor(i * (total - HEADER_BYTES * 8) / nbits); }

async function encodeV3(message) {
  const { width, height, secretWidth, secretHeight, encrypted, password } = message;
  const cover = new Uint8ClampedArray(message.coverPixels);
  if (cover.length !== width * height * 4) throw new Error('The image data is incomplete.');
  let payload = new Uint8Array(message.data);
  const salt = new Uint8Array(16);
  const iv = new Uint8Array(12);
  if (encrypted) {
    crypto.getRandomValues(salt);
    crypto.getRandomValues(iv);
    const key = await deriveKey(password, salt);
    payload = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, payload));
  }
  const total = width * height * 3;
  const nbits = payload.length * 8;
  if (nbits > total - HEADER_BYTES * 8) throw new Error('Not enough space in the cover image. Choose a larger cover or a smaller secret image.');
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[4] = V3;
  header[5] = encrypted ? 1 : 0;
  const view = new DataView(header.buffer);
  view.setUint16(6, secretWidth, false);
  view.setUint16(8, secretHeight, false);
  view.setUint32(10, payload.length, false);
  header.set(salt, 14);
  header.set(iv, 30);
  const rnd = makeRng();
  for (let i = 0; i < HEADER_BYTES * 8; i += 1) setBit(cover, sampleIndex(i), (header[i >>> 3] >>> (7 - (i & 7))) & 1, rnd);
  for (let i = 0; i < nbits; i += 1) setBit(cover, sampleIndex(bitPosition(i, total, nbits)), (payload[i >>> 3] >>> (7 - (i & 7))) & 1, rnd);
  for (let i = 3; i < cover.length; i += 4) cover[i] = 255;
  return { pixels: cover.buffer, secretWidth, secretHeight, encrypted: Boolean(encrypted) };
}

function readHeaderV3(pixels, width, height) {
  if (width * height * 3 < HEADER_BYTES * 8) return null;
  const header = new Uint8Array(HEADER_BYTES);
  for (let i = 0; i < HEADER_BYTES * 8; i += 1) header[i >>> 3] |= (pixels[sampleIndex(i)] & 1) << (7 - (i & 7));
  if (!MAGIC.every((value, index) => header[index] === value) || header[4] !== V3) return null;
  return header;
}

async function decodeV3(header, pixels, width, height, password) {
  const view = new DataView(header.buffer);
  const encrypted = (header[5] & 1) === 1;
  const secretWidth = view.getUint16(6, false);
  const secretHeight = view.getUint16(8, false);
  const length = view.getUint32(10, false);
  const total = width * height * 3;
  const nbits = length * 8;
  if (!length || nbits > total - HEADER_BYTES * 8 || (encrypted && length < 17)) throw new Error('The image data structure is invalid or corrupted.');
  let payload = new Uint8Array(length);
  for (let i = 0; i < nbits; i += 1) payload[i >>> 3] |= (pixels[sampleIndex(bitPosition(i, total, nbits))] & 1) << (7 - (i & 7));
  if (encrypted) {
    if (!password) throw new Error('This image is password-protected. Enter the password that was used when hiding it.');
    try {
      const key = await deriveKey(password, header.slice(14, 30));
      payload = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: header.slice(30, 42), tagLength: 128 }, key, payload));
    } catch {
      throw new Error('The password is incorrect or the image data was modified.');
    }
  }
  return { data: payload.buffer, width: secretWidth, height: secretHeight, encrypted, formatVersion: V3 };
}

async function robustEncode(message) {
  const { width, height, encrypted, password } = message;
  const pixels = new Uint8ClampedArray(message.coverPixels);
  let data = new Uint8Array(message.data);
  if (encrypted) {
    const salt = new Uint8Array(16);
    const iv = new Uint8Array(12);
    crypto.getRandomValues(salt);
    crypto.getRandomValues(iv);
    const key = await deriveKey(password, salt);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, data));
    data = new Uint8Array(28 + cipher.length);
    data.set(salt, 0); data.set(iv, 16); data.set(cipher, 28);
  }
  const info = rbEncodeSync(pixels, width, height, data, encrypted, message.opts);
  return { pixels: pixels.buffer, repeat: info.repeat };
}

async function robustDecode(message) {
  const { width, height, password } = message;
  const pixels = new Uint8ClampedArray(message.pixels);
  const found = rbDecodeSync(pixels, width, height);
  let data = found.data;
  if (found.encrypted) {
    if (!password) throw new Error('This image is password-protected. Enter the password that was used when hiding it.');
    try {
      const key = await deriveKey(password, data.slice(0, 16));
      data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(16, 28), tagLength: 128 }, key, data.slice(28)));
    } catch {
      throw new Error('The password is incorrect or the image data was modified.');
    }
  }
  return { data: data.buffer, encrypted: found.encrypted, repeat: found.repeat };
}

self.addEventListener('message', async (event) => {
  const { id, type } = event.data;
  try {
    let result = null;
    if (type === 'encode') result = await encodeV3(event.data);
    else if (type === 'decode') result = await decode(event.data);
    else if (type === 'robustEncode') result = await robustEncode(event.data);
    else if (type === 'robustDecode') result = await robustDecode(event.data);
    else if (type === 'robustCapacity') result = { capacity: rbCapacity(event.data.width, event.data.height, event.data.repeat) };
    if (!result) throw new Error('Unknown processing request.');
    const transfers = [result.pixels, result.data].filter(Boolean);
    self.postMessage({ id, result }, transfers);
  } catch (error) {
    self.postMessage({ id, error: error.message || 'Could not process the image.' });
  }
});

    