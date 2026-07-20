# Heuristic Rules

Actionable checks to run against collected measurement data. Each rule is a pattern → fix mapping distilled from field-tested optimizations.

## How to use

Run measurement with `launcher.js`, then evaluate rules against: CWV metrics + attribution (from web-vitals), resource timing (from PerformanceObserver / `report.data`), HAR entries (if collected), and JS/CSS coverage (if collected). A rule "fires" when its condition is met; the finding has a concrete fix action.

For each firing rule, produce the CoT block (Observation / Diagnosis / Mechanism / Solution) from `evidence-and-confidence.md` — the rule tells you WHAT fired; the CoT tells you WHY it matters here.

## Categories

- **Critical Path (LCP, FCP)** — resources loading before the LCP event
- **Main Thread (INP, TBT)** — long tasks, blocking scripts
- **Layout (CLS)** — missing dimensions, late content injection
- **Fonts** — font-display strategy, format, fallback sizing
- **Network (TTFB, redirects)** — server, protocol, CDN
- **Config** — CSP, HTTP version, response headers

## Patch format

Where a fix is patchable via the launcher's overlay system, we include a ready-to-apply `patches.json` snippet using these keys:

- `block` — array of URL substrings to block at the network layer
- `preloads` — array of `<link rel="preload">` descriptors to inject in `<head>`
- `markup` — DOM edits (selector + attribute changes) applied before navigation commits. Canonical shape: `{ selector: "...", attrs: { key: value, ... } }`. A value of `null` removes the attribute. Both `.agents/scripts/patches/mutate-markup.js` (runtime applier) and `.agents/scripts/source-mapper.js` (source-edit translator) consume this shape — the finding-schema validator rejects any other shape.
- `responseHeaders` — response header rewrites for the main document

For source-only fixes (refactor a bundle, change build output), the rule notes "Source change required — see stacks/*.md for framework-appropriate edits".

---

## Rules

### 1. kb100 — excessive pre-LCP transfer [category: Critical Path | metric: LCP]

**Fires when:** total transfer size of all resources ending before the LCP event exceeds 100 KB (mobile) or 200 KB (desktop).
**Evidence to collect:** `report.dataSortedByEnd` sliced up to the last LCP entry; sum of `size` across entries.
**Fix:** Defer everything not strictly required to paint the LCP element. Move analytics, chat widgets, personalization SDKs, optional CSS modules, and late-binding JS past the LCP. Use `defer` / `type="module"` on scripts and media-query splitting on CSS.
**Patch snippet:**
```json
{ "block": ["/analytics/", "/chat-widget/", "optanon"],
  "markup": [{ "selector": "script[src*='/vendor/']", "attrs": { "defer": "" } }] }
```
**Impact:** 300–1500 ms LCP improvement depending on headroom above threshold.
**Confidence:** 0.9 (direct byte measurement against a calibrated budget).

### 2. lcp — LCP timing regression [category: Critical Path | metric: LCP]

**Fires when:** LCP end time > 2500 ms (average) or > 4000 ms (bad). Also fires when multiple LCP entries observed (async content overshadowing earlier paint).
**Evidence to collect:** all `entryType === 'LCP'` entries in `report.data`; compare count and last `end` value.
**Fix:** If multiple LCPs, the critical path is optimized for the wrong element — identify which element *should* be the LCP and prioritize it (`fetchpriority="high"`, preload, remove covering content). If single LCP is slow, preload the LCP resource and strip pre-LCP blockers (rules 1, 3–10).
**Patch snippet:**
```json
{ "preloads": [{ "href": "/hero.jpg", "as": "image", "fetchpriority": "high" }] }
```
**Impact:** variable — depends on the underlying cause surfaced by other rules.
**Confidence:** 0.9 (direct metric measurement).

### 3. loadingSequenceFonts — font in critical path [category: Critical Path | metric: LCP]

**Fires when:** any resource with `mimeType.includes('font')` appears in the sequence before the LCP.
**Evidence to collect:** iterate `sequence` from `getSequence(report)`; filter `entryType === 'resource'` with font mime.
**Fix:** Fonts should load AFTER the LCP. Combine with `font-display: swap` (rule 15) so text renders in fallback. Remove `rel="preload"` for fonts unless the font IS the LCP element.
**Patch snippet:**
```json
{ "block": ["fonts.gstatic.com", ".woff2"],
  "markup": [{ "selector": "link[rel='preload'][as='font']", "attrs": { "rel": null, "as": null } }] }
```
**Impact:** 100–600 ms LCP when the font is same-origin and contending for bandwidth.
**Confidence:** 0.8 (clear signal; user-visible tradeoff is FOUT — usually acceptable).

