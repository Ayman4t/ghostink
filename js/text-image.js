(() => {
const $ = id => document.getElementById(id);
const toast = (msg, type = 'ok') => SS.toast(msg, type === 'err' ? 'err' : 'ok');
const MAGIC = [0x53, 0x56, 0x4C, 0x54]; // "SVLT"
const HDR = 9;       // magic(4) + flags(1) + length(4)
const ENC_OVERHEAD = 16 + 12 + 16; // salt + iv + GCM tag
const capBytes = (w, h) => Math.max(0, Math.floor(w * h * 3 / 8) - HDR);

function writeBytes(px, offset, bytes) {
  let bit = offset * 8;
  for (const b of bytes) for (let k = 7; k >= 0; k--, bit++) {
    const i = (bit / 3 | 0) * 4 + bit % 3;
    px[i] = (px[i] & 0xFE) | ((b >> k) & 1);
  }
}
function readBytes(px, offset, n) {
  const out = new Uint8Array(n); let bit = offset * 8;
  for (let j = 0; j < n; j++) { let v = 0;
    for (let k = 0; k < 8; k++, bit++) v = (v << 1) | (px[(bit / 3 | 0) * 4 + bit % 3] & 1);
    out[j] = v; }
  return out;
}
const FMAGIC = [0x53, 0x56, 0x4C, 0x4A]; // "SVLJ" — JPEG trailer: data | len(4) | flag(1) | magic(4)
function readFooter(b) {
  const n = b.length; if (n < 9 || FMAGIC.some((m, i) => b[n - 4 + i] !== m)) return null;
  const len = new DataView(b.buffer, b.byteOffset + n - 9, 4).getUint32(0); if (len > n - 9) return null;
  return { flag: b[n - 5], data: b.slice(n - 9 - len, n - 9) };
}
async function deriveKey(pw, salt) {
  if (!crypto.subtle) throw new Error('nocrypto');
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(bytes, pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(pw, salt), bytes));
  const out = new Uint8Array(28 + ct.length); out.set(salt); out.set(iv, 16); out.set(ct, 28); return out;
}
async function unseal(data, pw) {
  const key = await deriveKey(pw, data.slice(0, 16));
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(16, 28) }, key, data.slice(28)));
}
const MAX_FILE = 40 * 1024 * 1024, MAX_PX = 50e6; // keeps a huge or malicious file from freezing the tab
const imgErr = e => e.message === 'filebig' ? 'The file is larger than 40 MB.' : e.message === 'pxbig' ? 'The image dimensions are too large (maximum 50 megapixels).' : 'Could not open the image. Try another file.';
function loadImage(file) {
  return new Promise((res, rej) => {
    if (file.size > MAX_FILE) return rej(new Error('filebig'));
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { if (img.naturalWidth * img.naturalHeight > MAX_PX) { URL.revokeObjectURL(url); rej(new Error('pxbig')); } else res({ img, url }); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('badimg')); }; img.src = url;
  });
}
function toCanvas(img, flatten) {
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d', { willReadFrequently: true });
  if (flatten) { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); } // avoids premultiplied-alpha data loss
  x.drawImage(img, 0, 0); return { c, x };
}

/* ---------- Compression-resistant engine (DCT-domain QIM + repetition + soft voting) ---------- */
const RP = 5, QD = 40, COEF = [[1, 2], [2, 1], [2, 2], [1, 1]], RH = 9; // RH: 'SR'(2) flag(1) len(2) crc32(4)
const CM = Array.from({ length: 8 }, (_, u) => Array.from({ length: 8 }, (_, x) => 0.5 * (u ? 1 : Math.SQRT1_2) * Math.cos((2 * x + 1) * u * Math.PI / 16)));
const robGeom = (W, H) => { const n = (W >> 3) * (H >> 3); return { L: Math.floor(n * COEF.length / RP) }; };
const robSize = (w, h) => { const k = Math.min(1, 1280 / Math.max(w, h)); return [Math.max(8, Math.floor(w * k / 8) * 8), Math.max(8, Math.floor(h * k / 8) * 8)]; };
const robCap = (w, h) => { const [W, H] = robSize(w, h); return Math.max(0, Math.min(65535, (robGeom(W, H).L >> 3) - RH)); };
const slotGeo = (s, W) => { const bl = s >> 2, c = COEF[s & 3], n = W >> 3; return { u: c[0], v: c[1], x0: (bl % n) * 8, y0: Math.floor(bl / n) * 8 }; };
function coefAt(px, W, o) { let a = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const i = ((o.y0 + y) * W + o.x0 + x) * 4; a += (.299 * px[i] + .587 * px[i + 1] + .114 * px[i + 2]) * CM[o.u][y] * CM[o.v][x]; }
  return a; }
