import { estimateTokenSize } from '../utils.js';
import {
  PHASE_FOCUS,
  getStructuredOutputFormat,
  getDataPriorityGuidance,
  getChainOfThoughtGuidance,
} from './shared.js';
import { createAgentPrompt } from './templates/base-agent-template.js';

/**
 * Prompt for CrUX summary analysis
 * @param {string} cruxSummary - CrUX summary text
 * @returns {string} CrUX summary analysis prompt
 */
export const cruxSummaryStep = (cruxSummary) => `
Here is the summarized CrUX data for the page:

${cruxSummary}
`;

/**
 * Prompt for PSI summary analysis
 * @param {string} psiSummary - PSI summary text
 * @returns {string} PSI summary analysis prompt
 */
export const psiSummaryStep = (psiSummary) => `
Here is the summarized PSI audit for the page load:

${psiSummary}
`;

/**
 * Prompt for HAR summary analysis
 * @param {string} harSummary - HAR summary text
 * @returns {string} HAR summary analysis prompt
 */
export const harSummaryStep = (harSummary) => `
Here is the summarized HAR data for the page:

${harSummary}
`;

/**
 * Prompt for performance entries summary analysis
 * @param {string} perfEntriesSummary - Performance entries summary text
 * @returns {string} Performance entries summary analysis prompt
 */
export const perfSummaryStep = (perfEntriesSummary) => `
Here are the summarized performance entries for the page load:

${perfEntriesSummary}
`;

/**
 * Prompt for HTML markup analysis
 * Phase A Optimization: Now receives CWV-focused HTML extract instead of full page
 * @param {string} pageUrl - URL of the page
 * @param {Object|string} resourcesOrHtml - CWV-relevant HTML data (JSON string)
 * @returns {string} HTML markup analysis prompt
 */
export const htmlStep = (pageUrl, resourcesOrHtml) => {
  const htmlData = typeof resourcesOrHtml === 'string' ? resourcesOrHtml : resourcesOrHtml?.[pageUrl];

  return `Here is CWV-relevant HTML data for the page:

**Note**: This is an optimized extract containing only CWV-critical elements:
- <head> metadata (preload, preconnect, scripts, stylesheets)
- LCP candidates (large images, hero sections)
- Performance anti-patterns (lazy-load above fold, missing dimensions)
- Third-party scripts

${htmlData}`;
};

/**
 * Prompt for rule analysis
 * @param {string} rules - Rule summary text
 * @returns {string} Rule analysis prompt
 */
export const rulesStep = (rules) => `
Here is the set of custom rules that failed for the page:

${rules}
`;

/**
 * Prompt for code analysis
 * @param {string} pageUrl - URL of the page
 * @param {Object} resources - Resources object containing code files
 * @param {number} threshold - Maximum token size to include (default: 100,000)
 * @returns {string} Code analysis prompt
 */
export const codeStep = (pageUrl, resources, threshold = 100_000) => {
  try {
    const html = resources[pageUrl];
    const code = Object.entries(resources)
       .filter(([key]) => key !== pageUrl)
       .filter(([key]) => !html || html.includes((new URL(key)).pathname) || key.match(/(lazy-styles.css|fonts.css|delayed.js)/))
       .filter(([,value]) => estimateTokenSize(value) < threshold) // do not bloat context with too large files
       .map(([key, value]) => `// File: ${key}\n${value}\n\n`).join('\n');
    return `
Here are the source codes for the important files on the page (the name for each file is given
to you as a comment before its content):

${code}
`;
  } catch (err) {
    return `Could not collect actual website code.`;
  }
};

/**
 * Prompt for code coverage summary analysis
 * @param {string} codeCoverageSummary - Code coverage summary text
 * @returns {string} Code coverage summary analysis prompt
 */
export const coverageSummaryStep = (codeCoverageSummary) => `
Here is the summarized code coverage data for the page:

${codeCoverageSummary}
`;

