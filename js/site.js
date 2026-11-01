(() => {
  'use strict';
  const root = document.documentElement.style;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Page-wide soft light that follows the pointer
  let frame = 0;
  window.addEventListener('pointermove', (e) => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; root.setProperty('--mx', e.clientX + 'px'); root.setProperty('--my', e.clientY + 'px'); });
  }, { passive: true });

  // UV torch on the home-page note: follows the pointer, drifts by itself when idle
  const scene = document.getElementById('torch-scene');
  if (scene) {
    const set = (x, y) => { scene.style.setProperty('--hx', x + 'px'); scene.style.setProperty('--hy', y + 'px'); };
    let user = false, t = 0;
    const idle = () => {
      if (!user) { const r = scene.getBoundingClientRect(); t += 0.011; set(r.width * (0.5 + 0.36 * Math.sin(t)), r.height * (0.5 + 0.3 * Math.sin(t * 1.7 + 1))); }
      requestAnimationFrame(idle);
    };
    scene.addEventListener('pointermove', (e) => { user = true; const r = scene.getBoundingClientRect(); set(e.clientX - r.left, e.clientY - r.top); });
    scene.addEventListener('pointerleave', () => { user = false; });
    if (reduce) { const r = scene.getBoundingClientRect(); set(r.width * 0.5, r.height * 0.5); } else { idle(); }
  }

  // Headline "decrypt" effect: scrambled glyphs resolve into the real text (once, on load)
  const GLYPHS = '01#$%&*+=<>/\\|~^?!ABCDEFabcdef';
  document.querySelectorAll('[data-decode]').forEach((h) => {
    if (reduce) return;
    if (!h.hasAttribute('aria-label')) h.setAttribute('aria-label', h.textContent.replace(/\s+/g, ' ').trim());
    const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
    const nodes = []; let n; while ((n = walker.nextNode())) if (n.nodeValue.trim()) nodes.push(n);
    const items = [];
    nodes.forEach((node) => {
      const frag = document.createDocumentFragment();
      for (const ch of node.nodeValue) {
        if (/\s/.test(ch)) { frag.appendChild(document.createTextNode(ch)); continue; }
        const sp = document.createElement('span'); sp.textContent = ch; sp.setAttribute('aria-hidden', 'true');
        items.push({ sp, ch, at: 0 }); frag.appendChild(sp);
      }
      node.replaceWith(frag);
    });
    const total = 1100, start = performance.now();
    items.forEach((it, i) => { it.at = 150 + (i / items.length) * (total - 150) + Math.random() * 120; });
    (function tick(now) {
      const t = now - start; let left = 0;
      items.forEach((it) => {
        if (t >= it.at) { if (it.sp.textContent !== it.ch) { it.sp.textContent = it.ch; it.sp.classList.remove('dc-x'); } }
        else { left++; it.sp.textContent = GLYPHS[(Math.random() * GLYPHS.length) | 0]; it.sp.classList.add('dc-x'); }
      });
      if (left) requestAnimationFrame(tick);
      else { items.forEach((it) => { it.sp.removeAttribute('aria-hidden'); }); }
    })(start);
  });
})();