const qim = (c, b) => { const h = QD / 2 * b; return Math.round((c - h) / QD) * QD + h; };
function robEmbed(px, W, bits, g) {
  for (let k = 0; k < RP; k++) for (let j = 0; j < bits.length; j++) {
    const o = slotGeo(k * g.L + j, W), c = coefAt(px, W, o), d = qim(c, bits[j]) - c;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const a = Math.round(d * CM[o.u][y] * CM[o.v][x]); if (!a) continue;
      const i = ((o.y0 + y) * W + o.x0 + x) * 4; for (let ch = 0; ch < 3; ch++) px[i + ch] = Math.max(0, Math.min(255, px[i + ch] + a));
    } } }
function robRead(px, W, g, nb) { const sc = new Float64Array(nb);
  for (let k = 0; k < RP; k++) for (let j = 0; j < nb; j++) {
    const c = coefAt(px, W, slotGeo(k * g.L + j, W)), h = QD / 2;
    sc[j] += Math.abs(c - Math.round(c / QD) * QD) - Math.abs(c - (Math.round((c - h) / QD) * QD + h)); }
  return sc; }
const toBits = b => { const o = new Uint8Array(b.length * 8); b.forEach((v, i) => { for (let k = 0; k < 8; k++) o[i * 8 + k] = (v >> (7 - k)) & 1; }); return o; };
const fromScores = sc => { const o = new Uint8Array(sc.length >> 3); for (let i = 0; i < sc.length; i++) o[i >> 3] |= (sc[i] > 0 ? 1 : 0) << (7 - (i & 7)); return o; };
const crc32 = b => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (c & 1 ? 0xEDB88320 : 0); } return ~c >>> 0; };
function robExtract(img) {
  const W = (img.naturalWidth >> 3) << 3, H = (img.naturalHeight >> 3) << 3; if (W < 8 || H < 8) return null;
  const px = toCanvas(img, true).x.getImageData(0, 0, W, H).data, g = robGeom(W, H); if (g.L < RH * 8) return null;
  const h = fromScores(robRead(px, W, g, RH * 8)); if (h[0] !== 0x53 || h[1] !== 0x52) return null;
  const len = (h[3] << 8) | h[4]; if ((RH + len) * 8 > g.L) return { bad: true };
  const all = fromScores(robRead(px, W, g, (RH + len) * 8)), data = all.slice(RH);
  return crc32(data) === new DataView(all.buffer).getUint32(5) ? { flag: all[2], data } : { bad: true };
}
async function encodeRobust(data, flag) {
  if (data.length > robCap(src.img.naturalWidth, src.img.naturalHeight)) throw new Error('big');
  const [W, H] = robSize(src.img.naturalWidth, src.img.naturalHeight), c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.drawImage(src.img, 0, 0, W, H);
  const id = x.getImageData(0, 0, W, H), body = new Uint8Array(RH + data.length);
  body[0] = 0x53; body[1] = 0x52; body[2] = flag; body[3] = data.length >> 8; body[4] = data.length & 255; new DataView(body.buffer).setUint32(5, crc32(data)); body.set(data, RH);
  robEmbed(id.data, W, toBits(body), robGeom(W, H)); x.putImageData(id, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .95)), test = await new Promise(r => c.toBlob(r, 'image/jpeg', .6));
  let ok = false; try { const r = robExtract((await loadImage(test)).img); ok = !!r && !r.bad && r.data.length === data.length; } catch {}
  deliver(blob, 'vault-' + src.name.replace(/\.[^.]+$/, '') + '.jpg');
  if (ok) toast('Compression-resistance test passed.'); else toast('Compression test failed. Try a shorter message or a less detailed image.', 'err');
}

/* ---------- Tabs ---------- */
function tab(n) {
  $('ti-t1').setAttribute('aria-selected', n === 1); $('ti-t2').setAttribute('aria-selected', n === 2);
  $('ti-p1').classList.toggle('hidden', n !== 1); $('ti-p2').classList.toggle('hidden', n !== 2);
}
$('ti-t1').onclick = () => tab(1); $('ti-t2').onclick = () => tab(2);

function dropzone(dz, input, handler) {
  ['dragenter', 'dragover'].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.add('on'); }));
  ['dragleave', 'drop'].forEach(e => dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.remove('on'); }));
  dz.addEventListener('drop', ev => { const f = ev.dataTransfer.files[0]; if (f) handler(f); });
  input.onchange = () => input.files[0] && handler(input.files[0]);
}

