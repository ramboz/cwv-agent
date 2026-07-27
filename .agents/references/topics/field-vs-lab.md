# Field vs Lab

Reconciling field data (what real users actually experience) with lab data (what synthetic measurement reports) is the central skill of CWV diagnosis. Field tells you *whether* a metric is failing; lab tells you *why*. Using them in the wrong order — starting with a lab run on a page whose field data is green — wastes time on optimizations that move no real-world metric.

## Signal hierarchy

Trust order, highest to lowest:

1. **CrUX** — Chrome User Experience Report, 28-day rolling p75 from real Chrome users who opted into usage statistics. Origin-level and URL-level (URL-level requires ~1000 visits in the window, else falls back to origin). This is ground truth for "is the page failing in production."
2. **RUM** — Real User Monitoring, typically 7-day, page-specific, with the granularity you designed in (device, geography, referrer, custom dimensions). Catches regressions CrUX's 28-day smoothing masks.
3. **PSI / Lighthouse** — Google PageSpeed Insights. Reproducible synthetic run with `Mobile Slow 4G` calibration. Has the "Opportunities" audits that attribute root cause.
4. **Local Lighthouse** — your local Chrome DevTools Lighthouse run. Useful for rapid iteration but lowest trust — local CPU/network varies, extensions pollute results.

Rule: start diagnosis at level 1, move down only as you need attribution detail. Never start at level 3 or 4.

## Field vs lab gap interpretation

Compare PSI/lab result to CrUX field p75 for the same metric and form factor. The gap tells you what kind of issue you're looking at.

| Gap | Meaning | What to do |
|-----|---------|-----------|
| Lab ≈ field (within 30%) | Synthetic accurately represents real users. | Trust the lab run. Attribute and fix. |
| Lab 1.5–2× better than field | Real-user devices/networks worse than the lab profile, OR long tail of slow sessions. | Run stricter profile (e.g. `mobile-slow4g-4xcpu`). Check device breakdown in RUM. |
| Lab >2× better than field | Something the lab doesn't model: personalization, A/B tests, logged-in state, authenticated content, geo-specific CDN pop. | Re-run lab with cookies / query params that reproduce the slow path. Check CrUX by country. |
| Lab worse than field | Lab profile is too aggressive, or a specific lab environment issue (bad run, extension). | Re-run; loosen throttling; trust field. |

Never recommend fixes for a metric whose lab is >2× better than field without first reproducing the field condition in the lab — you'll optimize the wrong path.

