# MarTech

## Definition

Marketing Technologies (MarTech) is a term that refers to the tools, platforms, and technologies that businesses use to optimize their marketing efforts. The goal of MarTech is to make marketing processes more efficient and flexible, allowing marketers to focus on more creative and strategic work.

## Components

MarTech solutions typically include:
- Analytics tracking (like Adobe Analytics, Google Analytics, etc.) and user behavior tracking tools (like Hotjar, Microsoft Clarity, etc.)
- Content personalization and A/B testing libraries (like Adobe Target, Optimizely, etc.)
- Tag managers (like Google Tag Manager, Adobe Launch, Tealium, etc.)
- Programmatic ad platforms (like Google Ads, Facebook Ads, etc.)
- Social media tools (like Facebook, Twitter, etc. widgets)
- Email newsletters solutions (like Mailchimp, Constant Contact, etc.)
- Customer relationship management (CRM) integrations (like Salesforce, HubSpot, etc.)

## Most common issues

- Bad [TTFB](../metrics/ttfb.md), [TBT](../metrics/tbt.md), [FCP](../metrics/fcp.md), [CLS](../metrics/cls.md) or [INP](../metrics/inp.md)
- 3rd-party host that needs to be resolved (DNS + TLS handhsake)
- Use of Tag managers that loads everything at once in monolithic Tag containers

## Most common optimizations

- Don't expect too much from [Partytown](https://partytown.builder.io/), it has several limitations and still causes TBT in the end
- Delay all the MarTech integrations to the end of the page load, if content personalization and A/B tests are not required
- Remove redundant and unsed Tags from the Tag container
  - Does your marketing team really need Mirosoft Clarity, Meta Pixel, Google Analytics, Hotjar AND Google Analytics?
- Split the monolithic Tag container into smaller independent containers if possible
  - Load critical tags for the user experience first, and delay marketing tags only used to track behavior
- Split large Tags into smaller chunks to reduce the performance impact:
  - load presonalization and A/B test logic before the FCP
  - load data layer and analytics solutions at the end of the page load
  - defer any non-UI related MarTech integrations
- Self-host or proxy the MarTech libraries through your domain to reduce [TTFB](../metrics/ttfb.md) and [FCP](../metrics/fcp.md)
- Adjust Tag configurations to reduce impact on [INP](../metrics/inp.md)
- Leverage the performance helper methods from [aem-cwv-helper](https://github.com/ramboz/aem-cwv-helper) to break patch datalayer and event listeners from 3rd-party scripts to reduce long tasks
- Only enable 3rd-party libraries on pages that really need it
  - You only need conversion tracking on pages that are actually part of the conversion funnel. Your user profile config page is likely not one of those

## How to measure & debug

- Use https://3rdparty.io/ to vet your 3rd-party libraries
- See runbooks for [TTFB](../metrics/ttfb.md), [TBT](../metrics/tbt.md), [FCP](../metrics/fcp.md), [CLS](../metrics/cls.md) and [INP](../metrics/inp.md).

## References

- https://github.com/adobe-rnd/aem-martech
- https://themuralimanohar.medium.com/mastering-core-web-vitals-ffa73e7192a4

---

## Chain Classification

MarTech scripts fall into two broad classes, with a narrow set of exceptions. Classifying them correctly is the single most important decision when recommending loading strategy — getting it wrong either breaks experiences (FOOC/CLS) or wastes bandwidth on the critical path.

### DEFERRABLE chains (the default for MarTech)

These MUST NOT be preloaded and MUST NOT get `preconnect` hints. They load after the page renders, typically `async`/`defer` or in a "delayed" phase 3s after `load`.

| Category | Example domains / SDKs |
|----------|------------------------|
| Analytics | Google Analytics 4 (GA4), `google-analytics.com`, Segment, Adobe Analytics (beacon), Mixpanel, Amplitude |
| Consent / privacy | OneTrust, `cookielaw.org`, TrustArc, Cookiebot |
| Session replay / monitoring | Hotjar, FullStory, Microsoft Clarity, Sentry, Datadog RUM, New Relic Browser |
| Chat widgets | Intercom, Drift, Zendesk Chat |
| Social embeds / pixels | Facebook Pixel, LinkedIn Insight, Twitter/X widgets |

**Rule:** `async` or `defer` attributes, or load post-LCP via a delayed phase. Never put these in the critical path.

### CRITICAL exceptions (rare but real)

A/B testing and personalization SDKs are normally thought of as MarTech, but when they **mutate above-fold DOM on the client**, they become CRITICAL — not deferrable.

| SDK | Domains |
|-----|---------|
| Optimizely | `cdn.optimizely.com`, `cdn-pci.optimizely.com` |
| VWO | `dev.visualwebsiteoptimizer.com` |
| Adobe Target | `*.tt.omtrdc.net`, `at.js`, `mbox.js` |
| Google Optimize | `optimize.google.com` (deprecated but still in the wild) |
| LaunchDarkly | `app.launchdarkly.com` (when gating above-fold UI) |

**Key rule:** NEVER async/defer A/B testing scripts that perform client-side DOM mutation above-fold — this causes content flicker (FOOC: Flash Of Original Content) and CLS as the control variant paints first, then gets swapped.

If the experiment scope is entirely below-fold, the script CAN be deferred — but verify experiment scope explicitly before recommending async.

If the performance impact of keeping these synchronous is severe, the correct answer is **migrating to server-side or edge-side experimentation** (CDN A/B testing, edge workers), not deferring the client script.

### MIXED chains

Tag managers (Google Tag Manager, Adobe Launch / DTM, Tealium) are containers that fire a bag of individual tags. The container itself is CRITICAL only when it fires above-fold personalization (e.g. GTM invoking Optimizely, or Launch invoking Target). Otherwise it's DEFERRABLE. Audit each tag independently.

## Anti-Patterns

- NEVER recommend `preconnect` to analytics, consent, or monitoring domains (GA4, OneTrust, Hotjar, Clarity, Sentry, Datadog, etc.). They should not be on the critical path at all — preconnecting to them *prioritizes* a deferrable chain and steals bandwidth/connection slots from real LCP resources.
- NEVER recommend `preload` for deferrable chain scripts. Preload is a "this is critical, fetch now at high priority" hint — applying it to an analytics beacon directly contradicts the intent and harms LCP.
- NEVER recommend async/defer for A/B testing scripts that mutate above-fold DOM — this causes FOOC and CLS. Keep them synchronous or move experimentation server-side.
- NEVER recommend `media="print" onload="this.media='all'"` or `preload as="style" onload="this.rel='stylesheet'"` hacks for CSS loading — they violate spec, cause accessibility issues, and are not robust. Use JS-based `requestIdleCallback` loading or a proper critical/non-critical split instead.
