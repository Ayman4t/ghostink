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
})();