/**
 * Prompt for RUM data summary analysis
 * @param {string} rumSummary - RUM data summary text
 * @returns {string} RUM data summary analysis prompt
 */
export const rumSummaryStep = (rumSummary) => `
Here is the Real User Monitoring (RUM) data from the last 7 days:

${rumSummary}

**CRITICAL: Focus ONLY on "Current Page Metrics" section**
- Report findings ONLY for the current page being analyzed
- DO NOT report issues from "Other Pages on Site" unless marked as "CURRENT PAGE"
- Site-wide metrics are provided for context/comparison only
`;

function getBasePrompt(role) {
  return `You are ${role} for Core Web Vitals optimization.`;
}


export function cruxAgentPrompt(cms = 'eds') {
  const examples = `**Example 1: Field vs Lab Gap Analysis**
Input: CrUX LCP p75 = 4.2s (poor), PSI Lab LCP = 2.1s (good)
Output:
- Finding: Significant field-lab gap indicates real-world conditions differ from lab
- Evidence: CrUX LCP p75 (4.2s) is 2x worse than PSI lab (2.1s)
- Impact: Real users on slower connections/devices experience much worse LCP
- Confidence: 0.9 (field data is ground truth)
- Root Cause: Lab tests on fast connection don't reflect typical user conditions
- Recommendation: Focus on reducing payload size and improving server response for slow connections

**Example 2: Histogram Distribution Analysis**
Input: CrUX CLS histogram: good=15%, needs-improvement=20%, poor=65%
Output:
- Finding: 65% of users experience poor CLS (>0.25)
- Evidence: CrUX histogram shows only 15% of users have good CLS experience
- Impact: Majority of users see significant layout shifts during page load
- Confidence: 0.95 (histogram data is highly reliable)
- Recommendation: Prioritize CLS fixes - this affects most users

**Example 3: Origin vs URL-Level Comparison**
Input: Origin CrUX INP p75 = 180ms (good), URL CrUX INP p75 = 450ms (poor)
Output:
- Finding: This specific page has INP issues not representative of the site overall
- Evidence: URL INP (450ms) is 2.5x worse than origin average (180ms)
- Impact: Page-specific JavaScript or interactions are causing delays
- Confidence: 0.85 (URL-level data available and reliable)
- Recommendation: Investigate page-specific event handlers and heavy JavaScript

**Example 4: No CrUX Data Available**
Input: No CrUX data for URL (insufficient traffic)
Output:
- Finding: Insufficient traffic for CrUX data - rely on lab data and RUM
- Evidence: CrUX API returned no data for this URL
- Impact: Cannot validate lab findings with field data
- Confidence: N/A
- Recommendation: Use PSI lab data as primary source, consider enabling RUM for field insights`;

  return createAgentPrompt({
    agentName: 'CrUX Agent',
    role: 'analyzing Chrome User Experience Report (CrUX) field data',
    dataSource: 'crux',
    focusKey: 'CRUX',
    examples,
  });
}

export function rumAgentPrompt(cms = 'eds') {
  const examples = `**Example 1: RUM Shows Recent Regression**
Input: RUM LCP p75 = 3.2s (7-day), CrUX LCP p75 = 2.4s (28-day)
Output:
- Finding: LCP has regressed significantly in the past week
- Evidence: RUM LCP p75 (3.2s) is 33% worse than CrUX 28-day average (2.4s)
- Impact: Recent deployment or content change likely caused regression
- Confidence: 0.85 (field data comparison is reliable)
- Recommendation: Investigate recent changes, compare to previous week's RUM data

**Example 2: Page-Specific INP Issue**
Input: RUM INP p75 = 580ms for /checkout, site average = 180ms
Output:
- Finding: Checkout page has severe INP issues compared to site average
- Evidence: RUM INP for /checkout (580ms) is 3x worse than site average (180ms)
- Impact: Checkout interactions are frustrating users, potential conversion impact
- Confidence: 0.9 (page-specific data is concrete)
- Recommendation: Focus INP optimization on checkout page event handlers

**Example 3: RUM Validates CrUX Finding**
Input: CrUX CLS = 0.25, RUM CLS = 0.28 with attribution to hero image
Output:
- Finding: CLS issue confirmed by both CrUX and RUM, attributed to hero image
- Evidence: RUM CLS (0.28) aligns with CrUX (0.25), RUM shows hero image as top shifter
- Impact: Hero image without dimensions is consistent root cause
- Confidence: 0.95 (cross-validated by two field data sources)`;

  return createAgentPrompt({
    agentName: 'RUM Agent',
    role: 'analyzing Real User Monitoring (RUM) field data',
    dataSource: 'rum',
    focusKey: 'RUM',
    examples,
  });
}

