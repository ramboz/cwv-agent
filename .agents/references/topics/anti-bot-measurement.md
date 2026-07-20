# Topic: Measuring sites behind Cloudflare / anti-bot managed challenges

Some customer sites front their pages with **Cloudflare's managed-challenge /
Turnstile** tier (markers: a `cdn-cgi/challenge-platform/.../chl_page` script +
`challenges.cloudflare.com/turnstile/api.js`, page title "Just a moment…"). The
default headless lab tooling gets a **403 challenge stub** instead of the real
page — so CWV measurement reads garbage (e.g. lilly-family domains:
`lilly.com`, `zepbound.lilly.com`).

This is **not** defeated by UA/header spoofing alone. The managed challenge
fingerprints three layers: the JS runtime (`navigator.webdriver`, headless
signals), HTTP (UA / client-hint consistency), and TLS (JA3 — bundled Chromium's
ClientHello differs from a real browser's). The decisive factors in practice are
the **automation tells + the headless runtime**, not the UA.

## The recipe that passes (verified live 2026-06-11, zepbound.lilly.com)

Use **headful real Chrome** with the automation tells scrubbed:

- `channel: 'chrome'` — real Google Chrome, not bundled Chromium (real TLS).
- **`headless: false`** — **mandatory**. `headless: 'new'` with the *same* scrub
  still gets a 403. Headful pops a real Chrome window per run.
- `ignoreDefaultArgs: ['--enable-automation']` + `args: ['--disable-blink-features=AutomationControlled']`.
- `evaluateOnNewDocument`: patch `navigator.webdriver → undefined`, `languages`,
  `window.chrome`.
- **Do NOT override the UA** on desktop — `channel:chrome` ships a self-consistent
  UA; a spoofed UA reintroduces a mismatch.
- **Mobile:** `page.emulate(iPhone)` sets an iOS-Safari UA on a Chromium runtime —
  exactly the mismatch CF flags. Keep the iPhone *viewport* but pair it with an
  **Android-Chrome UA** so UA ↔ runtime/TLS are consistent.

Result on zepbound `/savings`: real page (25 EDS assets, mobile CLS 0.72 / desktop
0.43, ≈ field) vs the headless stub's 7 resources + fake CLS 0.001.

In the launcher this is the **`--stealth`** flag (opt-in; default headless
unchanged). The browser-owning analyzers (`coverage.js`, `image-analysis.js`)
accept the same flag and use the same shared launch recipe, so a CF-fronted
diagnosis must pass `--stealth` consistently across launcher + analyzers.
`oracle.js` only compares saved launcher JSON; it does not launch a browser.

## curl still works for source-fetch

CF does **not** challenge `curl` with a browser UA — it returns the real HTML.
So `cwv-source-fetch --no-browser` (curl transport + raw-HTML block enumeration)
is the right path for pulling source behind CF; only the **browser** steps
(diagnose lab, validate) need `--stealth`.

## When `--stealth` still isn't enough

The TLS layer can't be changed from Puppeteer. If a site runs CF's stricter
"I'm Under Attack" / enterprise bot management, even headful real-Chrome may be
challenged. Fallbacks: ask the site operator to allowlist the test IP/UA, or run
from an environment the customer has whitelisted.

## Ethics / scope

Only for **authorized** performance work on sites we are engaged to optimize.
`--stealth` mimics a real user's browser to measure the real page — it is not a
general anti-bot-evasion tool. Throttle requests (prod rate-limits with 429).