### 4. loadingSequenceSize — oversized resource before LCP [category: Critical Path | metric: LCP]

**Fires when:** pre-LCP JS resource > 20 KB or pre-LCP CSS > 10 KB.
**Evidence to collect:** each `entryType === 'resource'` in the pre-LCP sequence; check `mimeType` and `size`.
**Fix:** Split the bundle — only ship CSS for above-the-fold structure and JS for LCP-critical behavior in the critical path. Everything else is imported dynamically (`import()`) or loaded with `defer` after LCP.
**Patch snippet:** Source change required — see `stacks/*.md` for framework-appropriate code splitting.
**Impact:** 150–800 ms LCP per deferred bundle, larger on slow networks.
**Confidence:** 0.85 (coverage data would raise to 0.9).

### 5. loadingSequence3rdparty — cross-origin resource blocking LCP [category: Critical Path | metric: LCP]

**Fires when:** pre-LCP resource's hostname differs from the document hostname AND its `duration` > 60 ms.
**Evidence to collect:** compare resource URL hostname to `summary.url` hostname; check `duration`.
**Fix:** (a) self-host the resource if feasible, (b) defer it past LCP, (c) `<link rel="preconnect">` the third-party origin if the resource is unavoidable pre-LCP.
**Patch snippet:**
```json
{ "block": ["third-party-domain.com"],
  "preloads": [{ "href": "https://third-party-domain.com", "rel": "preconnect" }] }
```
**Impact:** 100–500 ms — cross-origin requires fresh DNS/TCP/TLS, typically 100–300 ms of handshake overhead alone.
**Confidence:** 0.85.

### 6. loadingSequenceMedia — non-LCP media in critical path [category: Critical Path | metric: LCP]

**Fires when:** an image or video resource (not the LCP, not favicon.ico) loads before the LCP.
**Evidence to collect:** pre-LCP sequence; filter `mimeType.includes('image'|'video')` excluding the LCP URL.
**Fix:** Add `loading="lazy"` to below-the-fold media. For media that IS above the fold but NOT the LCP (e.g. a logo, a decorative image), keep eager but ensure it does not steal priority from the LCP — no `fetchpriority="high"` on non-LCP images.
**Patch snippet:**
```json
{ "markup": [{ "selector": "img:not([data-lcp])", "attrs": { "loading": "lazy" } }] }
```
**Impact:** 50–300 ms LCP by freeing connection slots.
**Confidence:** 0.8.

### 7. imagesLoading — every image is lazy (including the LCP) [category: Critical Path | metric: LCP]

**Fires when:** every image in HAR is loaded with `_priority === 'Low'` (i.e. blanket `loading="lazy"` applied even to the LCP image).
**Evidence to collect:** HAR entries with `mimeType.startsWith('image/')`; confirm LCP image's priority is Low.
**Fix:** The LCP image must be eager with `fetchpriority="high"`. Remove `loading="lazy"` from the hero element; keep lazy for below-the-fold images.
**Patch snippet:**
```json
{ "markup": [
  { "selector": "img.hero", "attrs": { "loading": "eager", "fetchpriority": "high", "data-lazy": null } }
]}
```
**Impact:** 300–1200 ms LCP — lazy-loading the LCP is a common anti-pattern that delays discovery until layout.
**Confidence:** 0.9.

### 8. noInlineSvg — inline `<svg>` in body [category: Critical Path | metric: FCP, LCP, TBT]

**Fires when:** early `<body>` markup contains a meaningful inline SVG payload: the largest SVG is at least 2KB or aggregate early inline SVG payload is at least 6KB.
**Evidence to collect:** parse raw HTML; query early `body svg`; record count, aggregate bytes, largest bytes, and the largest SVG snippet.
**Fix:** Replace large decorative/reusable inline SVGs with cacheable `<img src="...svg" loading="lazy">` assets. Inline SVGs bloat the HTML response, cannot be cached across pages, and add parser/main-thread work before first paint. Keep tiny semantic icons inline when the accessibility/styling tradeoff justifies it.
**Patch snippet:** Source change required — convert SVGs to external files, reference via `<img>`.
**Impact:** 150 ms FCP heuristic + HTML shrinkage (less response transfer and parse work before first paint).
**Confidence:** 0.55 as a static HTML hypothesis; raise only when launcher/coverage evidence confirms parse or transfer impact.

### 9. lazyHeaderFooter — header.js / footer.js in critical path [category: Critical Path | metric: LCP]