export function psiAgentPrompt(cms = 'eds') {
  const examples = `**Example 1: LCP Issue with Render-Blocking Resources**
Input: LCP = 4.2s, render-blocking-resources audit shows 3 scripts (850ms savings)
Output:
- Finding: Three render-blocking scripts delay LCP by 850ms
- Evidence: PSI render-blocking-resources audit reports 850ms potential savings
- Impact: Removing blocking would improve FCP by ~850ms, cascading to LCP improvement of ~600-700ms
- Confidence: 0.8 (audit data reliable, impact estimate conservative)

**Example 2: No Critical Issues**
Input: All metrics passing (LCP=1.8s, CLS=0.05, TBT=150ms), no failing audits
Output:
- Finding: Performance is within thresholds, no critical bottlenecks identified
- Evidence: All Core Web Vitals pass: LCP < 2.5s, CLS < 0.1, TBT < 300ms
- Note: Minor optimization opportunities exist but are not impacting user experience

**Example 3: Unsized Images Causing CLS**
Input: CLS = 0.35, unsized-images audit fails with 12 images missing width/height
Output:
- Finding: 12 images lack explicit dimensions, causing layout shifts during load
- Evidence: PSI unsized-images audit identifies 12 instances
- Impact: Adding dimensions would prevent shifts, reducing CLS from 0.35 to ~0.10 (estimated 70% reduction)
- Confidence: 0.9 (dimensions fix is direct cause-effect)`;

  return createAgentPrompt({
    agentName: 'PSI Agent',
    role: 'analyzing PageSpeed Insights/Lighthouse results',
    dataSource: 'psi',
    focusKey: 'PSI',
    examples,
  });
}