> **CLS special case — lab reads 0.** A *warm edge cache* can make lab CLS read **0.000** (a
> false negative: images arrive before first paint) even when field CLS fails — this isn't "lab
> better than field," it's "the lab didn't reproduce the load timing." Re-run with the
> `desktop-slow-1xcpu` profile + cold cache (see ["Using launcher.js profiles"](#using-launcherjs-profiles)
> below) before trusting a 0. Verified on about.ups.com (CLS 0.000 lab vs 2.0 field).

## Threshold pressure formula

To rank URLs by urgency when triaging a domain, compute:

```
pressure = max(lcp_ms / 2500, cls / 0.1, inp_ms / 200)
```

This normalizes each metric to its "good" threshold. A URL with `LCP=4000, CLS=0.05, INP=150` has pressure `max(1.6, 0.5, 0.75) = 1.6` — LCP is dominating; that's what to fix first.

Properties:

- Pressure = 1.0 means the page is exactly at the "good" boundary for its worst metric.
- Pressure ≥ 1.3 means the page is in "needs improvement" territory on at least one metric.
- Pressure ≥ 2.0 means the page is in "poor" territory on at least one metric.
- The metric contributing the max is the one to attack first — don't spread fix effort until the worst metric is under control.

Use this in the `cwv-triage` skill to rank a sitemap's URLs.

## CrUX vs RUM temporal comparison

CrUX is a 28-day rolling window; RUM is typically 7-day. The gap between them tells you about regressions and recoveries:

- **RUM 7-day ≥33% worse than CrUX 28-day** → likely recent regression (last 1–2 weeks). Check recent deploys, CDN config changes, third-party additions.
- **RUM 7-day meaningfully better than CrUX 28-day** → recent improvement is still averaging in. CrUX will catch up in 2–3 weeks; don't be falsely alarmed by the CrUX number.
- **CrUX returns no data for a URL** → URL needs ≥1000 real-user visits in 28 days to get URL-level data. Fall back to origin-level CrUX, or use PSI with field data unavailable.

## Device breakdown heuristic

Always compare PHONE vs DESKTOP explicitly before committing to a fix direction.
`cwv-triage` queries both automatically (see `byFormFactor` in the RUM output
and the two CrUX queries) so this comparison lands in the triage report
without a second pass.

- **Mobile failing, desktop good** → prioritize mobile-specific issues: image sizing (desktop hero shipped to mobile viewport), JavaScript execution cost (CPU-bound code is ~4× slower on mobile), layout thrashing with viewport-dependent media queries. Run the downstream chain with `--profile mobile-slow4g-4xcpu`.
- **Both failing** → likely a structural issue affecting everyone (render-blocking resource in `<head>`, slow TTFB, bloated critical CSS). Desktop is the "easier" case; if desktop is also failing, the problem is upstream. Fix mobile first (higher pressure usually), but verify the same patch helps desktop via a second `cwv-validate` run with `--profile desktop-cable-1xcpu` before shipping.
- **Desktop failing, mobile good** → unusual. Often points to a desktop-only third-party (large video autoplay, desktop-only embeds, hover-triggered widgets). Run the chain with `--profile desktop-cable-1xcpu` so the lab reproduces the failure.

Never use PHONE and DESKTOP metrics interchangeably. They live on different form factor queries in CrUX; a "PHONE" result and a "DESKTOP" result are independent p75s. A fix validated on one form factor does NOT automatically transfer to the other — throttle shape, CPU budget, and available viewport all change the attribution story.

## Using launcher.js profiles

The launcher's throttling profiles are calibrated to correlate with CrUX form factors:

| Profile | CPU | Network | CrUX correlation |
|---------|-----|---------|------------------|
| `mobile-slow4g-4xcpu` | 4× slowdown | 1.6 Mbps down / 750 Kbps up / 150ms RTT | CrUX **mobile** p75 (matches Lighthouse/PSI default) |
| `desktop-cable-1xcpu` | 1× | 5 Mbps down / 1 Mbps up / 40ms RTT | CrUX **desktop** p75 |
| `desktop-slow-1xcpu` | 1× | 600 Kbps down / 300 Kbps up / 500ms RTT | **Not** a CrUX preset — opt-in cold-load desktop CLS repro |
| `no-throttle` | 1× | Unthrottled | Local-only sanity check; do NOT compare to CrUX |

Use `mobile-slow4g-4xcpu` as the default for CWV work. If you're trying to reproduce a specific CrUX mobile p75, this is the profile to use — PSI uses essentially the same calibration.

`desktop-slow-1xcpu` is a deliberately punishing desktop link (slower than Slow-4G) for one job: reproducing **cold-load desktop CLS** that a warm edge cache hides. When a DESKTOP page reads CLS ≈ 0 on `desktop-cable-1xcpu` (fast TTFB delivers images before first paint) yet field RUM p75 fails, re-run with `desktop-slow-1xcpu` + cold cache to open the paint→late-content gap. It is an explicit opt-in — `DESKTOP` still maps to `desktop-cable-1xcpu` (see the mapping below). Note its numbers do **not** correlate to a CrUX form factor, so read the resulting CLS as "is the shift real and how big," not as a field-p75 estimate. Reproducing *width-dependent* desktop shifts additionally requires a representative desktop viewport (slice 003-06); until that lands the launcher renders desktop profiles at Puppeteer's 800×600 default.

## Form factor ↔ profile pairing

The skill chain (triage → analyze → diagnose → fix → validate) passes a single
`formFactor` / `profile` pair forward from the first step to the last. The
mapping is in `.agents/scripts/profiles.js` via `mapFormFactorToProfile()`:

| CrUX formFactor | PSI strategy | RUM userAgent prefix | Lab profile |
|-----------------|--------------|----------------------|-------------|
| `PHONE`   | `mobile`  | `mobile` / `mobile:android` / `mobile:ios` | `mobile-slow4g-4xcpu` |
| `DESKTOP` | `desktop` | `desktop` / `desktop:mac` / `desktop:windows` | `desktop-cable-1xcpu` |
| `TABLET`  | n/a       | `tablet` / `tablet:ipad` (+ mobile fallback)  | `mobile-slow4g-4xcpu` |

**Why there's no dedicated tablet profile**: CrUX tablets typically render
mobile CSS, their CPUs are closer to mobile than desktop, and tablet traffic
is too low in most CrUX datasets to be diagnostically useful. Using
`mobile-slow4g-4xcpu` is conservative — it slightly overestimates constraint
for modern iPads but keeps fix recommendations safe.

**`rum-fetch.js --form-factor` filter**: bundles are classified by
`bundle.userAgent` prefix. Bots (`bot`, `bot:seo`) and unclassifiable
userAgents are always dropped. TABLET is permissive — when asked for TABLET,
PHONE bundles are also included because many RUM collectors roll most tablet sessions
under `mobile`.

**Invariant across the skill chain**: baseline and every treatment run in
`cwv-fix` must use the same profile, and `cwv-validate` must use the same
profile as the baseline/treatment runs it's comparing. A profile mismatch
(e.g. baseline on `mobile-slow4g-4xcpu`, treatment on `desktop-cable-1xcpu`)
makes the IQR comparison meaningless because the underlying distributions
are shaped by the throttle settings, not the fix. The upstream envelope
carries `formFactor` + `profile` at top level so downstream skills can
refuse to run with a mismatched CLI override.

## Reconciliation workflow

Step-by-step for diagnosing a URL:

1. **CrUX first** — what metric is failing at field p75? LCP? INP? CLS?
2. **PSI / lab run** — does the lab reproduce the failure? If yes (gap ≤2×), continue. If no (gap >2×), reproduce the field condition first (auth, geo, cookies, A/B variant).
3. **Lab attribution** — use web-vitals attribution fields, PSI audits, HAR, coverage to identify root cause.
4. **Classify** — bottleneck / waste / opportunity. Chain classification for network findings.
5. **Patch and validate** — run `launcher.js` with `patches.json`, compare median of N=3 runs to baseline. Use IQR comparison (see `cwv-validate` skill) for high-confidence verdict.
6. **Re-verify field** — after the fix ships, watch CrUX for 2–3 weeks to confirm real-world impact. Lab improvements don't always translate 1:1.

The order matters. Skipping step 1 leads to fixing something CrUX doesn't care about. Skipping step 2 leads to lab-only fixes that don't move field.