**Fires when:** resource URL contains `header.js` or `footer.js` and loads before the LCP. Also fires if footer loads before header.
**Evidence to collect:** scan pre-LCP sequence URLs for these patterns.
**Fix:** Header should be minimal static HTML (logo + nav shell) with JS hydration deferred. Footer has no business in the critical path — defer unconditionally. If both present, header must load first (visual hierarchy).
**Patch snippet:**
```json
{ "markup": [
  { "selector": "script[src*='footer.js']", "attrs": { "defer": "" } },
  { "selector": "script[src*='header.js']", "attrs": { "defer": "" } }
]}
```
**Impact:** 100–800 ms LCP. This pattern is especially common in AEM Edge Delivery sites — see stacks/eds.md.
**Confidence:** 0.85 (pattern match + timing).

### 10. redirects — pre-LCP redirect chain [category: Critical Path | metric: LCP, TTFB]

**Fires when:** any pre-LCP resource has `redirect > 0` ms.
**Evidence to collect:** pre-LCP sequence; check `redirect` field on each resource.
**Fix:** Update references to use the final URL. Common causes: http→https, trailing slash, www canonicalization, country redirects. Fix at the reference site, not at the server.
**Patch snippet:** Source change required — grep references, update to canonical URL. For the main document itself, fix via DNS / CDN config.
**Impact:** 200–800 ms per redirect hop (each adds DNS + TCP + TLS + 1 RTT).
**Confidence:** 0.9.

### 11. cls — layout shift above detection threshold [category: Layout | metric: CLS]

**Fires when:** any CLS entry with `value > 0.01` is recorded.
**Evidence to collect:** filter `entryType === 'CLS'`; walk backwards through `dataSortedByEnd` to find the preceding CSS/JS that likely caused it (mimeType match); record `sources[].node`, `from`, `to` rects.
**Fix:** Set explicit `width` / `height` (or `aspect-ratio`) on media BEFORE the impacting resource loads. If the shift is caused by late CSS, inline critical CSS or preload the CSS. If JS injects content, reserve space with `min-height`.
**Patch snippet:**
```json
{ "markup": [
  { "selector": "img.hero", "attrs": { "width": "1200", "height": "600" } },
  { "selector": ".banner-slot", "attrs": { "style": "min-height:400px" } }
]}
```
**Impact:** CLS drops to 0 for the fixed element; aggregate score improvement proportional to `value` across shifts.
**Confidence:** 0.85 (shift value is direct; root-cause attribution via preceding resource is heuristic — 0.7 for that part).

### 12. loadingSequenceBlocking — render-blocking resource [category: Main Thread | metric: LCP, FCP]

**Fires when:** pre-LCP resource has `renderBlockingStatus === 'blocking'` and is not the page's main `/styles.css`.
**Evidence to collect:** browser-reported `renderBlockingStatus` on each resource.
**Fix:** Add `defer` / `async` to scripts; use `media` attribute splitting on `<link rel="stylesheet">`; inline truly-critical CSS and load the rest asynchronously with `rel="preload" as="style" onload="this.rel='stylesheet'"`.
**Patch snippet:**
```json
{ "markup": [
  { "selector": "script[src*='vendor']", "attrs": { "defer": "" } },
  { "selector": "link[rel='stylesheet']:not([data-critical])", "attrs": { "media": "print", "onload": "this.media='all'" } }
]}
```
**Impact:** 200–1000 ms LCP/FCP.
**Confidence:** 0.85.

### 13. loaf — long animation frame > 90 ms [category: Main Thread | metric: INP, TBT]