export function perfObserverAgentPrompt(cms = 'eds', options = {}) {
  const { lightMode = false } = options;

  const additionalContext = lightMode ? `
**LIGHT MODE** - Focus on low-hanging fruit performance issues:

This analysis focuses ONLY on:
- **LCP Timing**: Identify LCP element and timing breakdown
- **CLS Attribution**: Identify layout shifts caused by unsized images or font swaps

ONLY report findings related to LCP timing or CLS attribution. Ignore long tasks, INP, and other issues.
` : '';

  const examples = `**Example 1: Long Tasks Blocking Main Thread**
Input: 5 long tasks detected, total 850ms, largest at 320ms attributed to "app.bundle.js"
Output:
- Finding: Main thread blocked by long tasks totaling 850ms, largest from app.bundle.js
- Evidence: PerformanceObserver shows 5 longtask entries, 320ms max duration attributed to app.bundle.js
- Impact: Breaking up long tasks could reduce TBT by ~650ms (tasks over 50ms threshold)
- Confidence: 0.85 (long task attribution is reliable)
- Fix: Split app.bundle.js into smaller chunks, use requestIdleCallback for non-critical work

**Example 2: LCP Element Identification**
Input: LCP entry shows element = <img class="hero-image">, startTime = 3200ms, size = 450000
Output:
- Finding: LCP element is hero image, rendered at 3200ms
- Evidence: PerformanceObserver LCP entry identifies img.hero-image as LCP element
- Impact: Optimizing hero image load could improve LCP by 700-1200ms
- Confidence: 0.9 (LCP element identification is definitive)
- Recommendation: Preload hero image, optimize format/size, ensure fetchpriority="high"

**Example 3: CLS Attribution to Font Swap**
Input: CLS entry shows value=0.15, sources include text elements with height changes of 8px, width changes of 1px
Output:
- Finding: Layout shift attributed to font swap (text reflow)
- Evidence: CLS sources show text elements with height change (8px) but minimal width change (1px) - font swap pattern
- Impact: Using font-display: optional or size-adjust could eliminate this shift
- Confidence: 0.8 (shift pattern consistent with font swap)
- Fix: Add size-adjust to fallback font, or use font-display: optional

**Example 4: CLS from Dynamic Content Insertion**
Input: CLS entry shows value=0.22, sources include container element pushed down by 150px
Output:
- Finding: Layout shift caused by dynamic content insertion above fold
- Evidence: CLS sources show container shifted down 150px, indicating content inserted above
- Impact: Reserving space for dynamic content could eliminate this shift
- Confidence: 0.85 (insertion pattern is clear)
- Fix: Reserve space with min-height or skeleton placeholder before content loads

**Example 5: Pre-LCP Long Tasks**
Input: 3 long tasks before LCP (total 400ms), LCP at 2800ms
Output:
- Finding: Long tasks before LCP delay rendering by 400ms
- Evidence: PerformanceObserver shows 400ms of long tasks completed before LCP at 2800ms
- Impact: Deferring non-critical JavaScript could reduce LCP by ~300-400ms
- Confidence: 0.8 (pre-LCP tasks directly impact LCP timing)
- Recommendation: Defer non-critical scripts, prioritize LCP-critical resources

**Example 6: High INP from Slow Event Handler (Issue #2 fix)**
Input: EventTiming entry for 'click' on button.submit-form: duration=340ms, processingStart=1520ms, startTime=1500ms, processingEnd=1780ms
Output:
- Finding: Click interaction on submit button has 340ms latency (poor INP threshold >200ms)
- Evidence: EventTiming shows: input delay=20ms, processing time=260ms, presentation delay=60ms
- Impact: Optimizing event handler could reduce INP by ~200ms to meet "good" threshold
- Confidence: 0.9 (EventTiming provides precise latency breakdown)
- Root Cause: Processing time (260ms) is the bottleneck, likely heavy JavaScript execution in click handler
- Recommendation: Break up long task in event handler, use requestIdleCallback for non-critical work, consider debouncing

**Example 7: First Input Delay (Fallback for older browsers)**
Input: first-input entry: name='pointerdown', duration=180ms, processingStart=850ms, startTime=720ms
Output:
- Finding: First user interaction delayed by 180ms (FID)
- Evidence: first-input entry shows 130ms input delay + 50ms processing time
- Impact: Reducing main-thread blocking could improve FID by ~100-150ms
- Confidence: 0.85 (first-input provides reliable FID measurement)
- Recommendation: Defer or break up long tasks blocking main thread during page load`;

  return createAgentPrompt({
    agentName: 'Performance Observer Agent',
    role: 'analyzing Performance Observer data captured during page load simulation',
    dataSource: 'perf_observer',
    focusKey: 'PERF_OBSERVER',
    examples,
    additionalContext,
  });
}

