---
issue_type: third-party
risk_tier: medium

required_validation:
  - script_classified_by_deferral_safety
  - not_launch_dtm_managed
  - script_reference_in_markup

forbidden_techniques:
  - pattern: '<script\s+[^>]*\b(?:async|defer)\b[^>]*src\s*=\s*"[^"]*(?:optimizely\.com|vwo\.com|cdn\.adobetarget|targetmaketing|abtasty)[^"]*"'
    reason: "Don't async/defer A/B testing scripts without anti-flicker (Optimizely, VWO, Adobe Target, AB Tasty) — variants apply after initial render, causing visible content flash"
  # Note: consent managers and live chat widgets are NOT regex-banned here.
  # Whether they're safe to async/defer depends on the surrounding architecture
  # (consent: whether tracking is consent-gated; chat: whether the vendor SDK
  # supports late init). The prose anti-pattern below covers the real failure
  # mode for consent managers (tracking firing before consent is established)
  # without false-positiving on legitimate deferred-with-gating setups.

---

# Third-party scripts

> **Risk tier:** medium · **CWV metric:** LCP, INP, TBT

## What this addresses

Third-party scripts (analytics, tag managers, A/B test, chat, fonts) compete with first-party resources for bandwidth and main-thread time. The fix is to defer or async **safely** — not blanket-defer everything. Some third-parties are unconditionally defer-safe; others are conditionally defer-safe (depends on surrounding architecture); a small set must be synchronous regardless.

## Deferral-safety classification

| Unconditionally defer-safe | Conditionally defer-safe (architecture-dependent) | Do NOT defer |
|---|---|---|
| Web fonts loaded as scripts (Typekit, Fonts.com) | **Consent managers** (OneTrust, Cookiebot, Usercentrics, TrustArc) — defer-safe *if* tracking is consent-gated (waits for a `consent:granted` event). If tracking fires regardless of consent, consent must run synchronously first. | A/B test scripts without anti-flicker (Optimizely, VWO, Adobe Target, AB Tasty) — variants apply after paint, causing visible content flash |
| Non-essential tag managers (loaded after consent established) | **Analytics** (Adobe Analytics, GA4) — defer-safe *if* gated on consent (or running on a site with no consent requirement). Deferring with proper consent gating is the recommended pattern. | Anti-fraud / bot-detection scripts (synchronous gates required by vendor) |
| Late-loaded marketing pixels (newsletter, social) | **Live chat** (LiveChat, Intercom, Drift, Zendesk Chat, Tawk.to) — most modern widgets are defer-safe; check vendor docs for session-state caveats. | |

## When to apply / when to skip

**Apply when:**
- Script is in the defer-safe category above
- Script is loaded directly in markup (editable in this repo) — not injected via Adobe Launch / DTM
- The script's load attribute is currently missing (no `defer` or `async`)

**Skip when:**
- Script is in the "do NOT defer" category
- Script is injected via Adobe Launch / DTM — flag as "requires Launch rule change," do not emit a code fix
- Script's behavior is unfamiliar — recommend manual review rather than guess

## Recommended approaches

### Defer non-essential analytics

```html
<!-- Good -->
<script defer src="https://www.google-analytics.com/analytics.js"></script>
<script defer src="/scripts/analytics.js"></script>
```

### Async fully independent third-parties

```html
<!-- Good — GA4 has no in-page synchronous dependents -->
<script async src="https://www.googletagmanager.com/gtag/js?id=..."></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'GA_MEASUREMENT_ID');
</script>
```

The async script is fully independent; the inline initializer pushes to `dataLayer` which the async script processes when ready.

### Lazy-load below-the-fold third-parties

```html
<!-- Good — chat widget only after main content -->
<script>
  window.addEventListener('load', () => {
    setTimeout(() => {
      const s = document.createElement('script');
      s.src = 'https://livechat.example.com/widget.js';
      document.body.appendChild(s);
    }, 3000);
  });
</script>
```

For chat widgets and other below-fold third-parties that the vendor confirms can run late.

### Split a monolithic tag manager container

