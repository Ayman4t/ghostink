(() => {
  'use strict';

  const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
  const MAX_PIXELS = 10_000_000;
  const state = { mode: 'encode', cover: null, secret: null, stego: null, stegoUrl: null, revealedUrl: null, revealedJpegUrl: null, worker: null, workerUrl: null, busy: false };
  const ROOT = document.querySelector('#tool-image');
  const $ = (selector) => ROOT.querySelector(selector) || document.querySelector(selector);
  const $$ = (selector) => [...ROOT.querySelectorAll(selector)];
  let toastTimer;
  let workerRequestCounter = 0;

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
  }

  function status(mode, message = '', kind = 'info') {
    const element = $(`#${mode}-status`);
    element.textContent = message;
    element.className = `status-message ${kind}`;
    element.hidden = !message;
  }

  function clearResult(which) {
    if (which === 'encode') {
      $('#encode-result').hidden = true;
      if (state.stegoUrl) URL.revokeObjectURL(state.stegoUrl);
      state.stegoUrl = null;
      state.stego = null;
    } else {
      $('#decode-result').hidden = true;
      if (state.revealedUrl) URL.revokeObjectURL(state.revealedUrl);
      if (state.revealedJpegUrl) URL.revokeObjectURL(state.revealedJpegUrl);
      state.revealedUrl = null;
      state.revealedJpegUrl = null;
    }
  }

  function refreshButtons() {
    const enc = $('#encode-button');
    enc.disabled = state.busy || !state.cover || !state.secret;
    enc.querySelector('.button-label').textContent = state.busy && state.mode === 'encode'
      ? 'Hiding the image inside the pixels…'
      : !state.cover || !state.secret ? 'Choose both images to start' : 'Create the vault image & download it';
    const dec = $('#decode-button');
    dec.disabled = state.busy || !state.stego;
    dec.querySelector('.button-label').textContent = state.busy && state.mode === 'decode'
      ? 'Decoding the data locally…'
      : !state.stego ? 'Choose the vault image to start' : 'Extract the hidden image';
    $$('.remove-file').forEach((button) => { button.disabled = state.busy; });
  }

  function chooseMode(mode) {
    if (state.busy) return;
    state.mode = mode;
    $$('.mode-tab').forEach((tab) => {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    $('#panel-encode').hidden = mode !== 'encode';
    $('#panel-decode').hidden = mode !== 'decode';
    $('#panel-encode').classList.toggle('active', mode === 'encode');
    $('#panel-decode').classList.toggle('active', mode === 'decode');
    refreshButtons();
  }

  function clearUpload(kind) {
    if (state.busy) return;
    const card = $(`#${kind}-drop`);
    const previous = state[kind];
    if (previous?.url) URL.revokeObjectURL(previous.url);
    state[kind] = null;
    if (kind === 'stego') state.stegoFiles = [];
    card.classList.remove('has-file');
    card.querySelector('img').removeAttribute('src');
    card.querySelector('.file-name').textContent = '';
    const input = card.querySelector('input');
    input.value = '';
    if (kind === 'cover' || kind === 'secret') clearResult('encode');
    else clearResult('decode');
    status(kind === 'stego' ? 'decode' : 'encode');
    refreshButtons();
  }

  async function acceptFile(kind, file) {
    if (state.busy || !file) return;
    const hasImageExtension = /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name);
    const isImage = file.type.startsWith('image/') || hasImageExtension;
    if (!isImage) return showToast('Choose a valid image file.');
    if (file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) return showToast('Choose a raster image such as PNG or JPEG; SVG files are not supported.');
    if (file.size > MAX_IMAGE_BYTES) return showToast('The image is larger than the allowed limit (40 MB).');
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      if (bitmap.width < 1 || bitmap.height < 1) throw new Error('Could not read the image dimensions.');
      if (bitmap.width * bitmap.height > MAX_PIXELS) throw new Error('The image is too large for safe processing. The maximum is 10 million pixels.');
      if (kind === 'stego' && (bitmap.width > 65535 || bitmap.height > 65535)) throw new Error('The file dimensions exceed what the PixelVault format supports.');
    } catch (error) {
      showToast(error.message || 'Could not open the image.');
      return;
    } finally {
      bitmap?.close();
    }

    const card = $(`#${kind}-drop`);
    const previous = state[kind];
    if (previous?.url) URL.revokeObjectURL(previous.url);
    const url = URL.createObjectURL(file);
    state[kind] = { file, url };
    card.querySelector('img').src = url;
    card.querySelector('.file-name').textContent = file.name;
    card.classList.add('has-file');
    if (kind === 'cover' || kind === 'secret') clearResult('encode');
    else clearResult('decode');
    status(kind === 'stego' ? 'decode' : 'encode');
    refreshButtons();
  }

  function fitDimensions(width, height, maxPixels, coverWidth, coverHeight) {
    const scale = Math.min(1, coverWidth / width, coverHeight / height, Math.sqrt(maxPixels / (width * height)));
    let fittedWidth = Math.max(1, Math.floor(width * scale));
    let fittedHeight = Math.max(1, Math.floor(height * scale));
    while (fittedWidth * fittedHeight > maxPixels) {
      if (fittedWidth / width > fittedHeight / height) fittedWidth -= 1;
      else fittedHeight -= 1;
    }
    return { width: fittedWidth, height: fittedHeight };
  }

  async function loadImagePixels(file, width, height, flatten = false) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true, alpha: !flatten });
    if (!context) { bitmap.close(); throw new Error('Your browser does not support Canvas processing.'); }
    if (flatten) {
      context.fillStyle = '#080b10';
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const pixels = context.getImageData(0, 0, width, height);
    return { canvas, context, pixels };
  }

  function getWorker() {
    if (state.worker) return state.worker;
    try {
      if (window.SS_WORKER_SOURCE) {
        state.workerUrl = URL.createObjectURL(new Blob([window.SS_WORKER_SOURCE], { type: 'text/javascript' }));
        state.worker = new Worker(state.workerUrl);
      } else {
        state.worker = new Worker(new URL('js/image-worker.js', document.baseURI));
      }
    } catch (error) {
      throw new Error('Could not start the processing engine. Reload the page or use a modern browser.');
    }
    state.worker.addEventListener('error', () => { state.worker = null; });
    return state.worker;
  }

  function runWorker(type, payload, transfers) {
    return new Promise((resolve, reject) => {
      const worker = getWorker();
      const id = `${Date.now()}-${++workerRequestCounter}`;
      const onMessage = (event) => {
        if (event.data.id !== id) return;
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.result);
      };
      const onError = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        reject(new Error(location.protocol === 'file:'
          ? 'Could not start the processing engine from the local file. Open a terminal inside the project folder and run: python -m http.server 4173 then open http://localhost:4173.'
          : 'Could not start the processing engine. Reload the page or use a modern browser.'));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ id, type, ...payload }, transfers);
    });
  }

  async function packSecretImage(file, budget, maxWidth, maxHeight) {
    const bitmap = await createImageBitmap(file);
    try {
      // Best case: the original file fits in the cover, so hide it byte-for-byte (no resize, no re-compression).
      if (file.size <= budget && /^image\/(png|jpeg|webp)$/.test(file.type) && bitmap.width <= 65535 && bitmap.height <= 65535) {
        return { bytes: new Uint8Array(await file.arrayBuffer()), width: bitmap.width, height: bitmap.height };
      }
      const webp = supportsWebp();
      let scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height, 4096 / Math.max(bitmap.width, bitmap.height));
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!webp) { context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); }
        context.drawImage(bitmap, 0, 0, width, height);
        const blob = await canvasToBlob(canvas, webp ? 'image/webp' : 'image/jpeg', 0.95);
        if (blob.size <= budget) return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
        scale *= Math.max(0.5, Math.min(0.9, Math.sqrt(budget / blob.size) * 0.97));
      }
      throw new Error('Not enough space in the cover image. Choose a larger cover.');
    } finally {
      bitmap.close();
    }
  }

  async function encode() {
    const password = $('#encode-password').value;
    const passwordEnabled = password.length > 0; // optional: empty box = no encryption
    if (passwordEnabled && password.length < 8) {
      $('#encode-password').focus();
      return status('encode', 'Use a password of at least 8 characters before enabling encryption.', 'error');
    }
    if (passwordEnabled && !window.crypto?.subtle) {
      return status('encode', 'Encryption needs a secure browser that supports Web Crypto. Use localhost or HTTPS.', 'error');
    }
    if ($('#robust-toggle')?.checked) return encodeRobust(passwordEnabled, password);
    state.busy = true;
    status('encode', 'Preparing the pixels and processing on this device…', 'info');
    refreshButtons();
    try {
      const coverBitmap = await createImageBitmap(state.cover.file);
      const coverWidth = coverBitmap.width;
      const coverHeight = coverBitmap.height;
      coverBitmap.close();
      if (coverWidth > 65535 || coverHeight > 65535) throw new Error('The cover image dimensions exceed the allowed limit.');
      const budget = Math.floor((coverWidth * coverHeight * 3 - 42 * 8) / 8) - (passwordEnabled ? 16 : 0);
      if (budget < 200) throw new Error('The cover image is too small to hide data. Choose a larger image.');
      status('encode', 'Compressing the secret image without noticeable quality loss…', 'info');
      const packed = await packSecretImage(state.secret.file, budget, coverWidth, coverHeight);
      const dimsLabel = `${packed.width} × ${packed.height}`;
      const cover = await loadImagePixels(state.cover.file, coverWidth, coverHeight, true);
      status('encode', `Embedding ${dimsLabel} pixels${passwordEnabled ? ' with encryption' : ''}…`, 'info');
      const coverBuffer = cover.pixels.data.buffer;
      const dataBuffer = packed.bytes.buffer;
      const result = await runWorker('encode', {
        width: coverWidth, height: coverHeight, coverPixels: coverBuffer,
        secretWidth: packed.width, secretHeight: packed.height, data: dataBuffer,
        encrypted: passwordEnabled, password: passwordEnabled ? password : ''
      }, [coverBuffer, dataBuffer]);
      const output = new ImageData(new Uint8ClampedArray(result.pixels), coverWidth, coverHeight);
      cover.context.putImageData(output, 0, 0);
      const blob = await new Promise((resolve, reject) => cover.canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not save the PNG image.')), 'image/png'));
      if (state.stegoUrl) URL.revokeObjectURL(state.stegoUrl);
      state.stegoUrl = URL.createObjectURL(blob);
      state.stego = { url: state.stegoUrl, file: blob };
      $('#compare-stego').src = state.stegoUrl;
      $('#compare-cover').src = state.cover.url;
      $('#download-stego').href = state.stegoUrl;
      $('#download-stego').download = 'ghostink-image.png';
      $('#compare-frame').style.setProperty('--split', `${$('#compare-slider').value}%`);
      $('#encode-result').hidden = false;
      status('encode', `Hiding complete. Secret image dimensions after fitting: ${dimsLabel}. Download the image and share it normally.`, 'success');
    } catch (error) {
      status('encode', error.message || 'An error occurred while hiding the image.', 'error');
    } finally {
      state.busy = false;
      refreshButtons();
    }
  }

  async function isPng(file) {
    const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    return signature.length === 8 && signature[0] === 137 && signature[1] === 80 && signature[2] === 78 && signature[3] === 71 && signature[4] === 13 && signature[5] === 10 && signature[6] === 26 && signature[7] === 10;
  }

  async function decode() {
    if ((state.stegoFiles && state.stegoFiles.length > 1) || !await isPng(state.stego.file)) return decodeRobust();
    let fallbackToRobust = false;
    const password = $('#decode-password').value;
    if (!window.crypto?.subtle) return status('decode', 'Your browser does not support secure decryption. Use a modern browser over localhost or HTTPS.', 'error');
    state.busy = true;
    status('decode', 'Inspecting the image data locally…', 'info');
    refreshButtons();
    try {
      const bitmap = await createImageBitmap(state.stego.file);
      const width = bitmap.width;
      const height = bitmap.height;
      if (width * height > MAX_PIXELS) { bitmap.close(); throw new Error('The vault image exceeds the safe processing limit (10 million pixels).'); }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) { bitmap.close(); throw new Error('Your browser does not support Canvas processing.'); }
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, width, height).data;
      const buffer = pixels.buffer;
      status('decode', 'Extracting and verifying the data…', 'info');
      const result = await runWorker('decode', { width, height, pixels: buffer, password }, [buffer]);
      const revealCanvas = document.createElement('canvas');
      if (result.formatVersion === 3) {
        const hidden = await createImageBitmap(new Blob([result.data]));
        result.width = hidden.width;
        result.height = hidden.height;
        revealCanvas.width = hidden.width;
        revealCanvas.height = hidden.height;
        revealCanvas.getContext('2d').drawImage(hidden, 0, 0);
        hidden.close();
      } else {
        const imageData = new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height);
        revealCanvas.width = result.width;
        revealCanvas.height = result.height;
        revealCanvas.getContext('2d').putImageData(imageData, 0, 0);
      }
      const blob = await new Promise((resolve, reject) => revealCanvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not prepare the extracted image.')), 'image/png'));
      const jpegCanvas = document.createElement('canvas');
      jpegCanvas.width = result.width;
      jpegCanvas.height = result.height;
      const jpegContext = jpegCanvas.getContext('2d');
      jpegContext.fillStyle = '#ffffff';
      jpegContext.fillRect(0, 0, result.width, result.height);
      jpegContext.drawImage(revealCanvas, 0, 0);
      const jpegBlob = await new Promise((resolve, reject) => jpegCanvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not prepare the JPEG copy.')), 'image/jpeg', 0.92));
      if (state.revealedUrl) URL.revokeObjectURL(state.revealedUrl);
      if (state.revealedJpegUrl) URL.revokeObjectURL(state.revealedJpegUrl);
      state.revealedUrl = URL.createObjectURL(blob);
      state.revealedJpegUrl = URL.createObjectURL(jpegBlob);
      $('#revealed-image').src = state.revealedUrl;
      $('#download-revealed').href = state.revealedUrl;
      $('#download-revealed-jpeg').href = state.revealedJpegUrl;
      $('#decode-result-note').textContent = `${result.width} × ${result.height} pixels${result.encrypted ? ' · AES-GCM decrypted' : ''}`;
      $('#decode-result').hidden = false;
      status('decode', 'The image was extracted successfully on your device.', 'success');
    } catch (error) {
      fallbackToRobust = /No PixelVault data found/.test(error.message || '');
      status('decode', error.message || 'Could not extract the image. Check the file and the password.', 'error');
    } finally {
      state.busy = false;
      refreshButtons();
    }
    if (fallbackToRobust) await decodeRobust();
  }


  const ROBUST_MAX_SIDE = 1536; // keeps WhatsApp (~1600 px limit) from resizing and breaking the 8x8 block grid
  const ROBUST_MIN_BUDGET = 1200;
  const ROBUST_PROFILES = { cover: { fill: 0.35 }, balanced: { fill: 0.6 }, secret: { fill: 1 }, reliable: { fill: 0.8 } }; // share of the cover's capacity that is used
  const ROBUST_STRENGTH = 2.6; // QIM strength written into new files (the decoder tries 2.6, 1.8 and 1.0)
  let THUMB_MAX_SIDE = 640;

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode the image.')), type, quality));
  }

  function supportsWebp() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    return canvas.toDataURL('image/webp').startsWith('data:image/webp');
  }

  function drawScaled(bitmap, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    return { canvas, context };
  }

  // Highest quality (5-95 %) whose encoded size still fits the budget; sizes grow with quality, so bisect.
  async function bestQuality(canvas, type, budget) {
    let low = 5;
    let high = 95;
    let best = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const blob = await canvasToBlob(canvas, type, mid / 100);
      if (blob.size <= budget) { best = { blob, quality: mid }; low = mid + 1; } else high = mid - 1;
    }
    return best;
  }

  // Rate-distortion search: every candidate size gets the best quality that fits the byte budget, is decoded back
  // and compared with the original at a common viewing size; the candidate with the lowest error wins. This beats
  // "largest size at the lowest acceptable quality", which produces blurry, blocky thumbnails.
  async function makeThumbnail(file, budget) {
    const bitmap = await createImageBitmap(file);
    const webp = supportsWebp();
    const type = webp ? 'image/webp' : 'image/jpeg';
    try {
      const refScale = Math.min(1, THUMB_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const refWidth = Math.max(1, Math.round(bitmap.width * refScale));
      const refHeight = Math.max(1, Math.round(bitmap.height * refScale));
      const reference = drawScaled(bitmap, refWidth, refHeight).context.getImageData(0, 0, refWidth, refHeight).data;
      const longSide = Math.max(refWidth, refHeight);
      const sides = [...new Set([longSide, ...[1280, 1024, 896, 768, 640, 576, 512, 448, 384, 320, 256, 224, 192, 160, 128, 96, 64, 48, 32].filter((side) => side < longSide)])];
      let best = null;
      for (const side of sides) {
        const scale = side / Math.max(bitmap.width, bitmap.height);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const { canvas } = drawScaled(bitmap, width, height);
        const found = await bestQuality(canvas, type, budget);
        if (!found) continue;
        // decode the candidate and measure the error against the reference
        const decoded = await createImageBitmap(found.blob);
        const probe = drawScaled(decoded, refWidth, refHeight);
        decoded.close();
        const pixels = probe.context.getImageData(0, 0, refWidth, refHeight).data;
        let error = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const dr = pixels[i] - reference[i];
          const dg = pixels[i + 1] - reference[i + 1];
          const db = pixels[i + 2] - reference[i + 2];
          error += dr * dr + dg * dg + db * db;
        }
        if (!best || error < best.error) best = { error, blob: found.blob, quality: found.quality, width, height };
        if (found.quality >= 90) break; // already near-lossless at this size; smaller sizes cannot do better
      }
      if (!best) throw new Error('The cover is too small to hide even a reduced copy. Choose a larger cover.');
      return { bytes: new Uint8Array(await best.blob.arrayBuffer()), width: best.width, height: best.height, format: webp ? 'WebP' : 'JPEG', quality: best.quality };
    } finally {
      bitmap.close();
    }
  }

  async function encodeRobust(passwordEnabled, password) {
    state.busy = true;
    status('encode', 'Resistant mode: preparing the cover and creating a reduced copy of the secret image…', 'info');
    refreshButtons();
    try {
      const coverBitmap = await createImageBitmap(state.cover.file);
      const longSide = Math.max(coverBitmap.width, coverBitmap.height);
      // HD: small covers are enlarged to ~3200 px (more 8x8 blocks = more room for the hidden image).
      const scale = ROBUST_MAX_SIDE / longSide; // standard mode: scale the cover to the WhatsApp-safe size (up or down) so small covers still get full capacity
      const width = Math.floor(coverBitmap.width * scale / 8) * 8;
      const height = Math.floor(coverBitmap.height * scale / 8) * 8;
      if (width < 8 || height < 8) { coverBitmap.close(); throw new Error('The cover image is too small.'); }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#080b10';
      context.fillRect(0, 0, width, height);
      context.imageSmoothingQuality = 'high';
      context.drawImage(coverBitmap, 0, 0, width, height);
      coverBitmap.close();

      // Every hidden byte adds a little noise to the cover, so the budget is the share of the cover's capacity
      // picked with the balance selector; the part that is not used stays untouched.
      const overhead = passwordEnabled ? 44 : 0;
      // Reliability first: every bit is stored twice (repeat x2) with a stronger QIM step, and the secret is sized to 80%
      // of the repeat-2 capacity. Old setting (repeat x1, strength 1.8, 100% fill) broke below about JPEG q55 and after
      // any second re-compression; this one survives q32 and several generations of re-compression in testing.
      const rbOpts = { minRepeat: 2, maxRepeat: 2, k: ROBUST_STRENGTH };
      const { capacity } = await runWorker('robustCapacity', { width, height, repeat: 2 });
      if (capacity - overhead < ROBUST_MIN_BUDGET) throw new Error('The cover is too small for compression-resistant mode. Choose a cover at least 800 pixels wide.');
      const profile = ROBUST_PROFILES.reliable; // fixed
      const budget = Math.max(ROBUST_MIN_BUDGET, Math.floor(capacity * profile.fill) - overhead);
      status('encode', 'Choosing the best possible quality for the secret image…', 'info');
      THUMB_MAX_SIDE = 1280;
      const wanted = '1'; // one photo (fixed)
      const original = /^image\/(png|jpeg|webp)$/.test(state.secret.file.type);
      let parts;
      if (wanted === 'auto') {
        // hide the ORIGINAL file byte-for-byte: as many photos as it takes (single photo if it fits)
        parts = original ? Math.max(1, Math.ceil(state.secret.file.size / (budget - 6))) : 4;
        if (parts === 1 && state.secret.file.size > budget) parts = 2;
        if (parts > 24) parts = 24;
      } else parts = Math.max(1, Math.min(10, Number(wanted) || 1));
      const chunkRoom = budget - (parts > 1 ? 6 : 0);
      const totalBudget = chunkRoom * parts;
      let thumb;
      if (state.secret.file.size <= totalBudget && original) {
        const b = await createImageBitmap(state.secret.file);
        thumb = { bytes: new Uint8Array(await state.secret.file.arrayBuffer()), width: b.width, height: b.height, format: 'original', quality: 100 };
        b.close();
      } else {
        thumb = await makeThumbnail(state.secret.file, totalBudget);
      }
      const sessionId = Math.floor(Math.random() * 65536);
      const per = Math.ceil(thumb.bytes.length / parts);
      const outputs = [];
      for (let part = 0; part < parts; part += 1) {
        status('encode', `Embedding ${parts > 1 ? `part ${part + 1} of ${parts}` : `a ${thumb.width} × ${thumb.height} copy (${(thumb.bytes.length / 1024).toFixed(1)} KB ${thumb.format})`} with error correction…`, 'info');
        let chunk = thumb.bytes;
        if (parts > 1) {
          const body = thumb.bytes.slice(part * per, (part + 1) * per);
          chunk = new Uint8Array(6 + body.length);
          chunk.set([0x50, 0x53, part, parts, sessionId >> 8, sessionId & 255], 0);
          chunk.set(body, 6);
        } else chunk = chunk.slice();
        const imageData = context.getImageData(0, 0, width, height);
        const coverBuffer = imageData.data.buffer;
        const dataBuffer = chunk.buffer;
        const result = await runWorker('robustEncode', {
          width, height, coverPixels: coverBuffer, data: dataBuffer,
          encrypted: passwordEnabled, password: passwordEnabled ? password : '', opts: rbOpts
        }, [coverBuffer, dataBuffer]);
        const out = new ImageData(new Uint8ClampedArray(result.pixels), width, height);
        const partCanvas = document.createElement('canvas');
        partCanvas.width = width; partCanvas.height = height;
        partCanvas.getContext('2d').putImageData(out, 0, 0);
        const partBlob = await canvasToBlob(partCanvas, 'image/png');
        outputs.push({ blob: partBlob, url: URL.createObjectURL(partBlob), repeat: result.repeat });
      }
      if (state.stegoUrl) URL.revokeObjectURL(state.stegoUrl);
      (state.partUrls || []).forEach((u) => URL.revokeObjectURL(u));
      state.partUrls = outputs.map((o) => o.url);
      state.stegoUrl = outputs[0].url;
      state.stego = { url: state.stegoUrl, file: outputs[0].blob };
      $('#compare-stego').src = state.stegoUrl;
      $('#compare-cover').src = state.cover.url;
      $('#download-stego').href = state.stegoUrl;
      $('#download-stego').download = parts > 1 ? 'pixelvault-part1.png' : 'pixelvault-robust.png';
      const extra = $('#parts-downloads');
      extra.textContent = '';
      outputs.slice(1).forEach((o, k) => {
        const link = document.createElement('a');
        link.className = 'download-button';
        link.href = o.url; link.download = `pixelvault-part${k + 2}.png`;
        link.textContent = `↓ Part ${k + 2} of ${parts}`;
        extra.appendChild(link);
      });
      $('#compare-frame').style.setProperty('--split', `${$('#compare-slider').value}%`);
      $('#encode-result').hidden = false;
      status('encode', parts > 1
        ? `Hiding complete: ${parts} images (${thumb.width} × ${thumb.height} copy). Download all parts and send them all, then select them together in the Extract tab.`
        : `Resistant hiding complete (${width} × ${height}, repeat ×${outputs[0].repeat}). The secret image is stored as a ${thumb.width} × ${thumb.height} copy.`, 'success');
    } catch (error) {
      status('encode', error.message || 'An error occurred during resistant hiding.', 'error');
    } finally {
      state.busy = false;
      refreshButtons();
    }
  }

  async function decodeRobust() {
    const password = $('#decode-password').value;
    if (!window.crypto?.subtle) return status('decode', 'Your browser does not support secure decryption. Use a modern browser over localhost or HTTPS.', 'error');
    state.busy = true;
    status('decode', 'Searching the image for compression-resistant data…', 'info');
    refreshButtons();
    let received = '';
    try {
      const files = state.stegoFiles && state.stegoFiles.length > 1 ? state.stegoFiles : [state.stego.file];
      const decoded = [];
      let encryptedFlag = false;
      for (const file of files) {
        const bitmap = await createImageBitmap(file);
        const width = bitmap.width;
        const height = bitmap.height;
        received = `${width} × ${height}`;
        if (width * height > MAX_PIXELS) { bitmap.close(); throw new Error('The image exceeds the safe processing limit (10 million pixels).'); }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        const buffer = context.getImageData(0, 0, width, height).data.buffer;
        const res = await runWorker('robustDecode', { width, height, pixels: buffer, password }, [buffer]);
        encryptedFlag = res.encrypted;
        decoded.push(new Uint8Array(res.data));
      }
      let rawBytes = decoded[0];
      const result = { encrypted: encryptedFlag };
      if (rawBytes[0] === 0x50 && rawBytes[1] === 0x53 && rawBytes[3] > 1) {
        const total = rawBytes[3];
        const id = (rawBytes[4] << 8) | rawBytes[5];
        const have = new Map();
        for (const d of decoded) if (d[0] === 0x50 && d[1] === 0x53 && d[3] === total && ((d[4] << 8) | d[5]) === id) have.set(d[2], d.slice(6));
        if (have.size < total) throw new Error(`This image is one part of ${total}, and only ${have.size} are available. Select all the part images together (multi-select) in the upload box.`);
        const order = [...Array(total).keys()].map((k) => have.get(k));
        rawBytes = new Uint8Array(order.reduce((n, d) => n + d.length, 0));
        let off = 0;
        for (const d of order) { rawBytes.set(d, off); off += d.length; }
      }
      const isWebp = rawBytes[0] === 0x52 && rawBytes[1] === 0x49 && rawBytes[2] === 0x46 && rawBytes[3] === 0x46;
      const thumbBlob = new Blob([rawBytes], { type: isWebp ? 'image/webp' : 'image/jpeg' });
      let thumb;
      try { thumb = await createImageBitmap(thumbBlob); } catch { throw new Error('The data was recovered but the reduced image could not be opened.'); }
      const upscale = Math.max(1, Math.floor(640 / Math.max(thumb.width, thumb.height)));
      const revealCanvas = document.createElement('canvas');
      revealCanvas.width = thumb.width * upscale;
      revealCanvas.height = thumb.height * upscale;
      const revealContext = revealCanvas.getContext('2d');
      revealContext.imageSmoothingQuality = 'high';
      revealContext.drawImage(thumb, 0, 0, revealCanvas.width, revealCanvas.height);
      const originalWidth = thumb.width;
      const originalHeight = thumb.height;
      thumb.close();
      const blob = await canvasToBlob(revealCanvas, 'image/png');
      const jpegCanvas = document.createElement('canvas');
      jpegCanvas.width = revealCanvas.width;
      jpegCanvas.height = revealCanvas.height;
      const jpegContext = jpegCanvas.getContext('2d');
      jpegContext.fillStyle = '#ffffff';
      jpegContext.fillRect(0, 0, jpegCanvas.width, jpegCanvas.height);
      jpegContext.drawImage(revealCanvas, 0, 0);
      const jpegBlob = await canvasToBlob(jpegCanvas, 'image/jpeg', 0.95);
      if (state.revealedUrl) URL.revokeObjectURL(state.revealedUrl);
      if (state.revealedJpegUrl) URL.revokeObjectURL(state.revealedJpegUrl);
      state.revealedUrl = URL.createObjectURL(blob);
      state.revealedJpegUrl = URL.createObjectURL(jpegBlob);
      $('#revealed-image').src = state.revealedUrl;
      $('#download-revealed').href = state.revealedUrl;
      $('#download-revealed-jpeg').href = state.revealedJpegUrl;
      $('#decode-result-note').textContent = `${originalWidth} × ${originalHeight} pixel copy (compression-resistant mode)${result.encrypted ? ' · AES-GCM decrypted' : ''}`;
      $('#decode-result').hidden = false;
      status('decode', 'The hidden image was extracted from the compressed file successfully.', 'success');
    } catch (error) {
      const lost = /No PixelVault data found/.test(error.message || '');
      status('decode', (error.message || 'Could not extract the image.') + (lost && received ? ` [Received dimensions: ${received}. If smaller than the original image (for example 1600 pixels maximum), WhatsApp shrank it: send it with the HD option, or without HD with the large-cover option turned off]` : ''), 'error');
    } finally {
      state.busy = false;
      refreshButtons();
    }
  }

  $$('.mode-tab').forEach((tab) => tab.addEventListener('click', () => chooseMode(tab.dataset.mode)));
  [['cover', 'cover-input'], ['secret', 'secret-input'], ['stego', 'stego-input']].forEach(([kind, inputId]) => {
    const card = $(`#${kind}-drop`);
    const input = $(`#${inputId}`);
    input.addEventListener('change', () => {
      if (kind === 'stego') state.stegoFiles = [...(input.files || [])];
      const file = input.files?.[0]; if (file) acceptFile(kind, file);
    });
    card.querySelector('.remove-file').addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); clearUpload(kind); });
    card.addEventListener('dragover', (event) => { event.preventDefault(); if (!state.busy) card.classList.add('drag-over'); });
    card.addEventListener('dragleave', (event) => { if (!card.contains(event.relatedTarget)) card.classList.remove('drag-over'); });
    card.addEventListener('drop', (event) => { event.preventDefault(); card.classList.remove('drag-over'); if (!state.busy) { if (kind === 'stego') state.stegoFiles = [...(event.dataTransfer?.files || [])]; acceptFile(kind, event.dataTransfer?.files?.[0]); } });
  });

  $('#encode-button').addEventListener('click', encode);
  $('#decode-button').addEventListener('click', decode);
  $$('.password-eye').forEach((button) => button.addEventListener('click', () => {
    const input = $(`#${button.dataset.target}`);
    input.type = input.type === 'password' ? 'text' : 'password';
    button.setAttribute('aria-label', input.type === 'password' ? 'Show password' : 'Hide password');
  }));
  $('#compare-slider').addEventListener('input', (event) => $('#compare-frame').style.setProperty('--split', `${event.target.value}%`));


  window.addEventListener('beforeunload', () => {
    [state.cover, state.secret, state.stego].forEach((item) => { if (item?.url) URL.revokeObjectURL(item.url); });
    if (state.revealedUrl) URL.revokeObjectURL(state.revealedUrl);
    if (state.revealedJpegUrl) URL.revokeObjectURL(state.revealedJpegUrl);
    state.worker?.terminate();
    if (state.workerUrl) URL.revokeObjectURL(state.workerUrl);
  });
  refreshButtons();
})();
