# Stack Detection

## Overview

Core Web Vitals optimizations are **stack-specific**, and the wrong advice for a given platform is actively harmful — not just unhelpful. A few canonical examples:

- **"Inline critical CSS"** is textbook generic advice — but on platforms with a managed eager/lazy CSS split it breaks the split and bypasses the CDN cache.
- **"Preload the LCP image"** is a standard Lighthouse suggestion — but some CDNs already emit a `Link: rel=preload` header for eager images, causing a duplicate fetch.
- **"Edit the CDN config"** is reasonable on self-operated CDNs — on managed platforms the edge config is operator-managed and site changes are blocked.

So: **detect the stack before recommending anything**. Detecting correctly means the advice applies; detecting wrong means the advice is at best ignored and at worst actively regresses the site.

This doc lists the detection heuristics — DOM fingerprints, URL patterns, bundle signatures — for common stacks. Use it as a checklist when beginning an audit. A stack pack under `.agents/references/stacks/` can add its own fingerprints and per-stack guidance (see `stacks/_FORMAT.md`).

## Signals by stack

### Next.js

| Signal | Weight |
|--------|--------|
| `_next/static/` asset paths | HIGH |
| `<script id="__NEXT_DATA__" type="application/json">` | HIGH |
| `next/script` runtime references | MEDIUM |
| `__next` root element | MEDIUM |

### Nuxt

| Signal | Weight |
|--------|--------|
| `_nuxt/` asset paths | HIGH |
| `window.__NUXT__` or `<script>window.__NUXT__=...</script>` | HIGH |
| `<div id="__nuxt">` root element | MEDIUM |

### React (generic, non-Next)

| Signal | Weight |
|--------|--------|
| `data-reactroot` attribute on root element | MEDIUM |
| `react-dom.production.min.js` in bundle | MEDIUM |
| React devtools hook (`__REACT_DEVTOOLS_GLOBAL_HOOK__`) referenced | LOW |

### WordPress

| Signal | Weight |
|--------|--------|
| `/wp-content/` asset paths | HIGH |
| `/wp-includes/` script paths | HIGH |
| `wp-emoji` inline script or stylesheet | MEDIUM |
| `<meta name="generator" content="WordPress ...">` | HIGH |

## Priority / ambiguity

Stacks compose. When multiple detections fire, follow these rules:

- **Outermost wins.** A Next.js site built on React still reports as **Next.js** — the platform-specific advice (Next-image, `<Script>`, App Router conventions) supersedes generic React advice. If both fire, prefer the more specific stack.
- **Component islands.** Component-based sites sometimes embed React islands (e.g., product configurators). Classify by the host stack but note the React regions when reviewing INP — they need React-specific scheduling.
- **WordPress + React.** Headless WP setups often ship a React shell with WP data. If `/wp-content/` and React fingerprints both fire, treat as WordPress for backend/TTFB advice and React for frontend/INP advice.

When a draw occurs (two types tied at max score), return unclassified rather than guess.

## Confidence scoring

Use a weighted count:

- **HIGH signal** = 3 points. Unique paths (`_next/static/`, `/wp-content/`) or decisive markers (generator meta, framework globals). One HIGH is usually enough.
- **MEDIUM signal** = 1 point. Class-name conventions or generic markers that could be spoofed.
- **LOW signal** = 0.5 points. Generic cues that occur in many stacks.

**Rule of thumb**:
- At least **one HIGH** signal, OR
- **Two MEDIUM** signals

...before declaring a stack. Below that threshold, treat as unclassified — ask the human operator or pull more evidence before giving stack-specific advice.

For decisive indicators (e.g., `_next/static/` for Next.js, the WordPress generator meta), apply large extra weights (+3 to +5) on top of the baseline pattern count — effectively promoting a single decisive signal to sufficient.

## What to do when detected

Once the stack is classified:

1. Note the detection in the audit write-up ("Detected stack: WordPress, confidence HIGH based on `/wp-content/` + generator meta").
2. Pull the corresponding stack reference doc under `.agents/references/stacks/`
   and read it before giving advice. (Stacks not documented — note the gap and
   proceed with platform-agnostic advice, flagging what's unverified.)
3. Re-check any recommendations against the stack's "anti-patterns" and "blocked by platform" sections before presenting — this is where generic advice goes wrong.
4. When the stack is **ambiguous** (two fire, no decisive), say so explicitly in the write-up. Do not guess; ambiguity itself is useful evidence for the operator.
