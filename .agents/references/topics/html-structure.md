# HTML Structural Parse

## Why raw HTML matters

Puppeteer-based measurement (`measure-cwv.js` + `collect-resources.js`) captures what the **rendered** page does: PerformanceResourceTiming entries, LCP candidates, CLS deltas. Coverage analysis and HAR capture see the network sequence. But some CWV problems are baked into the server-rendered HTML itself, *before* any browser behavior:

- A render-blocking `<script>` is a problem the moment you read the bytes — no page load needed to diagnose it.
- A `<img>` with no `width`/`height` will shift, regardless of what the network timing shows.
- A `<link rel="preconnect">` to an analytics host commits a connection slot before a single pixel renders.

Raw-HTML inspection is the fastest, cheapest tier: one `GET`, no JS execution. It complements — does not replace — the measurement tier. Evidence from this analyzer is capped at **confidence 0.75** (tier 3, see [finding-schema.md](./finding-schema.md)) because we have no runtime measurement to ground it.

Use this analyzer to:
- Seed `cwv-diagnose` with structural candidates before running the Puppeteer launcher.
- Back up timing-based findings with structural evidence (dual-sourced findings get merged `mergedSources=["html", "har"]`).
- Flag regressions that ship in static markup (CI gate).

## The 10 heuristics

Each heuristic corresponds to a `ruleId` and emits a `rule-violation` evidence entry. See [rules.md](./rules.md) for the registry convention.

### 1. `html/blocking-script-in-head`

Any `<script src="…">` in `<head>` without `async`, `defer`, or `type="module"` blocks the HTML parser.

```html
<!-- BAD: blocks parser + LCP -->
<head><script src="/app.js"></script></head>

<!-- GOOD: defer preserves order, doesn't block parser -->
<head><script src="/app.js" defer></script></head>
```

One finding per blocking `src` (deduped). Impact: 150ms LCP per script (heuristic).

### 2. `html/img-missing-dimensions`

`<img>` in the first ~10KB of `<body>` (above-the-fold proxy) without both `width` AND `height` attributes causes CLS when the image loads.

```html
<!-- BAD: layout shift when hero loads -->
<img src="/hero.jpg" alt="hero">

<!-- GOOD: intrinsic box reserved -->
<img src="/hero.jpg" width="1200" height="600" alt="hero">
```

Impact: 0.05 CLS per image.

**This is a HYPOTHESIS, not a confirmed root cause (G3).** Static HTML can't tell
whether the image is visible, sized by CSS/`aspect-ratio`, or actually shifts — so
this rule emits `rootCause: false` at low confidence (≤0.5), framed as a candidate
to confirm at runtime via `launcher.js --scroll` (whose observed `LayoutShift`
sources feed the authoritative CLS analyzer, chain-rum-correlator C6). Analytics
**tracking beacons** (Comscore/scorecardresearch, GA, GTM, FB pixel, doubleclick,
`/pixel|/beacon|/collect|/track` paths) are skipped — they're invisible (1×1 /
`display:none`) and cause no layout shift; flagging them was a false positive
(otempo fingered a Comscore pixel as a CLS rootCause).

### 3. `html/lcp-candidate-missing-fetchpriority`

The first "large-looking" `<img>` in markup (excludes obvious icons, sprites, tiny explicit dims) should signal high priority so the browser fetches it before render-blocking CSS completes discovery of other resources.

```html
<!-- BAD: browser discovers hero late -->
<img src="/hero.jpg" width="1200" height="600" alt="hero">

<!-- GOOD: or add <link rel=preload as=image href=/hero.jpg fetchpriority=high> -->
<img src="/hero.jpg" width="1200" height="600" fetchpriority="high" alt="hero">
```

Impact: 200ms LCP. One finding per page (the first candidate only).

### 4. `html/missing-viewport-meta`

No `<meta name="viewport">` → mobile browsers scale the page to desktop width and reflow, destroying LCP and causing CLS after the browser picks a "better" size.

```html
<!-- MUST have -->
<meta name="viewport" content="width=device-width, initial-scale=1">
```

Impact: 300ms LCP (mobile). Severity forced to `medium`.

### 5. `html/stylesheet-not-preloaded`

The first external render-blocking stylesheet has no `<link rel=preload as=style>` hint. Preloading (or inlining a critical subset) shaves the gap between HTML parse and CSSOM ready.

```html
<!-- BAD: CSS discovered when parser reaches the stylesheet tag -->
<link rel="stylesheet" href="/app.css">

<!-- GOOD: preload hint discovered earlier -->
<link rel="preload" as="style" href="/app.css">
<link rel="stylesheet" href="/app.css">
```

Impact: 200ms LCP. Only one finding per page (the first stylesheet).

### 6. `html/large-inline-script-in-head`

Inline `<script>` block in `<head>` exceeding 5KB blocks parsing while the engine compiles/executes. At that size, moving to an external deferred asset almost always wins.

Impact: 200ms FCP per block. `type: waste`.

### 7. `html/favicon-before-stylesheet`

`<link rel="icon">` before the first `<link rel="stylesheet">` gives a low-priority resource an early slot in the browser's resource discovery queue.

```html
<!-- BAD -->
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/app.css">

<!-- GOOD -->
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="/favicon.ico">
```

Impact: 150ms LCP. Severity forced to `low`.

### 8. `html/preconnect-to-deferrable`

`<link rel="preconnect">` or `<link rel="dns-prefetch">` to a DEFERRABLE-tier host (analytics, session replay, consent, chat, social pixels) subsidizes a non-critical chain and steals connection slots from real LCP origins. The list is cross-referenced to [martech.md](./martech.md) DEFERRABLE tier:

