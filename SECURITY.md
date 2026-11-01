# Security notes
- Strict CSP (`vercel.json` + `<meta>`): same-origin scripts only, no inline script or `eval`, `connect-src 'none'` (no network calls), framing blocked.
- No cookies, analytics or storage beyond a remembered text-mode preference.
- User text is inserted with `textContent`; crypto is AES-256-GCM with PBKDF2-SHA256 in the browser.
- Steganography hides that a message exists; it does not stop specialist detection. Use a password for confidentiality.
- Enable 2FA on your Vercel/GitHub accounts and keep the repo private if you do not want old project history public.
- Disclaimer: the tools are provided "as is". Misuse, incorrect use, lost passwords, third-party apps that alter files, or an insecure user device are the user's responsibility and the authors are not liable for resulting loss or damage. See the Terms of Use & Disclaimer on the site.