export function harAgentPrompt(cms = 'eds', options = {}) {
  const { lightMode = false } = options;

  const additionalContext = lightMode ? `
**LIGHT MODE** - Focus on low-hanging fruit performance issues:

This analysis focuses ONLY on:
- **Hero Image Network Timing**: Identify LCP image request timing, connection overhead
- **Font Network Timing**: Identify font CDN timing, missing preconnect

ONLY report findings related to hero image or font network timing. Ignore other network issues.
` : '';

  const examples = `**Example 1: High TTFB Due to Server Processing**
Input: HAR shows main document TTFB = 1200ms, timing breakdown: DNS=10ms, TCP=15ms, SSL=20ms, Wait=1100ms, Download=55ms
Output:
- Finding: Server processing time (Wait phase) is primary bottleneck at 1100ms (92% of total)
- Evidence: HAR timing breakdown shows Wait dominates total 1200ms TTFB
- Impact: Optimizing server-side processing could reduce TTFB by ~900ms (targeting 300ms Wait time)
- Confidence: 0.85 (timing data accurate, but server optimization varies)

**Example 2: Large JavaScript Bundle Delaying LCP**
Input: HAR shows app.bundle.js = 850KB transfer size, loaded at 2100ms, blocking parser
Output:
- Finding: Large JavaScript bundle delays page interactivity and LCP element rendering
- Evidence: HAR shows 850KB transfer at 2100ms, resource priority indicates parser-blocking
- Impact: Code splitting could defer 60% of bundle (510KB), improving LCP by ~800ms
- Confidence: 0.7 (code split effectiveness depends on implementation)

**Example 3: Multiple Third-Party Requests**
Input: HAR shows 45 third-party requests (analytics, ads, tracking) totaling 1.2MB
Output:
- Finding: Third-party resources add 1.2MB transfer and 45 network requests
- Evidence: HAR domain analysis shows non-first-party origins account for 40% of total requests
- Impact: Deferring non-critical third-parties could improve TBT by ~300ms and reduce bandwidth
- Confidence: 0.8 (defer strategy is proven, but requires careful implementation)

**Example 4: Server-Timing Shows Origin Bottleneck (Issue #3 fix)**
Input: Server-Timing header shows: cdn;dur=5, dispatcher;dur=10, origin;dur=1200
Output:
- Finding: Origin processing dominates TTFB (1200ms of 1215ms total)
- Evidence: Server-Timing breakdown: CDN=5ms, Dispatcher=10ms, Origin=1200ms
- Impact: Optimizing origin tier (Sling Models, DB queries) could reduce TTFB by ~1000ms
- Confidence: 0.9 (Server-Timing provides precise attribution)
- Root Cause: True (origin processing is the bottleneck, not network or CDN)
- Recommendation: Profile Sling Models, check for N+1 queries, enable caching

**Example 5: CDN Cache Miss Causes High TTFB (Issue #3 fix)**
Input: Server-Timing header shows: cache;desc=MISS;dur=0.1, cdn;dur=850
Output:
- Finding: CDN cache MISS forces origin request, adding 850ms to TTFB
- Evidence: Server-Timing shows cache=MISS, CDN processing=850ms (includes origin fetch)
- Impact: Improving cache hit rate could reduce TTFB by ~700-800ms
- Confidence: 0.85 (cache MISS clearly documented)
- Root Cause: True (cache configuration is the root cause)
- Recommendation: Fix cache headers (Cache-Control, Vary), increase TTL, check invalidation rules

**Example 6: Critical Request Chain Delaying LCP (Phase 4B)**
Input: HAR shows 3-level JS chain [critical]: main.js (loaded at 500ms) → translations.js (loaded at 1200ms) → adobe.js (loaded at 2500ms), total sequential delay 2000ms
Output:
- ID: har-chain-lcp-1
- Type: bottleneck
- Metric: LCP
- Description: Critical 3-level JavaScript request chain adds 2000ms sequential delay blocking LCP rendering
- Evidence:
  * Source: har
  * Reference: main.js → translations.js → adobe.js (3-level chain, [critical])
  * Confidence: 0.85
- EstimatedImpact:
  * Metric: LCP
  * Reduction: 1500 (preloading translations.js and adobe.js allows parallel download)
  * Confidence: 0.75
  * Calculation: Sequential delay 2000ms - parallel overhead 500ms = 1500ms saved
- Root Cause: True (sequential discovery prevents parallel loading)
- Reasoning:
  * Observation: HAR shows 3-level sequential chain with 700ms gaps between each level
  * Diagnosis: Scripts discovered sequentially - each must download and execute before triggering next level
  * Mechanism: Sequential chains prevent parallel download, adding cumulative network latency to LCP
  * Solution: Preload translations.js and adobe.js in HTML <head> to enable parallel downloading while maintaining execution order
  * CodeExample: \`<link rel="preload" as="script" href="/scripts/translations.js">\n<link rel="preload" as="script" href="/scripts/adobe.js">\`

**Example 7: Deferrable Third-Party Chain (Phase 4B)**
Input: HAR shows 4-level JS chain [deferrable]: cookielaw.js → analytics.js → tracking.js → beacon.js, total delay 2100ms, all consent/analytics category
Output:
- ID: har-chain-defer-1
- Type: waste
- Metric: TBT
- Description: Deferrable 4-level third-party chain (consent/analytics) adds 2100ms blocking main thread unnecessarily
- Evidence:
  * Source: har
  * Reference: cookielaw.js → analytics.js → tracking.js → beacon.js (4-level chain, [deferrable])
  * Confidence: 0.9
- EstimatedImpact:
  * Metric: TBT
  * Reduction: 2100 (defer entire chain to post-LCP)
  * Confidence: 0.85
  * Calculation: Full chain delay 2100ms eliminated from critical path
- Root Cause: True (third-party scripts loaded synchronously)
- Reasoning:
  * Observation: HAR shows all 4 scripts are non-critical third-parties (cookie consent and analytics)
  * Diagnosis: Chain executes during page load, blocking main thread and delaying interactivity
  * Mechanism: Non-critical third-party scripts compete with critical resources for bandwidth and CPU
  * Solution: Defer entire chain using async/defer attributes or load post-LCP via setTimeout
  * CodeExample: \`<script src="cookielaw.js" defer></script>\` or load after window.onload`;

  return createAgentPrompt({
    agentName: 'HAR Agent',
    role: 'analyzing HAR (HTTP Archive) file data for Core Web Vitals optimization focused on network performance',
    dataSource: 'har',
    focusKey: 'HAR',
    examples,
    additionalContext,
  });
}

