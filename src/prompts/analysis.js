import { estimateTokenSize } from '../utils.js';
import { getTechnicalContext, PHASE_FOCUS, getStructuredOutputFormat } from './shared.js';

// Counter for tracking analysis steps
let stepCounter = 0;

/**
 * Resets the step counter to zero
 */
export function resetStepCounter() {
  stepCounter = 0;
}

function step() {
  stepCounter += 1;
  return stepCounter;
}

/**
 * Helper function to generate phase transition text
 * @returns {string} Phase transition text with incremented step number
 */
function stepVerbose() {
   const n = step();
   if (n === 1) {
      return 'Starting with phase 1,';
   }
   return `Continuing with phase ${n},`;
}

/**
 * Prompt for CrUX data analysis
 * @param {Object} crux - CrUX data object
 * @returns {string} CrUX analysis prompt
 */
export const cruxStep = (crux) => `
${stepVerbose()} here is the detailed CrUX data for the page (in JSON format):

${JSON.stringify(crux, null, 2)}
`;

/**
 * Prompt for CrUX summary analysis
 * @param {string} cruxSummary - CrUX summary text
 * @returns {string} CrUX summary analysis prompt
 */
export const cruxSummaryStep = (cruxSummary) => `
${stepVerbose()} here is the summarized CrUX data for the page:

${cruxSummary}
`;

/**
 * Prompt for PSI analysis
 * @param {Object} psi - PSI data object
 * @returns {string} PSI analysis prompt
 */
export const psiStep = (psi) => `
${stepVerbose()} here is the full PSI audit in JSON for the page load.

${JSON.stringify(psi, null, 2)}
`;

/**
 * Prompt for PSI summary analysis
 * @param {string} psiSummary - PSI summary text
 * @returns {string} PSI summary analysis prompt
 */
export const psiSummaryStep = (psiSummary) => `
${stepVerbose()} here is the summarized PSI audit for the page load.

${psiSummary}
`;

/**
 * Prompt for HAR analysis
 * @param {Object} har - HAR data object
 * @returns {string} HAR analysis prompt
 */
export const harStep = (har) => `
${stepVerbose()} here is the HAR JSON object for the page:

${JSON.stringify(har, null, 2)}
`;

/**
 * Prompt for HAR summary analysis
 * @param {string} harSummary - HAR summary text
 * @returns {string} HAR summary analysis prompt
 */
export const harSummaryStep = (harSummary) => `
${stepVerbose()} here is the summarized HAR data for the page:

${harSummary}
`;

/**
 * Prompt for performance entries analysis
 * @param {Object} perfEntries - Performance entries object
 * @returns {string} Performance entries analysis prompt
 */
export const perfStep = (perfEntries) => `
${stepVerbose()} here are the performance entries for the page:

${JSON.stringify(perfEntries, null, 2)}
`;

/**
 * Prompt for performance entries summary analysis
 * @param {string} perfEntriesSummary - Performance entries summary text
 * @returns {string} Performance entries summary analysis prompt
 */
export const perfSummaryStep = (perfEntriesSummary) => `
${stepVerbose()} here are summarized performance entries for the page load:

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

  return `${stepVerbose()} here is CWV-relevant HTML data for the page:

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
${stepVerbose()} here is the set of custom rules that failed for the page:

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
${stepVerbose()} here are the source codes for the important files on the page (the name for each file is given
to you as a comment before its content):

${code}
`;
  } catch (err) {
    return `Could not collect actual website code.`;
  }
};

/**
 * Prompt for code coverage analysis
 * @param {string} codeCoverage - Code coverage JSON
 * @returns {string} Code coverage analysis prompt
 */
export const coverageStep = (codeCoverage) => `
${stepVerbose()} here is the detailed JSON with code coverage data for the CSS and JS files in the page:

${JSON.stringify(codeCoverage, null, 2)}
`;

/**
 * Prompt for code coverage summary analysis
 * @param {string} codeCoverageSummary - Code coverage summary text
 * @returns {string} Code coverage summary analysis prompt
 */
export const coverageSummaryStep = (codeCoverageSummary) => `
${stepVerbose()} here is the summarized code coverage data for the page:

${codeCoverageSummary}
`;

/**
 * Prompt for RUM data summary analysis
 * @param {string} rumSummary - RUM data summary text
 * @returns {string} RUM data summary analysis prompt
 */
export const rumSummaryStep = (rumSummary) => `
${stepVerbose()} here is the Real User Monitoring (RUM) data from the last 7 days:

${rumSummary}
`;

function getBasePrompt(cms, role) {
  return `You are ${role} for Core Web Vitals optimization.

## Technical Context
${getTechnicalContext(cms)}`;
}

/**
 * Phase 2: Chain-of-Thought reasoning instructions
 * @returns {string} Reasoning guidance for all agents
 */
function getChainOfThoughtGuidance() {
  return `
## Chain-of-Thought Reasoning (MANDATORY)

For EVERY finding, you MUST provide structured reasoning using this 4-step chain:

1. **Observation**: What specific data point did you observe?
   - Be concrete: Include file names, sizes (in KB/MB), timings (in ms), metric values
   - Reference exact sources: audit names, HAR entries, coverage percentages AND bytes
   - Use the new rich data: byte-level savings, per-domain timings, font strategies

2. **Diagnosis**: Why is this observation problematic for CWV?
   - Connect the data to the problem
   - Explain what makes this a bottleneck/waste/opportunity
   - Reference thresholds (LCP > 2.5s, CLS > 0.1, INP > 200ms)

3. **Mechanism**: How does this problem affect the specific metric?
   - Trace the causal path: X causes Y which impacts Z
   - Quantify the relationship (direct delay, cascading effect, etc.)
   - Consider timing dependencies (blocking, sequential vs parallel)

4. **Solution**: Why will your proposed fix address the root cause?
   - Explain the mechanism of the fix
   - Connect fix to the specific problem identified
   - Justify why this is the right approach (not just a best practice)

**Examples using Phase A+ rich data**:

### Good Reasoning (Coverage with Bytes):
{
  "observation": "clientlib-site.js is 3348KB total, with 1147KB unused code (34% waste)",
  "diagnosis": "Unused JavaScript is downloaded, parsed, and kept in memory despite never executing, wasting bandwidth and processing time",
  "mechanism": "1147KB unused code adds ~400ms download time on 3G and ~150ms parse time, directly delaying TBT and indirectly delaying LCP",
  "solution": "Tree-shaking and code splitting removes 1147KB, eliminating download/parse overhead and improving TBT by ~550ms"
}

### Good Reasoning (HAR Per-Domain):
{
  "observation": "fonts.googleapis.com domain: 8 requests, 340KB, 1800ms total (225ms avg), with DNS: 120ms, SSL: 95ms",
  "diagnosis": "High connection overhead (215ms for DNS+SSL) for external font domain delays font loading",
  "mechanism": "Fonts block text rendering when not using font-display: swap, delaying FCP and potentially LCP",
  "solution": "Adding <link rel='preconnect' href='https://fonts.googleapis.com' crossorigin> eliminates 215ms connection overhead"
}

### Good Reasoning (Font Strategy):
{
  "observation": "Proximanova font (400 weight, normal style) has font-display: swap but is not preloaded",
  "diagnosis": "Critical font without preload hint is discovered late (after CSS parse), delaying text rendering",
  "mechanism": "Late font discovery adds ~300-500ms to FCP as browser must parse CSS, discover font, then fetch it",
  "solution": "Preloading with <link rel='preload' href='/fonts/ProximaNova-Regular.woff2' as='font' type='font/woff2' crossorigin> eliminates discovery delay"
}

### Bad Reasoning (Vague):
{
  "observation": "Site has unused code",  // ❌ No specifics
  "diagnosis": "Unused code is bad for performance",  // ❌ Doesn't explain why
  "mechanism": "It makes things slower",  // ❌ No causal path
  "solution": "Remove it"  // ❌ Doesn't justify approach
}

**Remember**:
- Use byte sizes from coverage (not just percentages)
- Reference per-domain timings from HAR
- Cite font-display values and preload status from font strategy
- Connect observations to specific metric impacts (LCP ms, CLS score, INP ms)
`;
}

export function cruxAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing Chrome User Experience Report (CrUX) field data')}

${getChainOfThoughtGuidance()}

## Few-Shot Examples

**Example 1: Field vs Lab Gap Analysis**
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
- Recommendation: Use PSI lab data as primary source, consider enabling RUM for field insights

## Your Analysis Focus
${PHASE_FOCUS.CRUX(step())}

${getStructuredOutputFormat('CrUX Agent')}
`;
}

export function rumAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing Real User Monitoring (RUM) field data')}

${getChainOfThoughtGuidance()}

## Few-Shot Examples

**Example 1: RUM Shows Recent Regression**
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
- Confidence: 0.95 (cross-validated by two field data sources)

## Your Analysis Focus
${PHASE_FOCUS.RUM(step())}