**Fires when:** any `entryType === 'long-animation-frame'` with `duration > 90 ms`.
**Evidence to collect:** LoAF entries with `url`, `name`, `start`, `end`; cross-reference with resources loaded during the frame window.
**Fix:** If the LoAF names a script URL, break up the long task (yield with `scheduler.yield()`, `requestIdleCallback`, `postTask`, or split via `setTimeout`). If blockers span the window, defer the heaviest. CSS-only LoAFs can be ignored — style recalc timing is hard to reduce without refactor.
**Patch snippet:** Source change required — see stacks/*.md.
**Impact:** 50–400 ms INP/TBT.
**Confidence:** 0.8.

### 14. tbt — task blocking main thread > attributed to prior resource [category: Main Thread | metric: TBT, INP]

**Fires when:** any `entryType === 'TBT'` entry. The rule walks back to find the non-TBT, non-LoAF preceding entry as the likely cause.
**Evidence to collect:** TBT entry `duration`, `start`; the preceding resource's URL.
**Fix:** Defer or split the preceding script. If it's a third-party, consider `<script async>` on a Worker-hosted shim, or delay it until after LCP.
**Patch snippet:**
```json
{ "block": ["heavy-script.js"],
  "markup": [{ "selector": "script[src*='heavy-script']", "attrs": { "defer": "" } }] }
```
**Impact:** 50–500 ms TBT; INP improves if the blocker was contending with interactions.
**Confidence:** 0.75 (TBT is direct, attribution is heuristic).

### 15. fonts — font-display / format / fallback [category: Fonts | metric: CLS, LCP]

**Fires when (multiple sub-checks):**
- Google Fonts URL missing `&display=swap` (or using `display=block|fallback|auto`).
- Any font file not served as `woff2`.
- A loaded, used font has `font-display: auto` (not `swap` or `optional`).
- A used custom font has no fallback font configured.
- A fallback font has `size-adjust: 100%` or unset — mismatched metrics cause shift when custom font swaps in.

**Evidence to collect:** HAR font entries; `document.fonts` API dump (`fontData.fonts`, `fontData.usedFonts`).
**Fix:**
- Append `&display=swap` to Google Fonts URLs.
- Convert `.ttf`/`.woff` to `.woff2` (25–30 % smaller).
- Set `font-display: swap` or `optional` in `@font-face`.
- Configure fallback stack AND `size-adjust` on the `@font-face` so fallback metrics approximate the custom font.

**Patch snippet:**
```json
{ "markup": [
  { "selector": "link[href*='fonts.googleapis.com/css']", "attrs": { "href-append": "&display=swap" } }
]}
```
**Impact:** CLS 0.02–0.15 reduction; 200–600 ms elimination of FOIT.
**Confidence:** 0.85 (font-display) / 0.8 (format) / 0.75 (size-adjust — requires calibration).

### 16. httpVersion — legacy HTTP for first-party [category: Network | metric: TTFB, LCP]

**Fires when:** any first-party HAR entry uses `httpVersion` other than `h2` or `h3`.
**Evidence to collect:** HAR entries filtered by hostname match; `request.httpVersion` inspection.
**Fix:** Configure CDN / origin for HTTP/2 (minimum) or HTTP/3 (preferred, enables 0-RTT resumption and connection migration). HTTP/1.1 forces head-of-line blocking and separate TCP connections per resource.
**Patch snippet:** Infra change required — enable HTTP/2+H3 at CDN (Cloudflare, Fastly, Akamai all support).
**Impact:** 100–600 ms aggregate on resource-heavy pages via multiplexing.
**Confidence:** 0.9.

### 17. ttfb — time to first byte over 800 ms [category: Network | metric: TTFB, LCP]

**Fires when:** `entryType === 'navigation'` has `ttfb > 800` ms (CWV "good" boundary).
**Evidence to collect:** the navigation entry's `ttfb` field.
**Fix:** Investigate in order: (a) CDN cache hit ratio — if MISS dominant, fix cache-control headers; (b) origin compute — pre-render, static generation, or edge-side rendering; (c) redirect chains (rule 10); (d) DNS / connection timing in HAR.
**Patch snippet:**
```json
{ "responseHeaders": [{ "name": "cache-control", "value": "public, max-age=3600, s-maxage=86400" }] }
```
**Impact:** TTFB directly improves LCP 1:1 for the portion above 800 ms.
**Confidence:** 0.9.

### 18. csp — content security policy violations [category: Config | metric: various]

**Fires when:** any `securitypolicyviolation` event was captured by the jsApi hook during measurement.
**Evidence to collect:** `jsApi.cspViolations[].blockedURI`, `violatedDirective`, `sourceFile`, `lineNumber`.
**Fix:** Either (a) extend the CSP directive to allow the resource (e.g. add the CDN host to `script-src`), or (b) remove the blocked resource if it's unwanted third-party bloat. Do NOT blindly widen to `unsafe-inline` / `*` — that's a security regression.
**Patch snippet:**
```json
{ "responseHeaders": [{ "name": "content-security-policy", "value": "default-src 'self'; script-src 'self' https://trusted-cdn.example.com; ..." }] }
```
**Impact:** varies — often a blocked resource IS needed (breaking functionality) or IS bloat (free performance win when removed).
**Confidence:** 0.9 (direct browser report).

---

## Rule count

18 actionable rules, matching the 18 entries in `src/rules/index.js`. The two files `index.js` (rule registry) and `shared.js` (helper functions `getSequence` / `getInitiator`) are utility code, not rules, and are excluded from the count above.

## Application workflow

1. Run `launcher.js` to collect HAR + PerformanceObserver + coverage + CWV metrics.
2. Evaluate each rule against the collected data. A rule returns zero or more findings.
3. For each finding, produce a CoT block (see `evidence-and-confidence.md`).
4. Apply confidence calibration (source tier, penalties).
5. Gate with `MIN_ACTIONABLE_IMPACT` and the severity thresholds.
6. Emit surviving findings ordered: bottleneck → waste → opportunity.
7. For each patch snippet, apply via launcher's overlay and re-measure — the delta is the real impact.
