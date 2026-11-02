/* GhostInk smart helpers (studio): password strength, smart paste detection. Local only. */
(() => {
  'use strict';
  const T = (s) => (window.GI ? window.GI.t(s) : s);
  const $ = (s, r = document) => r.querySelector(s);

  /* ---------- password strength meter ---------- */
  const LEVELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Excellent'];
  const COLORS = ['#ff7a8a', '#ffa45e', '#ffd05a', '#7fe8b4', '#35f0c4'];
  function score(pw) {
    if (!pw) return -1;
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/\d/.test(pw)) pool += 10;
    if (/[^\w\s]/.test(pw)) pool += 33;
    if (/[^\x00-\x7F]/.test(pw)) pool += 60;         // Arabic and other scripts
    let bits = pw.length * Math.log2(Math.max(pool, 2));
    if (/^(.)\1+$/.test(pw)) bits = 4;                 // aaaaaa
    if (/(0123|1234|2345|3456|abcd|qwer|password|123456|admin|ghost)/i.test(pw)) bits *= 0.5;
    const uniq = new Set(pw).size; if (uniq < pw.length / 2) bits *= 0.6;
    return bits < 28 ? 0 : bits < 40 ? 1 : bits < 58 ? 2 : bits < 78 ? 3 : 4;
  }
  function attachMeter(input) {
    if (!input || input.dataset.meter) return;
    input.dataset.meter = '1';
    const box = document.createElement('div');
    box.className = 'pw-meter'; box.hidden = true;
    box.innerHTML = '<div class="pw-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><span class="pw-label" role="status" aria-live="polite"></span>';
    const anchor = input.closest('.pw-wrap, .password-input-wrap') || input;
    anchor.insertAdjacentElement('afterend', box);
    const bars = [...box.querySelectorAll('i')], label = box.querySelector('.pw-label');
    const paint = () => {
      const v = score(input.value);
      box.hidden = v < 0;
      if (v < 0) return;
      bars.forEach((b, i) => { b.style.background = i <= v ? COLORS[v] : ''; });
      label.textContent = T('Password strength') + ': ' + T(LEVELS[v]);
      label.style.color = COLORS[v];
    };
    input.addEventListener('input', paint);
    window.addEventListener('gi:lang', paint);
  }
  ['tt-secret-password', 'ti-pw1', 'encode-password'].forEach((id) => attachMeter(document.getElementById(id)));

  /* ---------- smart paste: detect hidden characters anywhere on the page ---------- */
  function payloadCount(text) {
    let n = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if ((c >= 0xFE00 && c <= 0xFE0F) || (c >= 0xE0100 && c <= 0xE01EF) || (c >= 0xE0000 && c <= 0xE007F) ||
          (c >= 0x200B && c <= 0x200D) || c === 0x2060 || (c >= 0x2062 && c <= 0x2064) || c === 0xFEFF) n++;
    }
    return n;
  }
  document.addEventListener('paste', (e) => {
    const t = e.target;
    if (t && t.id === 'tt-decode-input') return;                       // already in the right box
    const text = e.clipboardData && e.clipboardData.getData('text');
    if (!text || payloadCount(text) < 8) return;
    // typing a secret into the hide form must not be hijacked: only act outside text fields
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    if (location.hash !== '#text') { history.replaceState(null, '', '#text'); window.dispatchEvent(new HashChangeEvent('hashchange')); }
    const tab = document.getElementById('tt-tab-decode'); if (tab) tab.click();
    const box = document.getElementById('tt-decode-input');
    if (box) { box.value = text; box.dispatchEvent(new Event('input', { bubbles: true })); box.focus(); }
    if (window.SS) window.SS.toast(T('Hidden characters found in your clipboard — opened in Reveal.'));
  });
})();