- `google-analytics.com`, `googletagmanager.com`, `doubleclick.net`
- `facebook.com`, `connect.facebook.net`, `linkedin.com`, `licdn.com`
- Segment, Hotjar, FullStory, Mouseflow, Clarity
- Sentry, Datadog, New Relic
- OneTrust, Cookiebot, TrustArc
- Intercom, Drift, Zendesk

```html
<!-- BAD: subsidizes analytics on the critical path -->
<link rel="preconnect" href="https://www.google-analytics.com">

<!-- GOOD: remove the hint; let GA load post-LCP -->
```

Impact: 200ms LCP per hint. `type: waste`.

### 9. `html/inline-svg-in-body`

Large inline SVG payloads in early `<body>` markup bloat the main document and
force the browser to tokenize and build vector DOM before first paint. This rule
flags meaningful payloads only: the largest early inline SVG must be at least
2KB or aggregate early inline SVG payload must be at least 6KB. Tiny semantic
icons are ignored because keeping them inline is often a reasonable styling or
accessibility tradeoff.

```html
<!-- BAD when large/repeated: SVG payload ships inside the document -->
<svg viewBox="0 0 1200 800">...</svg>

<!-- GOOD for decorative/reusable artwork -->
<img src="/media/illustration.svg" loading="lazy" alt="">
```

Impact: 150ms FCP heuristic. `type: waste`, `rootCause: false`; confirm with
launcher/coverage evidence before treating SVG externalization as the dominant
fix.

### 10. `html/eds-structural-contract`

On AEM EDS pages, the analyzer inspects top-level sections under `<main>` and
source-visible reveal rules. It emits one structural finding when the page
appears to violate the EDS reveal/page-shape contract:

- first meaningful/LCP-like content is several sections down the page;
- spacer, transparent, metadata, CSS-only, or tab-shell sections precede
  meaningful content;
- source-visible CSS or comments suggest body/section reveal gating has been
  removed, contradicted, or bypassed;
- authored spacer sections appear to compensate for a floating header or delayed
  block hydration.

The finding uses `metric: ["CLS", "LCP"]`, `type: "bottleneck"`,
`source: "html"`, and carries:

```json
{
  "structuralGate": {
    "name": "eds-structural-contract",
    "result": "fail",
    "reasons": [
      "First meaningful section is section 6, after placeholder or shell sections."
    ]
  }
}
```

Evidence lives in `evidence[].data.context`: section count, first meaningful
section, placeholder/spacer/tab-shell counts, reveal-rule signals, and the first
sections' classes/text. Static confidence is capped at 0.75. Confirm ambiguous
cases with `launcher.js --eds-structure-snapshot`, especially on WAF-protected
origins where static fetch fails.

## Limits of regex parsing

The analyzer uses regex to extract `<head>`/`<body>` regions and tag attributes. This is tractable because we only need attribute reads on a well-known set of tags (`<link>`, `<script>`, `<meta>`, `<img>`). It is **not** a general-purpose HTML parser and fails on:

- Malformed HTML (unclosed `<head>`, missing `</body>`).
- Content-Security-Policy'd pages where the server returns a shim and the real DOM is built by JS (SPA shells).
- Exotic comment nesting or CDATA blocks containing tag-like strings.
- Attributes whose values contain literal `>` (RFC-legal but rare).
- Dynamically injected `<head>` content (framework-generated, Next.js `<Head>`, etc.) that appears only after hydration.

**WAF / bot protection.** This analyzer fetches with a non-browser User-Agent
(`cwv-agent/html-parse`), so origins behind a bot-mitigation WAF (Akamai, Cloudflare managed
challenge) often return **403 / a challenge page** instead of the real HTML — the analyzer then
errors or parses the block page. Real headless Chrome (`launcher.js`) usually passes these checks
(and a hardened *headful* Chrome passes the aggressive ones — see the `--stealth` path). On a
WAF-protected origin, **skip html-parse and rely on the Puppeteer-based analyzers**
(`launcher.js`, `coverage.js`, `image-analysis.js`) — they exercise the real rendered DOM.
(about.ups.com 403s curl/fetch but returns 200 to headless Chrome.)

When `--output` is supplied and the fetch fails, `html-parse.js` writes a
zero-finding error envelope with `meta.error` instead of leaving no artifact.
Keep that envelope in the diagnosis bundle; it explains why static evidence is
absent and points the workflow toward browser-captured DOM snapshots.

When a finding from this analyzer conflicts with measured evidence — e.g. this analyzer says "no preload hint" but `collect-resources.js` shows the CSS loaded with `priority: "Highest"` because the framework injected it — prefer the measurement tier. Use `waterfall-shift.js` (see [request-chains.md](./request-chains.md)) evidence to override static findings.

Rule of thumb: **if the static finding and a tier-1 or tier-2 source disagree, drop the static finding or merge with `mergedSources` and use the stronger source's confidence cap.**

## Cross-references

- [finding-schema.md](./finding-schema.md) — Finding envelope, evidence kinds, confidence caps.
- [metrics/cls.md](../metrics/cls.md) — CLS root causes (image dims, viewport, injected above-fold content).
- [metrics/lcp.md](../metrics/lcp.md) — LCP root causes (discovery delay, render-blocking critical path).
- [martech.md](./martech.md) — DEFERRABLE tier host classification.
- [rules.md](./rules.md) — rule registry convention.
