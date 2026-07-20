---
issue_type: resource-hints
applicable_flavors: [eds, cs, ams]
risk_tier: low

required_validation:
  - target_on_lcp_critical_chain      # PRIMARY GATE — preconnect ONLY for domains in the LCP critical chain, not "anything on the page"
  - target_not_deferred               # see third-party.md deferral-safety table — defer-safe domains should NOT be preconnected
  - hint_not_already_present
  - crossorigin_for_font_origins

forbidden_techniques:
  - pattern: '<link\s+[^>]*rel\s*=\s*"preconnect"\s+[^>]*href\s*=\s*"https?://(?:fonts\.gstatic\.com|use\.fontawesome\.com|use\.typekit\.net|p\.typekit\.net)"(?![^>]*crossorigin)'
    reason: "Font origins require crossorigin on preconnect, or the browser opens a second connection and the hint is wasted"
  - pattern: '<link\s+[^>]*rel\s*=\s*"preconnect"\s+[^>]*href\s*=\s*"https?://(?:www\.google-analytics\.com|www\.googletagmanager\.com|stats\.g\.doubleclick\.net|connect\.facebook\.net|platform\.twitter\.com|www\.linkedin\.com/insightTag|sjs\.bizographics\.com|cdn\.amplitude\.com|static\.hotjar\.com|cdn\.mxpnl\.com|cdn\.heapanalytics\.com|s\.adobedtm\.com|assets\.adobedtm\.com|sstats\.adobe\.com|secure\.adnxs\.com|connect\.facebook\.net|platform\.linkedin\.com)"'
    reason: "Don't preconnect to analytics / tag-manager / social-pixel domains — these are deferred / async / lazy. Preconnect costs a connection slot for no benefit (and steals slots from domains in the LCP chain). See third-party.md deferral-safety table."

see_also:
  - playbook: third-party
    edge: complements
    reason: "the deferral-safety classification table is the source of truth for which domains belong on the LCP chain (preconnect candidates) vs. deferred (skip)"
  - playbook: font-preload
    edge: complements
    reason: "when preloading a font, pair with a crossorigin preconnect to the font origin"
  - playbook: request-chain
    edge: complements
    reason: "preconnect handles connection setup; request-chain covers the chain-shortening fixes when the LCP chain has serial dependencies"
---

# Resource hints (preconnect / dns-prefetch)

> **Risk tier:** low · **Applies to:** EDS, CS, AMS · **CWV metric:** LCP, FCP

## What this addresses

Connecting to a cross-origin host (DNS resolution + TCP handshake + TLS handshake) takes 100–300ms even on fast connections. `preconnect` lets the browser warm that connection in parallel with HTML parsing, so when the actual resource is requested the connection is already ready. `dns-prefetch` is the lighter DNS-only version.

The catch: connection slots are finite (browsers cap parallel connections per host and globally), and each preconnect occupies a slot until the actual request fires. **Preconnecting to a domain whose request happens *after* LCP wastes a slot during the most contention-prone window** — and steals it from domains that matter.

The right rule: **preconnect only to domains in the LCP critical chain.** That's a much narrower set than "domains used on the page."

## When to apply / when to skip

**Apply when** the target domain serves a resource on the **LCP critical render chain**:

- **The LCP image** when it's hosted cross-origin (image CDN, DAM domain, etc.)
- **Cross-origin render-blocking CSS or JS** discovered in the network waterfall before LCP
- **A separate components / blocks library origin** — common in EDS multi-domain setups where blocks ship from one host and content from another; the components host is on the critical render path
- **A/B test / personalization SDKs** that must run synchronously before paint (Optimizely, VWO, Adobe Target, AB Tasty per [`third-party.md`](./third-party.md)) — these block the original render anyway, so warming their connection is a net win
- **Font origins**, paired with [`font-preload.md`](./font-preload.md) when applicable, with `crossorigin` attribute included

**AND**: the hint is not already in `<head>`, and there are fewer than 4 active preconnects (parallelism cap).

**Skip when** the target is **deferred / async / lazy** — these connections happen *after* LCP is locked, so preconnecting them only wastes connection slots during the LCP window:

- **Analytics** — Adobe Analytics, GA4, Hotjar, Microsoft Clarity, Amplitude, Mixpanel, Heap (deferred per [`third-party.md`](./third-party.md))
- **Tag managers** — GTM, Adobe Launch / DTM, Tealium (loaded after consent)
- **Social media widgets / share buttons** — Facebook, Twitter, LinkedIn (typically lazy or facade-loaded)
- **Newsletter / marketing pixels** (delayed)
- **Live chat** — Intercom, Drift, LiveChat, Zendesk Chat (lazy below-the-fold per [`third-party.md`](./third-party.md))
- **Anything below the fold** — by definition not on the LCP chain

Other skip cases:

- Same-origin (no-op — browser already has the connection)
- Already 4+ active preconnects (each new one provides diminishing returns and increases CPU cost)

## Recommended approaches

### Preconnect to the LCP image's origin