/* ---------- Encode ---------- */
let src = null;
const robMode = () => src && $('ti-fmt').value === 'rob';
const curCap = () => !src ? 0 : robMode() ? src.capR : src.cap;
const msgBytes = () => new TextEncoder().encode($('ti-msg').value).length;
function refresh() {
  const cap = curCap(), need = msgBytes() + ($('ti-pw1').value ? ENC_OVERHEAD : 0), pct = cap ? Math.min(100, need / cap * 100) : 0;
  if (src) $('ti-cap1').textContent = cap.toLocaleString('en');
  $('ti-fmtnote').textContent = $('ti-fmt').value === 'rob' ? 'The image is scaled down to 1280 pixels at most so platforms do not resize it again, and the message is embedded with high redundancy to survive JPEG compression. Capacity is lower than PNG. Do not crop or resize the image afterwards.' : 'Hides the message in every bit of the pixels (larger capacity), but is lost if the image is re-compressed.';
  $('ti-cnt').textContent = `${msgBytes().toLocaleString('en')} / ${cap.toLocaleString('en')} bytes`;
  $('ti-pct').textContent = pct.toFixed(pct < 10 ? 2 : 1) + '%'; $('ti-bar').style.width = pct + '%';
  $('ti-bar').style.background = pct > 100 || need > cap && cap ? '#f43f5e' : 'linear-gradient(90deg,#10b981,#06b6d4)';
  $('ti-go1').disabled = !(src && msgBytes() > 0 && need <= cap);
}
dropzone($('ti-dz1'), $('ti-f1'), async f => {
  if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return toast('Unsupported format. Choose PNG, JPG or WebP.', 'err');
  try {
    const { img, url } = await loadImage(f);
    src = { img, cap: capBytes(img.naturalWidth, img.naturalHeight), name: f.name, capR: robCap(img.naturalWidth, img.naturalHeight) };
    $('ti-fmt').value = 'rob';
    $('ti-th1').src = url; $('ti-fn1').textContent = f.name; $('ti-dim1').textContent = `${img.naturalWidth} × ${img.naturalHeight}`; $('ti-cap1').textContent = src.cap.toLocaleString('en');
    $('ti-dz1e').classList.add('hidden'); $('ti-dz1p').classList.remove('hidden'); $('ti-dz1p').classList.add('flex'); refresh();
  } catch (e) { toast(imgErr(e), 'err'); }
});
$('ti-msg').oninput = refresh; $('ti-fmt').onchange = refresh; $('ti-pw1').oninput = refresh;
$('ti-go1').onclick = async () => {
  const b = $('ti-go1'), lbl = b.lastElementChild, old = lbl.textContent;
  $('ti-tip').textContent = robMode() ? 'You can send and download this image normally on Telegram or WhatsApp. Do not crop or resize it.' : 'You can share this image on WhatsApp or Telegram. Do not crop or resize it.';
  b.disabled = true; b.classList.add('busy'); lbl.textContent = 'Embedding the secret…';
  await new Promise(r => setTimeout(r, 60));
  try {
    const pw = $('ti-pw1').value; let data = new TextEncoder().encode($('ti-msg').value);
    if (pw) data = await seal(data, pw);
    if (robMode()) { await encodeRobust(data, pw ? 1 : 0); b.classList.remove('busy'); lbl.textContent = old; refresh(); return; }
    const { c, x } = toCanvas(src.img, true), id = x.getImageData(0, 0, c.width, c.height);
    if (data.length > capBytes(c.width, c.height)) throw new Error('big');
    const h = new Uint8Array(HDR); h.set(MAGIC); h[4] = pw ? 1 : 0; new DataView(h.buffer).setUint32(5, data.length);
    writeBytes(id.data, 0, h); writeBytes(id.data, HDR, data); x.putImageData(id, 0, 0);
    c.toBlob(bl => {
      deliver(bl, 'vault-' + src.name.replace(/\.[^.]+$/, '') + '.png');
    }, 'image/png');
  } catch (e) {
    toast(e.message === 'nocrypto' ? 'Encryption requires opening the page over HTTPS.' : e.message === 'big' ? 'The message is larger than the image capacity.' : 'An error occurred during processing.', 'err');
  }
  b.classList.remove('busy'); lbl.textContent = old; refresh();
};