export function htmlAgentPrompt(cms = 'eds', options = {}) {
  const { lightMode = false } = options;

  let focusInstruction = '';
  if (lightMode) {
    focusInstruction = `
**LIGHT MODE** - Focus on low-hanging fruit performance issues:

This analysis focuses ONLY on these issue types:
- **Hero Image Loading** (LCP): Missing preload/fetchpriority, late discovery, loading="lazy" on LCP
- **Font Optimization** (LCP/CLS): Missing font-display or preload hints for custom fonts
- **Image Sizing** (CLS): Missing width/height/aspect-ratio attributes

ONLY report findings that match these patterns. Ignore all other issues.
`;
  }

  return `${getBasePrompt('analyzing HTML markup for Core Web Vitals optimization opportunities')}
${focusInstruction}

${getDataPriorityGuidance('html')}

${getChainOfThoughtGuidance()}

## Few-Shot Examples

**Example 1: Missing LCP Image Preload**
Input: LCP element is <img src="hero.jpg">, no preload hint in <head>
Output:
- Finding: LCP image lacks preload hint, discovered late by parser
- Evidence: HTML <head> has no <link rel="preload" as="image" href="hero.jpg">
- Impact: Adding preload could improve LCP by 200-500ms by starting fetch earlier
- Confidence: 0.85 (preload effectiveness depends on server/CDN)
- Fix: Add <link rel="preload" as="image" href="hero.jpg" fetchpriority="high">

**Example 2: Render-Blocking Third-Party Scripts**
Input: <script src="https://analytics.example.com/tracker.js"> in <head> without async/defer
Output:
- Finding: Third-party analytics script blocks rendering
- Evidence: HTML shows synchronous script tag in <head> for external domain
- Impact: Adding async attribute could reduce FCP by 100-300ms
- Confidence: 0.9 (async is safe for analytics scripts)
- Fix: Add async attribute: <script async src="...">

**Example 3: Images Missing Dimensions**
Input: Multiple <img> tags without width/height attributes
Output:
- Finding: Images lack explicit dimensions, causing layout shifts during load
- Evidence: HTML shows <img src="product.jpg" alt="..."> without width/height
- Impact: Adding dimensions prevents CLS from image loading
- Confidence: 0.95 (dimensions fix is direct cause-effect)
- Fix: Add width and height attributes matching intrinsic dimensions

**Example 4: Excessive Preconnect Hints**
Input: 12 <link rel="preconnect"> hints in <head>
Output:
- Finding: Too many preconnect hints may waste browser resources
- Evidence: HTML <head> contains 12 preconnect hints to different origins
- Impact: Browser connection limits mean not all preconnects are useful
- Confidence: 0.75 (depends on actual resource usage)
- Recommendation: Keep only 2-4 preconnects for critical origins, remove others

**Example 5: WRONG - Preconnect to Non-Critical Third Parties (What NOT to recommend)**
Input: Site loads cookielaw.org for consent, adobedtm for analytics, no preconnect hints
Output:
- ❌ WRONG: "Add preconnect to cdn.cookielaw.org and assets.adobedtm.com"
- ✅ CORRECT: These are non-critical third parties that should load AFTER LCP
- Finding: Cookie consent and tag managers are NOT in LCP critical path
- Recommendation: Load cookielaw and adobedtm async/deferred, NOT preconnect
- Exception: Adobe Launch MAY need early loading ONLY if Adobe Target does above-fold personalization
- Detection: Look for at.js or mbox calls to detect Target; if absent, defer adobedtm

**Categories that should NEVER get preconnect recommendations:**
- Cookie consent: cookielaw.org, onetrust.com, cookiebot.com → Always defer
- Analytics: google-analytics.com, omtrdc.net → Always async
- Tag managers: googletagmanager.com, adobedtm (unless Target detected) → Async
- Monitoring: hotjar.com, fullstory.com → Async
- Social: facebook.net, linkedin.com → Async

**Example 6: Font Loading Without font-display**
Input: @font-face rules without font-display property
Output:
- Finding: Custom fonts may cause invisible text (FOIT) during load
- Evidence: CSS @font-face lacks font-display property
- Impact: Adding font-display: swap prevents invisible text, may cause minor CLS
- Confidence: 0.85 (swap is generally safe)
- Fix: Add font-display: swap to @font-face rules, consider size-adjust for fallback

**IMPORTANT: Cross-Reference HAR Chain Analysis**

Before recommending any preload/preconnect hints:
1. **Check if the resource is part of a request chain** (see HAR summary "JS Request Chains" section)
2. **Check the chain classification**: [critical], [deferrable], or [mixed]
3. **Apply the correct recommendation**:
   - If chain is **DEFERRABLE** (only analytics/consent/monitoring/ads): NEVER recommend preload/preconnect
   - If chain is **CRITICAL** (first-party scripts/stylesheets/fonts): Safe to recommend preload
   - If chain has **>50% unused code** (see HAR summary): Recommend code-splitting BEFORE preload
4. **Conflicting recommendations are harmful**:
   - DO NOT recommend preloading scripts that HAR Agent classified as deferrable
   - DO NOT recommend preconnecting to domains in deferrable chains
   - DO recommend async/defer for deferrable chains instead

**Example**: HAR shows "4-level chain [deferrable]: cookielaw → analytics → tracking" → DO NOT recommend preload/preconnect to cookielaw.org

## Your Analysis Focus
${PHASE_FOCUS.HTML}

${getStructuredOutputFormat('HTML Agent')}
`;
}

