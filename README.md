# GhostInk — Invisible Ink

Free steganography studio: three tools in one static, browser-only site (no build step, no server, no uploads).

| Page | URL | What it is |
|---|---|---|
| Home | `/` | Landing page: the 3 features, how it works, FAQ |
| Studio | `/studio` | The tools (deep-link with `#text`, `#text-image`, `#image`) |
| About | `/about` | About us |
| Contact | `/contact` | Contact form (FormSubmit.co) |

| Tool | What it does |
|---|---|
| Text in Text | Hides a message inside an ordinary sentence using invisible Unicode characters |
| Text in Image | Hides a message in an image (PNG lossless, or JPEG-robust DCT mode) |
| Image in Image | Hides a whole image inside another (PNG, or JPEG/WhatsApp-robust mode with Reed-Solomon) |

All three support optional AES-256-GCM (PBKDF2-SHA256) protection.

## Image in Image — compression-resistant mode: reliability settings
New files are written with **every bit stored twice (repeat ×2)**, a stronger QIM step (**`RB_K_ENCODE = 2.6`**) and the secret sized to **80 % of the repeat-2 capacity** (`ROBUST_PROFILES.reliable` in `js/image-image.js`). The decoder tries strengths 2.6, 1.8 and 1.0 and keeps trying after an error-correction failure, so files made by older builds still open. Trade-off: the hidden copy is smaller (about 20 KB on a 1536×1024 cover instead of about 50 KB), in exchange for surviving much heavier or repeated JPEG re-compression. If you change `js/robust.js` or `js/image-worker.js`, regenerate `js/worker-source.js` (it embeds both).

## Small-cover protection
A cover image that is too small is refused at upload time (red alert + toast, the file is not added) instead of failing later. Image in Image: at least 200×200 px (`COVER_MIN_*` in `js/image-image.js`), plus the exact capacity check for resistant mode, re-checked when that switch is toggled. Text in Image: at least 100×100 px and 100 bytes of capacity (`MIN_COVER_*` in `js/text-image.js`); if only resistant mode is too small, PNG is selected automatically.

## Languages (English / Arabic)
The header has a language switch. The first visit follows the browser language; the choice is remembered. All Arabic text lives in `js/i18n.js` (generated dictionary + regex rules for dynamic messages) and the page flips to RTL automatically. Smart helpers (password strength, paste-detection of hidden text) are in `js/smart.js`. Theme/RTL styles: `css/theme.css`.

## Before you publish: 2 things to fill in

1. **Your domain (SEO).** Canonical URLs, Open Graph, JSON-LD, `sitemap.xml` and `robots.txt` use the placeholder `https://YOUR-DOMAIN.com`. Replace it everywhere:

       grep -rl "YOUR-DOMAIN.com" . | xargs sed -i 's#https://YOUR-DOMAIN.com#https://your-real-domain.com#g'

2. **Contact form inbox.** In `contact.html` replace `YOUR_EMAIL_HERE` in the form `action` with the email that should receive messages, e.g. `action="https://formsubmit.co/you@example.com"`. (Also set the same domain in the hidden `_next` field — step 1 does it.)

   **Activate the form (one time):** deploy, open `/contact`, send one test message. FormSubmit emails that inbox an *activation* link; click it once. After that, every message arrives in your inbox. FormSubmit then also gives you a random alias (in the activation email) you can use instead of your real email in the `action`, so the address is not exposed in your page source.

## SEO checklist (already done)

- Unique `<title>`, meta description, canonical, robots and one `<h1>` per page
- Open Graph + Twitter cards with `og-image.png` (1200×630)
- JSON-LD: WebSite, Organization, WebApplication, FAQPage (home), AboutPage, ContactPage, BreadcrumbList
- `sitemap.xml`, `robots.txt`, favicons (SVG + 32px PNG + apple-touch-icon), custom `404.html` (noindex)
- Semantic landmarks, skip link, descriptive link text, FAQ content that matches its FAQPage markup

After deploying: add the site in [Google Search Console](https://search.google.com/search-console) and [Bing Webmaster Tools](https://www.bing.com/webmasters), submit `https://your-real-domain.com/sitemap.xml`, and use *URL Inspection → Request indexing* on the home page.

## Run locally
`/studio`, `/about` and `/contact` are clean URLs (like on Vercel), so serve with something that supports them:

    npx serve .            # then open http://localhost:3000

(`python -m http.server` works too, but use `/studio.html` etc. in the address bar.)

## Deploy
Push to Vercel as a static site. `vercel.json` sets clean URLs, strict security headers, and a per-route CSP: every page is `connect-src 'none'` except `/contact`, which may only talk to `formsubmit.co`. The tools themselves can never make network requests.

## Layout
    index.html          home / landing page
    studio.html         the three tools
    about.html          about us
    contact.html        contact form
    404.html            not-found page
    css/styles.css      app design system
    css/site.css        marketing pages (nav, hero, cards, FAQ, forms)
    js/core.js          tool switcher, toast, shared helpers (studio)
    js/site.js          pointer light (marketing pages)
    js/contact.js       contact form → FormSubmit AJAX
    js/text-text.js     tool 1 (codec + UI)
    js/text-image.js    tool 2 (LSB + DCT engines + UI)
    js/image-image.js   tool 3 UI
    js/image-worker.js  tool 3 worker (imports robust.js)
    js/robust.js        tool 3 JPEG-robust engine
    js/worker-source.js generated: worker + robust.js as one string (re-generate after editing either)
    robots.txt, sitemap.xml, og-image.png, favicon.svg, favicon-32.png, apple-touch-icon.png

## Terms of Use & Disclaimer
GhostInk is provided "as is", without warranty of any kind. The authors and operators are **not responsible** for any loss, damage, failed extraction, lost passwords, disclosure of information or other consequences resulting from incorrect, improper or unlawful use of the tools (for example: not copying text exactly, sending images as compressed photos, cropping/resizing outputs, using the wrong mode or password), from third-party apps that alter or strip data, or from the security of the user's own device. Steganography does not guarantee secrecy. Use the tools only for lawful purposes. The full text is shown on the site under "Terms of Use & Disclaimer" (`/studio#terms`).

---
Made by AymanStack
