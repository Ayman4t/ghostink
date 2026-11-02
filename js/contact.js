(() => {
  'use strict';
  const form = document.getElementById('contact-form');
  if (!form) return;
  const btn = document.getElementById('cf-submit');
  const box = document.getElementById('cf-status');
  const say = (msg, kind) => { box.hidden = false; box.className = 'form-status ' + kind; box.textContent = msg; };

  // Returned from the no-JS fallback redirect
  if (new URLSearchParams(location.search).get('sent') === '1') say('Thank you! Your message was sent. We will reply by email.', 'ok');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.elements._honey.value) return;                       // bot: silently stop
    const name = form.elements.name.value.trim();
    const email = form.elements.email.value.trim();
    const message = form.elements.message.value.trim();
    if (!name || !message) return say('Please fill in your name and message.', 'err');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return say('Please enter a valid email address.', 'err');

    // The only config is the form action: https://formsubmit.co/<inbox email or alias>
    const action = form.getAttribute('action');
    if (/YOUR_EMAIL_HERE/.test(action)) return say('The contact form is not connected to an inbox yet.', 'err');
    const url = action.replace('formsubmit.co/', 'formsubmit.co/ajax/');

    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Sending…';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          name, email, message,
          topic: form.elements.topic.value,
          _subject: 'GhostInk — ' + form.elements.topic.value + ' from ' + name,
          _replyto: email, _captcha: 'false', _template: 'table', _honey: ''
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || String(data.success) === 'false') throw new Error(data.message || 'Request failed');
      form.reset();
      say('Thank you! Your message was sent. We will reply by email.', 'ok');
    } catch (err) {
      // AJAX can fail before the inbox is activated (or if the browser blocks it): fall back to a normal
      // FormSubmit POST, which also shows FormSubmit's own activation / thank-you page.
      say('Sending…', 'ok');
      form.submit();
      return;
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  });
})();