export function rulesAgentPrompt(cms = 'eds') {
  return `${getBasePrompt('analyzing failed performance rules to identify Core Web Vitals optimization opportunities')}

${getDataPriorityGuidance('rules')}

## Your Analysis Focus
${PHASE_FOCUS.RULES}

${getChainOfThoughtGuidance()}

${getStructuredOutputFormat('Rules Agent')}
`;
}

export function coverageAgentPrompt(cms = 'eds') {
  return `${getBasePrompt('analyzing JavaScript and CSS code coverage data to identify optimization opportunities for Core Web Vitals')}

${getDataPriorityGuidance('coverage')}

${getChainOfThoughtGuidance()}

## Few-Shot Examples

**Example 1: High Unused JavaScript Post-LCP**
Input: app.bundle.js = 420KB, 65% unused overall, 280KB (70%) executes post-LCP
Output:
- Finding: Majority of app.bundle.js (280KB/70%) executes after LCP, delaying interactivity
- Evidence: Coverage shows 70% post-LCP usage, indicating delayed/lazy code not split
- Impact: Code splitting post-LCP sections could reduce TBT by ~200ms and improve INP
- Confidence: 0.85 (coverage data accurate, split effectiveness depends on implementation)

**Example 2: Unused CSS Rules**
Input: styles.css = 85KB, 45% unused rules detected
Output:
- Finding: 45% of CSS rules (38KB) are unused, unnecessarily increasing parse/render time
- Evidence: Coverage report shows 38KB unused across styles.css
- Impact: Removing unused CSS could reduce stylesheet size by 38KB, improving FCP by ~50ms
- Confidence: 0.75 (unused detection accurate, but critical CSS extraction needs care)

**Example 3: Minified File with High Unused Code**
Input: vendor.min.js = 320KB minified, 88% unused, includes full libraries (Lodash, Moment.js)
Output:
- Finding: Minified vendor bundle includes entire libraries but uses <12% of functionality
- Evidence: Coverage shows 88% unused in vendor.min.js despite minification
- Impact: Tree-shaking or targeted imports could reduce bundle by ~280KB, improving TBT by ~250ms
- Confidence: 0.9 (minified files still analyzed in Phase 0, library bloat is common)

**Example 4: Unused Code in Critical Request Chain**
Input: app.bundle.js in critical chain (HAR shows [critical] classification), 420KB file with 65% unused code (280KB)
HAR summary shows: "3-level chain [critical]: main.js → app.bundle.js → vendor.js, 1200ms delay"
Output:
- Finding: app.bundle.js has 280KB (65%) unused code within a critical request chain
- Evidence: Coverage shows 280KB unused across app.bundle.js; HAR identifies it in critical-path chain
- Impact: Code-splitting could reduce bundle by 280KB, improving both chain delay and TBT
- Confidence: 0.85 (coverage data accurate, critical chain context from HAR)
- **⚠️ IMPORTANT**: Recommend code-splitting BEFORE considering preload for this chain
- Recommendation: Split app.bundle.js into:
  1. app-core.js (140KB, critical functionality)
  2. app-features.js (280KB, lazy-loaded non-critical code)
- Then preload only app-core.js in the chain
- Root Cause: Bundling strategy includes all features upfront without code-splitting
- DO NOT recommend preloading bloated bundles — fix the bloat first

## Your Analysis Focus
${PHASE_FOCUS.COVERAGE}

${getStructuredOutputFormat('Coverage Agent')}
`;
}

export function codeReviewAgentPrompt(cms = 'eds') {
  return `${getBasePrompt('analyzing JavaScript and CSS code for Core Web Vitals optimization opportunities, informed by code coverage analysis')}

${getDataPriorityGuidance('code')}

## Your Analysis Focus
${PHASE_FOCUS.CODE_REVIEW}

${getChainOfThoughtGuidance()}

${getStructuredOutputFormat('Code Review Agent')}
`;
}