/* ---------- Decode ---------- */
let enc = null, typing = 0;
dropzone($('ti-dz2'), $('ti-f2'), async f => {
  if (!/^image\/(png|jpeg)$/.test(f.type)) return toast('Unsupported format. Choose PNG or JPG.', 'err');
  try {
    const { img, url } = await loadImage(f); enc = { img, file: f };
    $('ti-th2').src = url; $('ti-fn2').textContent = f.name; $('ti-dz2e').classList.add('hidden'); $('ti-dz2p').classList.remove('hidden'); $('ti-dz2p').classList.add('flex'); $('ti-go2').disabled = false;
  } catch (e) { toast(imgErr(e), 'err'); }
});
function note(cls, text) { const t = $('ti-term'), s = document.createElement('span'); s.className = cls; s.textContent = text; t.textContent = ''; t.append(s); }
function show(text) {
  const t = $('ti-term'); clearTimeout(typing); t.classList.remove('scan'); t.textContent = ''; t.classList.add('caret');
  let i = 0; const chars = [...text], step = Math.max(1, Math.ceil(chars.length / 120));
  (function tick() { t.textContent += chars.slice(i, i += step).join(''); if (i < chars.length) typing = setTimeout(tick, 18); else t.classList.remove('caret'); })();
}
$('ti-go2').onclick = async () => {
  const t = $('ti-term'); clearTimeout(typing); t.classList.remove('caret'); t.classList.add('scan'); t.textContent = '';
  $('ti-go2').disabled = true; await new Promise(r => setTimeout(r, 700));
  const fail = m => { $('ti-go2').disabled = false; t.classList.remove('scan'); note('is-err', '// ' + m); toast(m, 'err'); };
  try {
    const jf = readFooter(new Uint8Array(await enc.file.arrayBuffer()));
    if (jf) {
      let d = jf.data;
      if (jf.flag === 1) { const pw = $('ti-pw2').value; if (!pw) return fail('This image is protected. Enter the password.'); try { d = await unseal(d, pw); } catch (e) { return fail(e.message === 'nocrypto' ? 'Decryption requires HTTPS.' : 'Incorrect password.'); } }
      t.classList.remove('scan'); show(new TextDecoder('utf-8', { fatal: true }).decode(d)); toast('Message extracted.'); $('ti-go2').disabled = false; return;
    }
    const { c, x } = toCanvas(enc.img, false), px = x.getImageData(0, 0, c.width, c.height).data;
    if (px.length < HDR * 8 * 4 / 3) return fail('The image is too small and contains no secret.');
    const h = readBytes(px, 0, HDR);
    if (MAGIC.some((m, i) => h[i] !== m)) {
      const rb = robExtract(enc.img);
      if (!rb) return fail('There is no hidden message in this image, or it was resized, cropped or heavily compressed.');
      if (rb.bad) return fail('A message was found but it is corrupted by heavy compression or edits to the image.');
      let d = rb.data;
      if (rb.flag === 1) { const pw = $('ti-pw2').value; if (!pw) return fail('This image is protected. Enter the password.'); try { d = await unseal(d, pw); } catch (e) { return fail(e.message === 'nocrypto' ? 'Decryption requires HTTPS.' : 'Incorrect password.'); } }
      t.classList.remove('scan'); show(new TextDecoder('utf-8', { fatal: true }).decode(d)); toast('Message extracted.'); $('ti-go2').disabled = false; return;
    }
    const len = new DataView(h.buffer).getUint32(5);
    if (len > capBytes(c.width, c.height)) return fail('The image data is corrupted.');
    let data = readBytes(px, HDR, len);
    if (h[4] === 1) {
      const pw = $('ti-pw2').value; if (!pw) return fail('This image is protected. Enter the password.');
      try { data = await unseal(data, pw); } catch (e) { return fail(e.message === 'nocrypto' ? 'Decryption requires HTTPS.' : 'Incorrect password.'); }
    }
    t.classList.remove('scan'); show(new TextDecoder('utf-8', { fatal: true }).decode(data)); toast('Message extracted.');
  } catch { fail('Could not read the message.'); }
  $('ti-go2').disabled = false;
};
$('ti-cp').onclick = async () => {
  const v = $('ti-term').textContent; if (!v || v.startsWith('//')) return toast('There is no text to copy.', 'err');
  try { await navigator.clipboard.writeText(v); } catch { const r = document.createRange(); r.selectNodeContents($('ti-term')); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('copy'); }
  $('ti-ttip').classList.remove('hidden'); setTimeout(() => $('ti-ttip').classList.add('hidden'), 1400);
};
$('ti-clr').onclick = () => { clearTimeout(typing); $('ti-term').classList.remove('caret', 'scan'); note('is-muted', '// The extracted message will appear here'); };


let lastUrl = null;
function deliver(blob, name) {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastUrl = URL.createObjectURL(blob);
  const dl = $('ti-dl'); dl.href = lastUrl; dl.download = name; dl.classList.remove('hidden');
  dl.click();
  $('ti-tip').classList.remove('hidden'); toast('Secret embedded. The image download has started.');
}
})();
