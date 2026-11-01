(() => {
    "use strict";

    /* =====================================================================
       CODEC
       Every hidden message is a small frame:
         'S' 'T' | version | length (2 bytes) | UTF-8 data | CRC-16
       The header lets the decoder find the message without any marker, the
       length detects truncation, and the CRC detects altered characters.

       Two ways to carry the bytes:
         vs  - one variation selector per byte (short, preserved by emoji-aware apps)
         zw  - eight ZWNJ/ZWJ characters per byte (classic)
       The old v2.0 format (ZWSP/ZWNJ bits after a marker) is still readable.
       ===================================================================== */
    // === CODEC START ===
    const MAGIC_A = 0x53, MAGIC_B = 0x54, FRAME_VERSION = 1, FRAME_VERSION_ENC = 2;
    const SALT_LEN = 16, IV_LEN = 12, PBKDF2_ITER = 250000;
    const HEADER_LEN = 5, CRC_LEN = 2, MAX_SECRET_BYTES = 0xFFFF;
    const ZW_BIT0 = "\u200C", ZW_BIT1 = "\u200D";
    const LEGACY_BIT0 = "\u200B", LEGACY_BIT1 = "\u200C";
    const LEGACY_MARKER_NEW = "\u2063\u2063\u2063", LEGACY_MARKER_OLD = "\uFEFF";

    const HIDDEN_GROUPS = [
      { id: "zwsp", label: "Zero-width space", code: "U+200B", payload: true, test: (c) => c === 0x200B },
      { id: "zwnj", label: "Zero-width non-joiner", code: "U+200C", payload: true, test: (c) => c === 0x200C },
      { id: "zwj", label: "Zero-width joiner", code: "U+200D", payload: true, test: (c) => c === 0x200D },
      { id: "wj", label: "Word joiner", code: "U+2060", payload: true, test: (c) => c === 0x2060 },
      { id: "sep", label: "Invisible separators", code: "U+2062-2064", payload: true, test: (c) => c >= 0x2062 && c <= 0x2064 },
      { id: "bom", label: "BOM mark", code: "U+FEFF", payload: true, test: (c) => c === 0xFEFF },
      { id: "vs", label: "Variation selectors", code: "U+FE00-FE0F", payload: true, test: (c) => (c >= 0xFE00 && c <= 0xFE0F) || (c >= 0xE0100 && c <= 0xE01EF) },
      { id: "tag", label: "Tag characters", code: "U+E0000", payload: true, test: (c) => c >= 0xE0000 && c <= 0xE007F },
      { id: "bidi", label: "Direction marks", code: "RLM/LRM", payload: false, test: (c) => c === 0x200E || c === 0x200F || (c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069) }
    ];

    function scanInvisible(text) {
      const counts = new Map();
      for (const ch of text) {
        const cp = ch.codePointAt(0);
        for (const g of HIDDEN_GROUPS) {
          if (g.test(cp)) { counts.set(g.id, (counts.get(g.id) || 0) + 1); break; }
        }
      }
      return HIDDEN_GROUPS
        .filter((g) => counts.has(g.id))
        .map((g) => ({ id: g.id, label: g.label, code: g.code, payload: g.payload, count: counts.get(g.id) }));
    }

    function isHiddenCp(cp) {
      return HIDDEN_GROUPS.some((g) => g.payload && g.test(cp));
    }

    function crc16(bytes, end) {
      let crc = 0xFFFF;
      for (let i = 0; i < end; i++) {
        crc ^= bytes[i] << 8;
        for (let k = 0; k < 8; k++) {
          crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xFFFF) : ((crc << 1) & 0xFFFF);
        }
      }
      return crc;
    }

    function buildFrame(data, version) {
      if (data.length > MAX_SECRET_BYTES) throw new RangeError("secret-too-long");
      const frame = new Uint8Array(HEADER_LEN + data.length + CRC_LEN);
      frame[0] = MAGIC_A;
      frame[1] = MAGIC_B;
      frame[2] = version;
      frame[3] = data.length >> 8;
      frame[4] = data.length & 255;
      frame.set(data, HEADER_LEN);
      const crc = crc16(frame, HEADER_LEN + data.length);
      frame[HEADER_LEN + data.length] = crc >> 8;
      frame[HEADER_LEN + data.length + 1] = crc & 255;
      return frame;
    }

    function byteToVS(b) {
      return String.fromCodePoint(b < 16 ? 0xFE00 + b : 0xE0100 + (b - 16));
    }

    function vsToByte(cp) {
      if (cp >= 0xFE00 && cp <= 0xFE0F) return cp - 0xFE00;
      if (cp >= 0xE0100 && cp <= 0xE01EF) return cp - 0xE0100 + 16;
      return -1;
    }

    // data is a Uint8Array: plain UTF-8 (version 1) or salt+iv+ciphertext (version 2).
    function encodeMessage(visible, data, version, mode) {
      const frame = buildFrame(data, version);
      let hidden = "";
      if (mode === "zw") {
        for (const byte of frame) {
          for (let bit = 7; bit >= 0; bit--) hidden += ((byte >> bit) & 1) ? ZW_BIT1 : ZW_BIT0;
        }
      } else {
        for (const byte of frame) hidden += byteToVS(byte);
      }
      return {
        text: visible + hidden,
        hiddenChars: Array.from(hidden).length,
        secretBytes: frame.length - HEADER_LEN - CRC_LEN
      };
    }

    // Looks for a frame anywhere inside a byte stream.
    function findFrame(bytes) {
      let best = null;
      for (let i = 0; i + 2 < bytes.length; i++) {
        if (bytes[i] !== MAGIC_A || bytes[i + 1] !== MAGIC_B || (bytes[i + 2] !== FRAME_VERSION && bytes[i + 2] !== FRAME_VERSION_ENC)) continue;
        if (i + HEADER_LEN > bytes.length) {
          best = best || { status: "truncated", have: bytes.length - i, need: null };
          continue;
        }
        const len = (bytes[i + 3] << 8) | bytes[i + 4];
        const total = HEADER_LEN + len + CRC_LEN;
        if (i + total > bytes.length) {
          best = best || { status: "truncated", have: bytes.length - i, need: total };
          continue;
        }
        const crc = (bytes[i + HEADER_LEN + len] << 8) | bytes[i + HEADER_LEN + len + 1];
        if (crc16(bytes.subarray(i), HEADER_LEN + len) !== crc) {
          best = best || { status: "corrupt" };
          continue;
        }
        if (bytes[i + 2] === FRAME_VERSION_ENC) {
          if (len < SALT_LEN + IV_LEN + 16) { best = best || { status: "corrupt" }; continue; }
          return { status: "ok", encrypted: true, payload: bytes.slice(i + HEADER_LEN, i + HEADER_LEN + len) };
        }
        try {
          const message = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(i + HEADER_LEN, i + HEADER_LEN + len));
          return { status: "ok", message };
        } catch (e) {
          best = best || { status: "corrupt" };
        }
      }
      return best;
    }

    function decodeVS(text) {
      const bytes = [];
      for (const ch of text) {
        const b = vsToByte(ch.codePointAt(0));
        if (b >= 0) bytes.push(b);
      }
      if (!bytes.length) return null;
      return findFrame(Uint8Array.from(bytes));
    }

    function decodeZW(text) {
      const bits = [];
      for (const ch of text) {
        if (ch === ZW_BIT0) bits.push(0);
        else if (ch === ZW_BIT1) bits.push(1);
      }
      if (bits.length < 8) return null;
      let best = null;
      // Stray joiners before the payload can shift the alignment, so try every offset.
      for (let off = 0; off < 8; off++) {
        const n = Math.floor((bits.length - off) / 8);
        if (n <= 0) continue;
        const bytes = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          let v = 0;
          for (let k = 0; k < 8; k++) v = (v << 1) | bits[off + i * 8 + k];
          bytes[i] = v;
        }
        const r = findFrame(bytes);
        if (r && r.status === "ok") return r;
        if (r && !best) best = r;
      }
      return best;
    }

    // Reads messages made by the previous version (v2.0).
    function decodeLegacy(text) {
      const newIndex = text.lastIndexOf(LEGACY_MARKER_NEW);
      const oldIndex = text.lastIndexOf(LEGACY_MARKER_OLD);
      let idx = -1, len = 0;
      if (newIndex >= 0 && newIndex >= oldIndex) { idx = newIndex; len = LEGACY_MARKER_NEW.length; }
      else if (oldIndex >= 0) { idx = oldIndex; len = LEGACY_MARKER_OLD.length; }
      if (idx < 0) return null;

      let binary = "";
      for (const ch of text.slice(idx + len)) {
        if (ch === LEGACY_BIT0) binary += "0";
        else if (ch === LEGACY_BIT1) binary += "1";
      }
      if (!binary.length) return idx === newIndex && len === 3 ? { status: "truncated", legacy: true, bits: 0 } : null;
      if (binary.length % 8 !== 0) return { status: "truncated", legacy: true, bits: binary.length };

      const bytes = new Uint8Array(binary.length / 8);
      for (let i = 0; i < binary.length; i += 8) bytes[i / 8] = parseInt(binary.slice(i, i + 8), 2);
      try {
        return { status: "ok", legacy: true, message: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } catch (e) {
        return { status: "corrupt", legacy: true };
      }
    }

    function decodeMessage(text) {
      const scan = scanInvisible(text);
      const attempts = [decodeVS(text), decodeZW(text)].filter(Boolean);

      const good = attempts.find((r) => r.status === "ok");
      if (good && good.encrypted) return { ok: true, encrypted: true, payload: good.payload, scan };
      if (good) return { ok: true, message: good.message, scan };

      const legacy = decodeLegacy(text);
      if (legacy && legacy.status === "ok") return { ok: true, message: legacy.message, scan, legacy: true };

      const bad = attempts[0] || legacy;
      if (bad) return { ok: false, reason: bad.status, detail: bad, scan };

      const carriers = scan
        .filter((s) => ["vs", "zwnj", "zwj", "zwsp"].includes(s.id))
        .reduce((sum, s) => sum + s.count, 0);
      return { ok: false, reason: carriers >= 16 ? "damaged" : "none", detail: {}, scan };
    }

    /* ---------- Password protection (AES-256-GCM, key from PBKDF2-SHA256) ---------- */
    async function deriveKey(password, salt) {
      const raw = new TextEncoder().encode(password.normalize("NFC"));
      const base = await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
      );
    }

    // Returns salt | iv | ciphertext+tag as one Uint8Array.
    async function encryptSecret(secret, password) {
      const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
      const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
      const key = await deriveKey(password, salt);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret)));
      const out = new Uint8Array(SALT_LEN + IV_LEN + ct.length);
      out.set(salt, 0);
      out.set(iv, SALT_LEN);
      out.set(ct, SALT_LEN + IV_LEN);
      return out;
    }

    // Throws if the password is wrong or the data was altered.
    async function decryptSecret(payload, password) {
      const salt = payload.slice(0, SALT_LEN);
      const iv = payload.slice(SALT_LEN, SALT_LEN + IV_LEN);
      const ct = payload.slice(SALT_LEN + IV_LEN);
      const key = await deriveKey(password, salt);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      return new TextDecoder("utf-8", { fatal: true }).decode(pt);
    }
    // === CODEC END ===

    /* =====================================================================
       UI
       ===================================================================== */
    const $ = (id) => document.getElementById(id);
    const reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const MODE_LABEL = { vs: "Compact", zw: "Classic" };

    let mode = "vs";
    let lastEncoded = "";
    let lastSecret = "";
    let toastTimer = 0, typeTimer = 0, decodeTimer = 0, decodeSeq = 0, encoding = false;
    let lastPassword = "";

    try {
      const saved = localStorage.getItem("stegtext-mode");
      if (saved === "vs" || saved === "zw") mode = saved;
    } catch (e) { /* storage can be blocked; the default is fine */ }

    const toast = (message, kind) => SS.toast(message, kind === "warn" ? "err" : "ok");

    function nudge(el) {
      el.classList.remove("shake");
      void el.offsetWidth;
      el.classList.add("shake");
      el.focus();
      setTimeout(() => el.classList.remove("shake"), 450);
    }

    function setBadge(el, kind, text) {
      el.className = "badge" + (kind ? " " + kind : "");
      el.textContent = text;
      el.hidden = !text;
    }

    function setMode(next) {
      mode = next;
      document.querySelectorAll(".mode").forEach((btn) => {
        btn.setAttribute("aria-checked", String(btn.dataset.mode === next));
      });
      try { localStorage.setItem("stegtext-mode", next); } catch (e) { /* ignore */ }
    }

    function switchTab(tab) {
      const encode = tab === "encode";
      $("tt-tabs").dataset.active = tab;
      $("tt-panel-encode").hidden = !encode;
      $("tt-panel-decode").hidden = encode;
      $("tt-tab-encode").setAttribute("aria-selected", String(encode));
      $("tt-tab-decode").setAttribute("aria-selected", String(!encode));
      $("tt-tab-encode").tabIndex = encode ? 0 : -1;
      $("tt-tab-decode").tabIndex = encode ? -1 : 0;
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* fall through to the legacy path */ }

      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      let done = false;
      try { done = document.execCommand("copy"); } catch (e) { done = false; }
      document.body.removeChild(ta);
      return done;
    }

    // Draws the hidden characters as visible glowing dots.
    function renderXray(el, text) {
      const MAX_DOTS = 140;
      el.textContent = "";
      let dots = 0, extra = 0, buffer = "";
      const flush = () => {
        if (buffer) { el.appendChild(document.createTextNode(buffer)); buffer = ""; }
      };
      for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (isHiddenCp(cp)) {
          if (dots < MAX_DOTS) {
            flush();
            const dot = document.createElement("span");
            dot.className = "dot d" + (cp & 3);
            el.appendChild(dot);
            dots++;
          } else {
            extra++;
          }
        } else {
          buffer += ch;
        }
      }
      flush();
      if (extra) {
        const more = document.createElement("span");
        more.className = "more";
        more.textContent = "+" + extra;
        el.appendChild(more);
      }
    }

    async function handleEncode() {
      if (encoding) return;
      const visible = $("tt-visible-text").value.trim();
      const secret = $("tt-secret-text").value;
      const password = $("tt-secret-password").value;

      if (!visible) { nudge($("tt-visible-text")); toast("Write the visible text first", "warn"); return; }
      if (!secret.trim()) { nudge($("tt-secret-text")); toast("Write the secret message first", "warn"); return; }
      if (password && password !== $("tt-secret-password2").value) {
        nudge($("tt-secret-password2")); toast("The passwords do not match", "warn"); return;
      }
      if (password && !(window.crypto && crypto.subtle)) {
        toast("Encryption is not available in this browser or on this page; open it over https", "warn"); return;
      }

      encoding = true;
      $("tt-encode-btn").disabled = true;
      let enc, verified = false;
      try {
        try {
          if (password) {
            const payload = await encryptSecret(secret, password);
            enc = encodeMessage(visible, payload, FRAME_VERSION_ENC, mode);
          } else {
            enc = encodeMessage(visible, new TextEncoder().encode(secret), FRAME_VERSION, mode);
          }
        } catch (e) {
          toast(e instanceof RangeError ? "The secret message is too long; shorten it a little" : "An error occurred while hiding", "warn");
          return;
        }

        // Round-trip check so a broken message is never handed out silently.
        const check = decodeMessage(enc.text);
        if (check.ok && check.encrypted) {
          try { verified = (await decryptSecret(check.payload, password)) === secret; } catch (e) { verified = false; }
        } else {
          verified = check.ok && check.message === secret;
        }
      } finally {
        encoding = false;
        $("tt-encode-btn").disabled = false;
      }

      lastEncoded = enc.text;
      lastPassword = password;
      $("tt-encoded-output").value = enc.text;
      renderXray($("tt-xray"), enc.text);
      $("tt-stat-hidden").textContent = String(enc.hiddenChars);
      $("tt-stat-bytes").textContent = String(enc.secretBytes);
      $("tt-stat-mode").textContent = MODE_LABEL[mode] + (password ? " 🔒" : "");
      setBadge($("tt-verify-badge"), verified ? "ok" : "bad", verified ? "Passed the local test ✓" : "Failed the local test ✕");
      $("tt-encode-result-box").hidden = false;
      $("tt-encode-result-box").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
    }

    async function handleCopy() {
      const ok = await copyText($("tt-encoded-output").value);
      toast(ok ? "Copied ✓" : "Automatic copy failed; long-press the text and copy it", ok ? "" : "warn");
    }

    async function handleShare() {
      try {
        await navigator.share({ text: lastEncoded });
      } catch (e) {
        if (e && e.name !== "AbortError") toast("Sharing failed; use the Copy button", "warn");
      }
    }

    function testCurrentMessage() {
      if (!lastEncoded) { toast("Create a hidden message first", "warn"); return; }
      $("tt-decode-input").value = lastEncoded;
      $("tt-decode-password").value = lastPassword;
      updateDetectHint();
      switchTab("decode");
      handleDecode();
    }

    function updateDetectHint() {
      const text = $("tt-decode-input").value;
      const hint = $("tt-detect-hint");
      if (!text) { hint.textContent = ""; return; }
      const total = scanInvisible(text).filter((s) => s.payload).reduce((sum, s) => sum + s.count, 0);
      hint.textContent = total
        ? "🔎 Detected " + total + " hidden character(s) in the pasted text"
        : "No hidden characters were detected in the pasted text";
    }

    function reveal(el, text) {
      clearInterval(typeTimer);
      const chars = Array.from(text);
      if (reduceMotion || chars.length < 3) { el.textContent = text; return; }
      const step = Math.max(1, Math.ceil(chars.length / 40));
      let shown = 0;
      typeTimer = setInterval(() => {
        shown = Math.min(chars.length, shown + step);
        el.textContent = chars.slice(0, shown).join("");
        if (shown >= chars.length) { clearInterval(typeTimer); el.textContent = text; }
      }, 30);
    }

    function explainFailure(r) {
      const d = r.detail || {};
      switch (r.reason) {
        case "truncated":
          if (d.legacy) return "This is a message in the old format (v2.0) and some of its characters were lost while copying or sending, so it cannot be recovered. Create a new message with this version.";
          return d.need
            ? "We found a hidden message but it is incomplete: " + d.have + " of " + d.need + " bytes arrived. The app most likely removed some of the characters."
            : "We found the start of a hidden message but it is cut off. The app most likely removed some of the characters.";
        case "corrupt":
          return "The hidden characters are present but some were altered, so the integrity check failed. Copy the original text again and retry.";
        case "damaged":
          return "Hidden characters were found but without a valid message start, so part of it may have been lost or the text changed while copying.";
        case "needpass":
          return "This message is password-protected. Enter the password in the field above, then press Reveal again.";
        case "wrongpass":
          return "The password is incorrect, or part of the encrypted message changed while copying.";
        default:
          return "There is no hidden message in this text. It may have been sent without the secret message, or the app removed all the hidden characters.";
      }
    }

    function renderDiag(r) {
      const list = $("tt-diag-list");
      list.textContent = "";
      const found = r.scan.filter((s) => s.payload);
      if (!found.length) {
        const li = document.createElement("li");
        li.className = "chip empty";
        li.textContent = "No hidden characters arrived";
        list.appendChild(li);
      }
      found.forEach((s) => {
        const li = document.createElement("li");
        li.className = "chip";
        const name = document.createElement("span");
        name.textContent = s.label;
        const code = document.createElement("bdi");
        code.textContent = s.code + " × " + s.count;
        li.appendChild(name);
        li.appendChild(code);
        list.appendChild(li);
      });
      $("tt-diag-tip").textContent = found.length
        ? "These are the characters that survived copying or sending. If a type is missing, the app removes it; try the other method or the Share button."
        : "The app you copied from most likely removed all the hidden characters. Try the other method, or send using the Share button instead of copying.";
      $("tt-diag").hidden = false;
    }

    function showDecodeResult(r) {
      const out = $("tt-decoded-output");
      const text = $("tt-decoded-text");
      if (r.ok) {
        lastSecret = r.message;
        out.className = "result ok";
        reveal(text, r.message);
        setBadge($("tt-decode-badge"), "ok", "Revealed ✓");
        $("tt-diag").hidden = true;
        $("tt-decode-actions").hidden = false;
      } else {
        out.className = "result bad";
        text.textContent = explainFailure(r);
        setBadge($("tt-decode-badge"), "bad", r.reason === "needpass" ? "Password protected 🔒" : "Not revealed ✕");
        if (r.reason === "needpass" || r.reason === "wrongpass") $("tt-diag").hidden = true;
        else renderDiag(r);
        $("tt-decode-actions").hidden = true;
      }
    }

    async function unlockResult(r) {
      const password = $("tt-decode-password").value;
      if (!password) return { ok: false, reason: "needpass", detail: {}, scan: r.scan };
      if (!(window.crypto && crypto.subtle)) return { ok: false, reason: "wrongpass", detail: {}, scan: r.scan };
      try {
        const message = await decryptSecret(r.payload, password);
        return { ok: true, message, scan: r.scan };
      } catch (e) {
        return { ok: false, reason: "wrongpass", detail: {}, scan: r.scan };
      }
    }

    function handleDecode() {
      const input = $("tt-decode-input").value;
      if (!input.trim()) { nudge($("tt-decode-input")); toast("Paste the text you want to inspect first", "warn"); return; }

      const result = decodeMessage(input);
      const seq = ++decodeSeq;

      clearTimeout(decodeTimer);
      clearInterval(typeTimer);
      $("tt-decode-result-box").hidden = false;
      $("tt-diag").hidden = true;
      $("tt-decode-actions").hidden = true;
      setBadge($("tt-decode-badge"), "", "");
      $("tt-decoded-output").className = "result scanning";
      $("tt-decoded-text").textContent = "Inspecting…";
      $("tt-decode-result-box").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });

      decodeTimer = setTimeout(async () => {
        let final = result;
        if (result.ok && result.encrypted) final = await unlockResult(result);
        if (seq !== decodeSeq) return;
        showDecodeResult(final);
        if (!final.ok && final.reason === "needpass") $("tt-decode-password").focus();
        else if (!final.ok && final.reason === "wrongpass") nudge($("tt-decode-password"));
      }, reduceMotion ? 0 : 700);
    }

    async function handlePaste() {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) { toast("The clipboard is empty", "warn"); return; }
        $("tt-decode-input").value = text;
        updateDetectHint();
        toast("Pasted from the clipboard");
      } catch (e) {
        $("tt-decode-input").focus();
        toast("Automatic paste is unavailable; long-press inside the box, then paste", "warn");
      }
    }

    // Wiring
    $("tt-tab-encode").addEventListener("click", () => switchTab("encode"));
    $("tt-tab-decode").addEventListener("click", () => switchTab("decode"));
    $("tt-encode-btn").addEventListener("click", handleEncode);
    $("tt-copy-btn").addEventListener("click", handleCopy);
    $("tt-test-btn").addEventListener("click", testCurrentMessage);
    $("tt-decode-btn").addEventListener("click", handleDecode);
    $("tt-paste-btn").addEventListener("click", handlePaste);
    $("tt-clear-btn").addEventListener("click", () => {
      $("tt-decode-input").value = "";
      $("tt-decode-password").value = "";
      $("tt-decode-result-box").hidden = true;
      updateDetectHint();
      $("tt-decode-input").focus();
    });
    $("tt-copy-secret-btn").addEventListener("click", async () => {
      const ok = await copyText(lastSecret);
      toast(ok ? "Secret message copied ✓" : "Automatic copy failed", ok ? "" : "warn");
    });
    $("tt-decode-input").addEventListener("input", updateDetectHint);
    $("tt-secret-password").addEventListener("input", () => {
      const has = $("tt-secret-password").value.length > 0;
      $("tt-secret-password2").hidden = !has;
      $("tt-password-warn").hidden = !has;
      if (!has) $("tt-secret-password2").value = "";
    });
    $("tt-decode-password").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); handleDecode(); }
    });
    $("tt-secret-text").addEventListener("input", () => {
      const bytes = new TextEncoder().encode($("tt-secret-text").value).length;
      $("tt-secret-count").textContent = bytes + (bytes === 1 ? " byte" : " bytes");
    });
    $("tt-visible-text").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); $("tt-secret-text").focus(); }
    });
    document.querySelectorAll(".mode").forEach((btn) => {
      btn.addEventListener("click", () => setMode(btn.dataset.mode));
    });

    if (navigator.share) $("tt-share-btn").hidden = false;
    $("tt-share-btn").addEventListener("click", handleShare);

    setMode(mode);
})();