```html
<!-- Good — when the LCP image is on a separate image CDN -->
<link rel="preconnect" href="https://images.example-cdn.com">
```

The single highest-leverage preconnect: directly shortens the LCP critical chain for the resource that *defines* LCP.

### Preconnect to a separate components / blocks library origin

```html
<!-- Good — EDS multi-domain: blocks ship from a sibling subdomain -->
<link rel="preconnect" href="https://blocks.example.com">
```

When the page's render-blocking JS / CSS for above-fold blocks lives on a different origin than the HTML, preconnecting unblocks parallel fetch.

### Preconnect to an A/B test or personalization SDK origin

```html
<!-- Good — A/B test SDK runs before paint per third-party.md; warm its connection -->
<link rel="preconnect" href="https://cdn.optimizely.com">
```

A/B test / personalization scripts are synchronously blocking initial render anyway (anti-flicker requires it). Warming the connection is a net win — they fire earlier, blocking less of the critical chain.

### Preconnect to a font origin (with `crossorigin`)

```html
<!-- Good — paired with critical web font usage; see font-preload.md when font-display: optional -->
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
```

Font origins **require** `crossorigin` (the CSS Fonts spec mandates fonts be fetched with CORS). Omit it and the browser opens a second non-CORS connection that's never reused.

### `dns-prefetch` as the lighter alternative

```html
<!-- Good — DNS-only warmup, lighter than preconnect -->
<link rel="dns-prefetch" href="https://api.example.com">
```

Resolves DNS but skips TCP/TLS handshake. Use as a fallback for browsers that don't support `preconnect`, or for origins where the connection-setup-time isn't worth a full slot but DNS resolution still helps. The same critical-chain criterion still applies — `dns-prefetch` to deferred analytics is still wasteful, just less so.

## Anti-patterns

### Preconnect to deferred / async / lazy origins

```html
<!-- Bad — analytics, tag managers, social pixels are all deferred -->
<link rel="preconnect" href="https://www.google-analytics.com">
<link rel="preconnect" href="https://www.googletagmanager.com">
<link rel="preconnect" href="https://connect.facebook.net">
<link rel="preconnect" href="https://static.hotjar.com">
```

**Why this is bad:** these scripts are **deferred** per [`third-party.md`](./third-party.md) — analytics, tag managers, social pixels, and live chat all load *after* LCP. Preconnecting them warms a connection slot during the LCP window for a request that won't fire until later. Net effect: steals a slot from a domain on the LCP chain *and* doesn't measurably help when the deferred request finally runs (browser will re-establish if needed). **Mirror the deferral-safety table from `third-party.md`: anything that's defer-safe should not be preconnected.**

### Preconnect to a font origin without `crossorigin`

```html
<!-- Bad -->
<link rel="preconnect" href="https://fonts.gstatic.com">
```

**Why this is bad:** when CSS later fetches the actual font with CORS, the browser opens a brand-new connection because the preconnect's connection isn't CORS-enabled. The hint is wasted. Always include `crossorigin` on font-origin preconnects.

### Preconnect to an unused domain

```html
<!-- Bad — domain doesn't appear in the page's network requests -->
<link rel="preconnect" href="https://api.unused.example.com">
```

**Why this is bad:** zero-value preconnect; pure connection-slot waste. Confirm the domain is *both* on the page *and* on the LCP critical chain before adding the hint.

### Too many preconnects

```html
<!-- Bad — 8 preconnects, only 1 or 2 actually on the LCP chain -->
<link rel="preconnect" href="https://a.example.com">
<link rel="preconnect" href="https://b.example.com">
<link rel="preconnect" href="https://c.example.com">
<link rel="preconnect" href="https://d.example.com">
<!-- ... 4 more -->
```

**Why this is bad:** browsers cap parallel TCP connections globally, and CPU / bandwidth costs of warming many connections exceed the latency savings. Cap preconnects at **~4 LCP-critical origins** (most pages have 1–3); for everything else either skip the hint or use `dns-prefetch`.

### Preconnecting "everything on the page"

```html
<!-- Bad — programmatically generated from network requests -->
{{#each thirdPartyDomains}}
  <link rel="preconnect" href="{{this}}">
{{/each}}
```

**Why this is bad:** the most common path to the previous anti-pattern. "Domain appears on the page" is **not** the gate — "domain is on the LCP critical chain" is. Most modern pages ship 30+ third-party requests; preconnecting all of them actively hurts performance through connection-slot competition.

## Related playbooks

- [`third-party.md`](./third-party.md) — the **deferral-safety classification table** is the source of truth for which domains belong on the LCP chain (preconnect candidates) and which are deferred (skip preconnect). Mirror that table when applying this playbook.
- [`font-preload.md`](./font-preload.md) — when preloading a font, pair with a font-origin preconnect (with `crossorigin`).
- [`request-chain.md`](./request-chain.md) — when the LCP critical chain has serial dependencies, preconnect handles connection setup but not chain length; `request-chain.md` covers the chain-shortening fixes.