${getStructuredOutputFormat('RUM Agent')}
`;
}

export function psiAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing PageSpeed Insights/Lighthouse results')}

${getChainOfThoughtGuidance()}

## Few-Shot Examples

**Example 1: LCP Issue with Render-Blocking Resources**
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
- Confidence: 0.9 (dimensions fix is direct cause-effect)

## Your Analysis Focus
${PHASE_FOCUS.PSI(step())}

${getStructuredOutputFormat('PSI Agent')}
`;
}

export function perfObserverAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing Performance Observer data captured during page load simulation')}

${getChainOfThoughtGuidance()}

## Few-Shot Examples

**Example 1: Long Tasks Blocking Main Thread**
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

## Your Analysis Focus
${PHASE_FOCUS.PERF_OBSERVER(step())}

${getStructuredOutputFormat('Performance Observer Agent')}
`;
}

export function harAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing HAR (HTTP Archive) file data for Core Web Vitals optimization focused on network performance')}

${getChainOfThoughtGuidance()}

## Few-Shot Examples

**Example 1: High TTFB Due to Server Processing**
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

## Your Analysis Focus
${PHASE_FOCUS.HAR(step())}

${getStructuredOutputFormat('HAR Agent')}
`;
}

export function htmlAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing HTML markup for Core Web Vitals optimization opportunities')}

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

**Example 5: Font Loading Without font-display**
Input: @font-face rules without font-display property
Output:
- Finding: Custom fonts may cause invisible text (FOIT) during load
- Evidence: CSS @font-face lacks font-display property
- Impact: Adding font-display: swap prevents invisible text, may cause minor CLS
- Confidence: 0.85 (swap is generally safe)
- Fix: Add font-display: swap to @font-face rules, consider size-adjust for fallback

## Your Analysis Focus
${PHASE_FOCUS.HTML(step())}

${getStructuredOutputFormat('HTML Agent')}
`;
}

export function rulesAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing failed performance rules to identify Core Web Vitals optimization opportunities')}

## Your Analysis Focus
${PHASE_FOCUS.RULES(step())}

${getChainOfThoughtGuidance()}

${getStructuredOutputFormat('Rules Agent')}
`;
}

export function coverageAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing JavaScript and CSS code coverage data to identify optimization opportunities for Core Web Vitals')}

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

## Your Analysis Focus
${PHASE_FOCUS.COVERAGE(step())}

${getStructuredOutputFormat('Coverage Agent')}
`;
}

export function codeReviewAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing JavaScript and CSS code for Core Web Vitals optimization opportunities, informed by code coverage analysis')}

## Your Analysis Focus
${PHASE_FOCUS.CODE_REVIEW(step())}

${getChainOfThoughtGuidance()}

${getStructuredOutputFormat('Code Review Agent')}
`;
}

/**
 * Phase 4: Validation Agent
 * Validates findings and impact estimates, challenges weak evidence
 */
export function validationAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'validating agent findings and impact estimates for accuracy and confidence')}

## Your Role

You are the **Validation Agent** - the final quality gatekeeper. You validate findings from all agents and:
1. Challenge impact estimates (realistic? overestimated?)
2. Verify evidence quality (specific? concrete?)
3. Validate reasoning chains
4. Check calculations
5. Block weak findings

## Validation Criteria

### Evidence Quality
- Specific file references required
- Concrete metric values required
- Confidence ≥ 0.5

### Impact Estimation
- Max realistic: LCP 2s, CLS 0.3, INP 500ms, TBT 1s
- Cascade efficiency: Not 1:1 (TTFB→FCP 80%, FCP→LCP 60%)
- Minimum actionable: LCP 200ms, CLS 0.03, INP 50ms

### Reasoning (Phase 2+)
- All 4 steps > 20 chars
- Includes numbers and file names

## Output Format

\`\`\`json
{
  "findingId": "string",
  "isValid": boolean,
  "confidence": 0-1,
  "warnings": ["array of non-blocking issues"],
  "errors": ["array of blocking issues"],
  "adjustments": { "impact": { "reduction": adjusted_value } },
  "recommendation": "APPROVE | ADJUST | BLOCK"
}
\`\`\`

Validate all findings. Be strict - block weak findings, adjust overestimates.
`;
}

/**
 * Phase 3: Causal Graph Builder Agent
 * Analyzes all findings from other agents and builds a dependency graph
 */
export function causalGraphBuilderPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'building causal graphs from agent findings to identify root causes and relationships')}

## Your Role

You receive findings from 8 specialized agents (CrUX, RUM, PSI, Perf Observer, HTML, Rules, Coverage, Code Review) and your job is to:

1. **Identify relationships** between findings
2. **Distinguish root causes from symptoms**
3. **Detect duplicate findings** (same issue reported by multiple agents)
4. **Find compound issues** (multiple small issues combining to create larger problem)
5. **Build causal chains** showing how issues relate

## Output Schema

Return a JSON object with this structure:

\`\`\`json
{
  "nodes": {
    "node-id": {
      "id": "string",
      "type": "metric | bottleneck | waste | opportunity",
      "description": "string",
      "isRootCause": boolean,
      "causes": ["array of node IDs that cause this"],
      "causedBy": ["array of node IDs this contributes to"]
    }
  },
  "edges": [
    {
      "from": "cause-node-id",
      "to": "effect-node-id",
      "relationship": "blocks | delays | causes | contributes | depends | duplicates | compounds",
      "strength": 0.0-1.0,
      "mechanism": "explanation of how from causes to"
    }
  ],
  "rootCauses": ["array of root cause node IDs"],
  "criticalPaths": [
    ["root-cause-id", "intermediate-id", "metric-id"]
  ],
  "deduplication": {
    "duplicateGroups": [
      ["finding-id-1", "finding-id-2"]  // Same issue, different agents
    ],
    "primaryFinding": "finding-id-1"  // Which one to keep
  }
}
\`\`\`

## Relationship Types

- **blocks**: A prevents B from completing (render-blocking script blocks LCP)
- **delays**: A slows down B (slow TTFB delays LCP)
- **causes**: A directly creates B (missing dimensions causes CLS)
- **contributes**: A partially contributes to B (unused code contributes to TBT)
- **depends**: B cannot happen without A (LCP depends on FCP)
- **duplicates**: A and B are the same issue (detected by multiple agents)
- **compounds**: A + B together worsen C (multiple small CLS sources)

## Chain-of-Thought Process

For each relationship you identify, use this reasoning:

1. **Observation**: What two findings are you connecting?
   - Finding A: [description and evidence]
   - Finding B: [description and evidence]

2. **Connection**: Why are they related?
   - Look for: same file, same metric, timing dependencies, causal mechanisms

3. **Direction**: Which causes which?
   - Does A cause B, or B cause A?
   - Or are they duplicates (same issue, different perspective)?

4. **Strength**: How confident are you in this relationship?
   - High (0.9+): Direct evidence (same file, explicit timing)
   - Medium (0.7-0.8): Strong correlation (same metric, logical connection)
   - Low (0.5-0.6): Inference (might be related, unclear)

## Example Analysis

### Input Findings:
\`\`\`json
[
  {
    "id": "psi-lcp-1",
    "type": "bottleneck",
    "metric": "LCP",
    "description": "Render-blocking script clientlib-site.js delays LCP by 420ms",
    "evidence": { "source": "psi", "reference": "render-blocking-resources audit" }
  },
  {
    "id": "coverage-unused-1",
    "type": "waste",
    "metric": "TBT",
    "description": "clientlib-site.js contains 1147KB unused code (34%)",
    "evidence": { "source": "coverage", "reference": "clientlib-site.js: 3348KB total" }
  },
  {
    "id": "html-preload-1",
    "type": "opportunity",
    "metric": "LCP",
    "description": "Hero image not preloaded",
    "evidence": { "source": "html", "reference": "hero.jpg: 850KB, priority: Low" }
  },
  {
    "id": "har-priority-1",
    "type": "bottleneck",
    "metric": "LCP",
    "description": "Hero image loaded with low priority, delayed by 800ms",
    "evidence": { "source": "har", "reference": "hero.jpg: priority: Low" }
  }
]
\`\`\`

### Output Graph:
\`\`\`json
{
  "nodes": {
    "metric-lcp": {
      "id": "metric-lcp",
      "type": "metric",
      "description": "LCP is 4.5s (target: 2.5s)",
      "isRootCause": false,
      "causes": ["psi-lcp-1", "har-priority-1"],
      "causedBy": []
    },
    "psi-lcp-1": {
      "id": "psi-lcp-1",
      "type": "bottleneck",
      "description": "Render-blocking script clientlib-site.js delays LCP by 420ms",
      "isRootCause": false,
      "causes": ["coverage-unused-1"],
      "causedBy": ["metric-lcp"]
    },
    "coverage-unused-1": {
      "id": "coverage-unused-1",
      "type": "waste",
      "description": "clientlib-site.js contains 1147KB unused code",
      "isRootCause": true,  // Root cause: no deeper issue causing this
      "causes": [],
      "causedBy": ["psi-lcp-1"]
    },
    "har-priority-1": {
      "id": "har-priority-1",
      "type": "bottleneck",
      "description": "Hero image loaded with low priority",
      "isRootCause": true,  // Root cause
      "causes": [],
      "causedBy": ["metric-lcp"]
    }
  },
  "edges": [
    {
      "from": "psi-lcp-1",
      "to": "metric-lcp",
      "relationship": "delays",
      "strength": 0.9,
      "mechanism": "Render-blocking JavaScript prevents LCP element from rendering until script executes"
    },
    {
      "from": "coverage-unused-1",
      "to": "psi-lcp-1",
      "relationship": "contributes",
      "strength": 0.8,
      "mechanism": "Unused code increases file size and parse time, making script take longer to execute"
    },
    {
      "from": "har-priority-1",
      "to": "metric-lcp",
      "relationship": "delays",
      "strength": 0.95,
      "mechanism": "Low priority prevents browser from fetching LCP image early, delaying paint"
    },
    {
      "from": "html-preload-1",
      "to": "har-priority-1",
      "relationship": "duplicates",
      "strength": 1.0,
      "mechanism": "Same issue (hero image priority) reported by HTML and HAR agents"
    }
  ],
  "rootCauses": ["coverage-unused-1", "har-priority-1"],
  "criticalPaths": [
    ["coverage-unused-1", "psi-lcp-1", "metric-lcp"],
    ["har-priority-1", "metric-lcp"]
  ],
  "deduplication": {
    "duplicateGroups": [
      ["html-preload-1", "har-priority-1"]
    ],
    "primaryFinding": "har-priority-1"  // More specific evidence
  }
}
\`\`\`

## Guidelines

1. **Every metric node should have causes**: Don't leave metrics isolated
2. **Root causes have no incoming edges**: They're the fundamental issues
3. **Avoid circular dependencies**: A cannot cause B if B causes A
4. **Use duplicates relationship**: Same issue from multiple agents
5. **Compound relationships**: Multiple findings → one symptom
6. **Strength reflects confidence**: Be honest about uncertainty
7. **Connect Configuration → Waste → Performance** (Orphan Prevention):
   - Coverage findings about third-party scripts are SYMPTOMS, not root causes
   - Look for HTML findings about script loading attributes (async/defer, preconnect)
   - Create edge chain: html-third-party-loading → coverage-js-third-party → metric-tbt
   - Example: html-onetrust-blocking ("No async on otBannerSdk.js") → coverage-js-third-party-1 ("119KB otBannerSdk with unused code") → metric-tbt ("430ms TBT")
8. **Every finding needs edges** (Orphan Prevention):
   - If finding describes "large file" or "unused code" → it's a symptom → needs incoming edge from config/code finding
   - If finding describes "missing attribute" or "poor config" → it's a root cause → needs outgoing edge to waste/perf finding
   - Orphaned nodes indicate missing data or incomplete analysis

## Critical: Edge Direction Rules ⚠️

**Always create edges in this direction**: **Fundamental Cause → Observed Effect**

Common patterns to follow:

1. **Code patterns → Performance observations**
   - ✅ CORRECT: code-pattern-id → perf-observation-id
   - ❌ WRONG: perf-observation-id → code-pattern-id
   - Example: "Code review finds render-blocking script" → "Perf Observer sees 420ms delay"

2. **Configuration issues → Metric failures**
   - ✅ CORRECT: html-missing-preload → har-slow-fetch → metric-lcp
   - ❌ WRONG: metric-lcp → html-missing-preload

3. **Hypotheses (Code Agent) → Facts (Perf/HAR Agent)**
   - ✅ CORRECT: code-js-cloudflare-1 (hypothesis: "scripts likely block") → perf-inp-1 (fact: "1.5s long task observed")
   - ❌ WRONG: perf-inp-1 (observation) → code-js-cloudflare-1 (explanation)
   - **Rule**: When Code Agent hypothesizes about a pattern and Perf/HAR Agent observes the actual impact, the code pattern is the cause, the observation is the effect

4. **Root cause checking**:
   - If finding A describes "why" something happens → A is likely a cause
   - If finding B describes "what" happens → B is likely an effect
   - Example: "Missing dimensions" (why) → "Layout shift" (what)

**When in doubt**: Ask "Which happened first in the causal chain?" - that's the 'from' node.

## Your Task

Analyze all provided findings and build a comprehensive causal graph showing how issues relate and which are root causes vs symptoms.
`;
}
