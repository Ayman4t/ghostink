(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  let timer;
  const SS = window.SS = {
    toast(message, kind) {
      const el = $('#toast'); el.textContent = message;
      el.className = 'toast show' + (kind === 'err' ? ' err' : '');
      clearTimeout(timer); timer = setTimeout(() => { el.className = 'toast'; }, 3600);
    }
  };

  // Tool switcher (#text, #text-image, #image)
  const TOOLS = ['text', 'text-image', 'image'];
  function pick(tool, push) {
    if (!TOOLS.includes(tool)) tool = 'text';
    $$('[data-tool]').forEach((b) => { const on = b.dataset.tool === tool; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    $$('[data-tool-panel]').forEach((p) => { p.hidden = p.dataset.toolPanel !== tool; });
    if (push) history.replaceState(null, '', '#' + tool);
  }
  $$('[data-tool]').forEach((b) => b.addEventListener('click', () => pick(b.dataset.tool, true)));
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (TOOLS.includes(h)) pick(h); });
  pick(location.hash.slice(1));

  // Show / hide password (text tools)
  $$('.pw-eye').forEach((b) => b.addEventListener('click', () => {
    const i = document.getElementById(b.dataset.target); i.type = i.type === 'password' ? 'text' : 'password';
  }));

  // UV flashlight that follows the pointer
  let frame = 0;
  const move = (e) => { if (frame) return; frame = requestAnimationFrame(() => { frame = 0; const r = document.documentElement.style; r.setProperty('--mx', e.clientX + 'px'); r.setProperty('--my', e.clientY + 'px'); }); };
  window.addEventListener('pointermove', move, { passive: true });
})();
