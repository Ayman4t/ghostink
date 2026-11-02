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
    const payload = JSON.stringify({
      name, email, message,
      topic: form.elements.topic.value,
      _subject: 'GhostInk — ' + form.elements.topic.value + ' from ' + name,
      _replyto: email, _captcha: 'false', _template: 'table', _honey: ''
    });
    const done = () => { form.reset(); say('Thank you! Your message was sent. We will reply by email.', 'ok'); btn.disabled = false; btn.textContent = old; };
    const fallback = () => { say('Sending…', 'ok'); form.submit(); };   // normal FormSubmit POST (handles activation page)
    // FormSubmit can take many seconds to answer while it sends the email. Start the request (keepalive so it
    // survives navigation), and if it has not failed after 1.5 s, confirm to the visitor right away.
    let settled = false;
    const request = fetch(url, { method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: payload })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || String(data.success) === 'false') throw new Error(data.message || 'Request failed');
      });
    const early = new Promise((r) => setTimeout(() => r('early'), 1500));
    try {
      const first = await Promise.race([request.then(() => 'ok'), early]);
      settled = true;
      done();
      if (first === 'early') request.catch(() => { say('Sorry, the message could not be sent. Please try again in a moment.', 'err'); });
    } catch (err) {
      if (!settled) { btn.disabled = false; btn.textContent = old; fallback(); }
    }
  });
})();