```yaml
# Conceptual — exact mechanism is platform-specific (Adobe Launch / GTM / Tealium)
container: critical-prelaunch    # consent + A/B test (synchronous, before LCP)
container: ux-essentials         # personalization, fonts (defer)
container: analytics             # GA, AA, Hotjar (delay or onload)
container: nice-to-have          # newsletter, surveys (idle / interaction)
```

A single tag container is the canonical "everything-or-nothing" anti-pattern: it loads all tags together, blocking the main thread on whichever tag is slowest, and can't be deferred because *some* tag inside it is consent-critical. Splitting into 3-4 containers by criticality lets each tier load with appropriate timing — consent first, analytics last.

### Gate third-parties to the pages that actually need them

```html
<!-- Good — conversion tracking only on cart/checkout pages -->
{{#if isCheckoutFunnel}}
  <script defer src="/scripts/conversion-tracking.js"></script>
{{/if}}
```

Conversion-funnel scripts on profile pages, social-share widgets on legal pages, marketing pixels on 404 pages — all of these ship cost site-wide for value on a small subset of pages. Audit each third-party's actual usage and gate it to the relevant templates.

### Self-host or proxy third-parties through your domain

When a third-party's bytes are stable (analytics SDK, A/B test SDK), self-hosting eliminates a DNS lookup + TLS handshake + cross-origin connection slot. The trade-off: you're responsible for staying current with the vendor's SDK versions. Suitable for SDKs that change weekly-or-less; not suitable for tag-manager payloads that change per-deploy.

## Anti-patterns

### Deferring A/B test scripts

```html
<!-- Bad -->
<script defer src="https://cdn.optimizely.com/js/123.js"></script>
```

**Why this is bad:** A/B test scripts must run **before** the original content is painted. Deferring means the original content flashes, then the test variant overwrites it — the flicker is visible to users and inflates CLS. Optimizely, VWO, Adobe Target, and AB Tasty must all be synchronous.

### Tracking firing before consent is established

```html
<!-- Bad — analytics fires regardless of consent state -->
<script async src="https://cdn.cookielaw.org/scripttemplates/otSDKStub.js"></script>
<script src="https://www.google-analytics.com/analytics.js"></script>
<!-- analytics.js runs immediately; consent banner is still loading;
     pageview fires before user has accepted/rejected → GDPR violation -->
```

```html
<!-- Good — analytics queued behind a consent-ready event -->
<script async src="https://cdn.cookielaw.org/scripttemplates/otSDKStub.js"></script>
<script>
  // queue-and-flush: trackers wait for the consent manager to fire its event
  window.consentReady = new Promise((resolve) => {
    window.addEventListener('consent:granted', resolve, { once: true });
  });
  consentReady.then(() => {
    const s = document.createElement('script');
    s.src = 'https://www.google-analytics.com/analytics.js';
    document.body.appendChild(s);
  });
</script>
```

**Why this is bad:** the failure mode is **not** that the consent manager is async — it's that tracking fires without waiting for consent. With proper gating (analytics queued behind a `consent:granted` / `OnetrustActiveGroups` / similar event), deferring or async-ing the consent banner is fine and compliant. Without gating, both consent and tracking must be synchronous and ordered (consent first). The mistake is shipping deferred consent + un-gated tracking.

### Touching Launch/DTM-managed scripts in markup

If the script is injected at runtime by Adobe Launch (`launch-XXXXX.min.js`) or DTM, editing the markup of the resulting `<script>` tag does nothing because Launch overwrites it on every page load. **Flag as "requires Launch rule change" — do not edit the rendered markup.**

### Reaching for Partytown as a silver bullet

```html
<!-- Bad — proposing Partytown as the universal third-party fix -->
<script src="https://unpkg.com/@builder.io/partytown/lib/partytown.js"></script>
<script type="text/partytown" src="https://www.googletagmanager.com/gtag/js?id=..."></script>
```

**Why this is bad:** [Partytown](https://partytown.builder.io/) sandboxes third-party JS in a Web Worker, which sounds ideal for moving martech off the main thread. In practice it has serious limitations — many third-parties access browser APIs that Partytown's worker can't proxy efficiently (DOM events, cookies, `document.cookie` writes for consent), and the proxy round-trips themselves accumulate into TBT. It's worth evaluating per-script, but **don't propose it as a default fix** for third-party perf issues; the splitting + gating + delaying approaches above are more reliable.
