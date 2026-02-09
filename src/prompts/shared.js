import { EDSContext } from './contexts/eds.js';
import { AEMCSContext } from './contexts/aemcs.js';
import { AMSContext } from './contexts/ams.js';

/**
 * Returns CMS-specific technical context text
 * @param {String} cms
 * @return {String}
 */
export function getTechnicalContext(cms) {
  return (cms === 'eds' && EDSContext)
    || (cms === 'cs' && AEMCSContext)
    || (cms === 'ams' && AMSContext)
    || (cms === 'aem-headless' && 'The website uses AEM Headless as a backend system.')
    || 'The CMS serving the site does not seem to be any version of AEM.';
}

/**
 * Returns critical filtering criteria text
 * @return {String}
 */
export function getCriticalFilteringCriteria() {
  return `## Critical filtering criteria

Only provide recommendations if:
1. The metric is significantly failing Google's thresholds:
  - LCP > 2.5s by at least 300ms (i.e., LCP > 2.8s)
  - CLS > 0.1 by a meaningful margin (i.e., CLS > 0.15)
  - INP > 200ms by at least 50ms (i.e., INP > 250ms)
2. The expected improvement is substantial:
  - LCP improvements of at least 300ms
  - CLS improvements of at least 0.05
  - INP improvements of at least 100ms
3. The optimization addresses a clear, measurable bottleneck:
  - Resource blocking LCP for >500ms
  - Third-party scripts causing >100ms blocking time
  - Images causing >0.05 CLS
  - Long tasks >100ms affecting INP

Do not provide recommendations for:
- Metrics already meeting Google's "good" thresholds
- Micro-optimizations with <100ms expected impact
- Best practices that don't address actual performance issues
- Image optimizations saving <50KB or <200ms
- Speculative optimizations without clear evidence of impact`;
}

/**
 * Returns data priority guidance for agents
 * @param {string} agentType - Type of agent (psi, coverage, perf_observer, har, code, html, thirdparty)
 * @return {String}
 */
export function getDataPriorityGuidance(agentType) {
  const commonPriorities = `## CRITICAL: ANALYSIS PRIORITIES

**Your task is to identify HIGH IMPACT optimizations that meaningfully improve Core Web Vitals.**

**IMPORTANT - Avoid Overlap with Other Agents:**
Multiple agents analyze the same page from different angles. Focus on YOUR unique perspective:
- **PSI Agent**: Focus on audit-level findings (lighthouse audits, scores)
- **Coverage Agent**: Focus on file-level unused code with byte counts and line numbers
- **HAR Agent**: Focus on network-level issues (timing, connections, protocols)
- **Code Review Agent**: Focus on code patterns and implementation details
- **HTML Agent**: Focus on markup structure and resource hints
- **Performance Observer**: Focus on runtime behavior (CLS sources, long tasks, LCP candidates)

When you find an issue, provide SPECIFIC DETAILS that other agents can't:
- File names and line numbers (if you have code access)
- Exact byte savings (if you have coverage/size data)
- Network timing breakdown (if you have HAR data)
- Element selectors and shift values (if you have CLS attribution)
- Audit names and scores (if you're PSI agent)

**HIGH PRIORITY (Focus here first):**
- ✅ Render-blocking resources in <head> (directly blocks LCP)
- ✅ Unused JavaScript/CSS loaded BEFORE LCP element renders
- ✅ LCP image optimization (size, format, loading strategy, preload)
- ✅ Main thread blocking tasks >50ms during user interactions
- ✅ Layout shifts from images/ads/embeds ABOVE THE FOLD
- ✅ Critical path resources (fonts, hero images, first-screen content)

**MEDIUM PRIORITY (Analyze only if HIGH PRIORITY addressed):**
- ⚠️ Third-party scripts that don't directly impact CWV metrics
- ⚠️ Post-LCP image optimization (below the fold)
- ⚠️ Below-the-fold content optimization
- ⚠️ Non-blocking third-party resources

**LOW PRIORITY (Ignore unless explicitly relevant):**
- ❌ Post-LCP analytics scripts (Google Analytics, Adobe Analytics loaded after LCP)
- ❌ Social media embeds loaded after LCP
- ❌ Tiny asset optimizations (<5KB savings)
- ❌ Cache headers for non-critical resources
- ❌ Favicon or small icon optimizations

**CRITICAL RULES:**
1. Do NOT create suggestions for LOW PRIORITY items
2. Focus analysis effort on HIGH PRIORITY items first
3. Only suggest MEDIUM PRIORITY if no HIGH PRIORITY issues found
4. Every suggestion must pass the filtering criteria (>300ms LCP, >100ms INP, >0.05 CLS)`;

  const agentSpecificGuidance = {
    psi: `

**PSI-Specific Priorities:**
- Focus on audits with >500ms savings potential (render-blocking, unused-css, unused-javascript)
- Prioritize audits affecting LCP element specifically
- Ignore audits with <100ms savings unless they're part of a larger pattern`,

    coverage: `

**Coverage-Specific Priorities:**
- HIGHEST: Unused code loaded BEFORE LCP (delays critical rendering path)
- MEDIUM: Unused code loaded AFTER LCP (affects TTI, not LCP)
- If pre-LCP waste >100KB, focus EXCLUSIVELY on that
- Ignore post-LCP analytics/tracking scripts unless they're >200KB`,

    perf_observer: `

**Performance Observer Priorities:**
- HIGHEST: Layout shifts from elements ABOVE THE FOLD (visible to user)
- HIGHEST: Long tasks BEFORE LCP (directly delays rendering)
- MEDIUM: Long tasks AFTER LCP but before first interaction
- Ignore shifts from below-the-fold content unless CLS >0.25`,

    har: `

**HAR Analysis Priorities:**
- HIGHEST: Render-blocking requests in critical path (CSS, sync scripts in <head>)
- HIGHEST: Resources delaying LCP element (fonts, hero images)
- MEDIUM: Third-party requests with >500ms blocking time
- Ignore analytics beacons, tracking pixels, post-load requests`,

    code: `

**Code Review Priorities:**
- HIGHEST: JavaScript patterns affecting LCP (heavy initial render, blocking data fetches)
- HIGHEST: Event handlers causing >200ms INP (synchronous processing, heavy computations)
- MEDIUM: Code splitting opportunities for non-critical features
- Ignore code loaded after LCP unless it impacts INP`,

    html: `

**HTML Analysis Priorities:**
- HIGHEST: Missing preload/preconnect for LCP-critical resources
- HIGHEST: Images without dimensions above the fold (causes CLS)
- HIGHEST: Render-blocking scripts/styles in <head>
- Ignore meta tags, SEO tags, below-fold markup`,

    thirdparty: `

**Third-Party Priorities:**
- HIGHEST: Third-party scripts blocking LCP (>200ms in critical path)
- HIGHEST: Third-party causing main thread blocking >100ms
- MEDIUM: Long-tail scripts with cumulative impact >500ms
- Ignore analytics loaded after LCP unless they affect INP`
  };

  return commonPriorities + (agentSpecificGuidance[agentType] || '');
}

/**
 * Returns deliverable format instructions text
 * @return {String}
 */
export function getDeliverableFormat() {
  return `## Deliverable Format

**IMPORTANT**: You will generate ONLY structured JSON. The markdown report will be automatically formatted from your JSON output.

If any metric already meets Google's "good" thresholds, you may skip recommendations for that metric OR include low-priority maintenance suggestions.

### Output Schema (Structured JSON)

You must return a JSON object matching this exact schema:

\`\`\`json
{
  "deviceType": "string - mobile or desktop",
  "suggestions": [
    {
      "semanticType": "string - issue category: lcp-image | font-format | font-preload | image-sizing | unused-code | js-execution | layout-shift | blocking-resource | ttfb | third-party | etc. (optional)",
      "title": "string - short, actionable title (required)",
      "description": "string - business-friendly description of the issue (required)",
      "solution": "string - clear explanation of the recommended fix in plain language (required)",
      "metric": "string OR array - primary metric(s) affected: LCP, CLS, INP, TBT, TTFB, FCP (optional)",
      "priority": "High | Medium | Low (optional)",
      "effort": "Easy | Medium | Hard (optional)",
      "estimatedImpact": "string - expected improvement range (optional)",
      "confidence": "number - 0-1 confidence score (optional)",
      "evidence": ["array of strings - specific evidence supporting this recommendation (optional)"],
      "codeChanges": [
        {
          "file": "string - file path",
          "line": "number - line number (optional)",
          "before": "string - code before change (optional)",
          "after": "string - code after change (optional)"
        }
      ],
      "validationCriteria": ["array of strings - how to verify the fix worked (optional)"],
      "verification": {
        "tool": "lighthouse | chrome-devtools | web-vitals-library | crux | psi | manual",
        "method": "string - step-by-step instructions to verify fix (e.g., '1. Open Chrome DevTools\\n2. Go to Lighthouse tab\\n3. Run Mobile audit\\n4. Check LCP metric')",
        "expectedImprovement": "string - what user should see if fix is successful (e.g., 'LCP should decrease from 4.2s to ~3.0s')",
        "acceptanceCriteria": "string - optional threshold to consider fix successful (e.g., 'LCP ≤ 2.5s to pass CWV')"
      }
    }
  ]
}
\`\`\`

### Guidelines for Suggestions

1. **Prioritization**: Order suggestions by impact (high-impact, low-effort first)
2. **Combine Related Issues**: When multiple findings share a root cause, create ONE holistic suggestion
3. **Be Specific**: Include concrete file paths, line numbers, and code examples in codeChanges
4. **Evidence-Based**: Each suggestion should reference specific data from agent findings
5. **Actionable**: Focus on what to change, not just what's wrong
6. **Confidence Scoring**: Provide realistic confidence based on evidence quality
7. **Verification Instructions**: Include clear, step-by-step verification for each suggestion (see below)

### Verification Requirements (IMPORTANT)

For EVERY suggestion, include a "verification" object to help customers validate fixes immediately:

**Required fields:**
- **tool**: Which tool to use (lighthouse, chrome-devtools, web-vitals-library, crux, psi, or manual)
- **method**: Step-by-step instructions (use \\n for line breaks)
- **expectedImprovement**: Specific numbers showing before/after state

**Optional field:**
- **acceptanceCriteria**: Threshold to consider fix successful (e.g., "LCP ≤ 2.5s")

**Tool Selection Guide:**
- **lighthouse**: For comprehensive CWV metrics (LCP, CLS, INP) - recommended for most cases
- **chrome-devtools**: For detailed performance profiling (long tasks, layout shifts)
- **web-vitals-library**: For programmatic metric collection in production
- **crux**: For real-world field data (28-day P75 metrics)
- **psi**: For combined lab + field data from PageSpeed Insights
- **manual**: For visual inspection or accessibility checks

**Example verification objects:**

\`\`\`json
{
  "verification": {
    "tool": "lighthouse",
    "method": "1. Open Chrome DevTools (F12)\\n2. Navigate to Lighthouse tab\\n3. Select 'Mobile' device\\n4. Click 'Analyze page load'\\n5. Check LCP metric in report",
    "expectedImprovement": "LCP should decrease from 4.2s to approximately 3.0s (1.2s improvement)",
    "acceptanceCriteria": "LCP ≤ 2.5s to pass Core Web Vitals threshold"
  }
}
\`\`\`

\`\`\`json
{
  "verification": {
    "tool": "chrome-devtools",
    "method": "1. Open Performance tab in DevTools\\n2. Click record button\\n3. Reload page\\n4. Stop recording after 5 seconds\\n5. Check 'Long Tasks' in timeline for tasks >50ms",
    "expectedImprovement": "Long task count should decrease from 8 tasks to 2-3 tasks",
    "acceptanceCriteria": "No long tasks exceeding 200ms"
  }
}
\`\`\`

\`\`\`json
{
  "verification": {
    "tool": "manual",
    "method": "1. Clear browser cache\\n2. Open DevTools Network tab\\n3. Reload page\\n4. Visually observe when largest content appears\\n5. Check Network waterfall for image load timing",
    "expectedImprovement": "Hero image should appear 800ms earlier in visual timeline"
  }
}
\`\`\`

### Critical: Third-Party Resource Hint Rules

**NEVER recommend preconnect for these categories - they should be deferred/async instead:**

| Category | Domains | Correct Action |
|----------|---------|----------------|
| Cookie Consent | cookielaw.org, onetrust.com, cookiebot.com | Defer to post-LCP |
| Analytics | google-analytics.com, analytics.*, omtrdc.net | Load async |
| Tag Managers | googletagmanager.com, assets.adobedtm.com | Load async (see exception) |
| Monitoring | hotjar.com, fullstory.com, newrelic.com | Load async |
| Social | facebook.net, twitter.com, linkedin.com | Load async |

**Exception for Tag Managers**: Adobe Launch (adobedtm) MAY need early loading ONLY if:
- Adobe Target is loaded AND
- There's above-fold personalization that would cause flicker
- Detection: Look for at.js, mbox calls, or Target library
- If no Target detected → recommend async loading, NOT preconnect

**Valid preconnect targets (affects LCP):**
- CDN hosting hero/LCP image
- Critical font CDN (if above-fold text renders with custom font)
- First-party API that blocks initial render

### Critical: CSS Loading Anti-Patterns (NEVER RECOMMEND)

**NEVER suggest these hacky CSS async patterns - they are problematic:**

| Anti-Pattern | Why It's Bad |
|--------------|--------------|
| media="print" hack with onload | Violates HTML spec, accessibility issues, inconsistent behavior |
| preload as="style" with onload hack | Misuses preload semantics, accessibility problems, harder to debug |
| noscript fallback with above hacks | Adds complexity without solving the real problem |

**Examples of BAD patterns to NEVER recommend:**
- <link rel="stylesheet" media="print" onload="this.media='all'">
- <link rel="preload" as="style" onload="this.rel='stylesheet'">

**RECOMMENDED approach for async CSS (JavaScript-based):**
\`\`\`javascript
// Load non-critical CSS after page load
if ('requestIdleCallback' in window) {
  requestIdleCallback(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/path/to/non-critical.css';
    document.head.appendChild(link);
  });
} else {
  setTimeout(() => { /* same approach */ }, 1);
}
\`\`\`

**BEST approach: Split CSS into critical and non-critical:**
- Load critical CSS synchronously (above-fold styles only)
- Load non-critical CSS with JavaScript after page load or during idle time
- Use requestIdleCallback for deferred loading

### Solution Field Requirements

Each suggestion MUST include a **solution** field that:
1. Explains the fix in plain, non-technical language
2. Describes WHAT to do, not just what's wrong
3. Is actionable and specific
4. Does NOT just repeat the code changes in words

**Example of GOOD solution:**
- "Split the CSS bundle into two parts: critical styles needed for above-the-fold content (load immediately) and non-critical styles (load after page renders). Use JavaScript with requestIdleCallback to load the non-critical CSS asynchronously."

**Example of BAD solution:**
- "Fix the CSS loading issue" (too vague)
- "Add async loading" (doesn't explain how)
- "Change the link tag" (just describes code change)

### Code Change Requirements

For each suggestion with code changes:
- **file**: Full path to the file that needs modification
- **line**: Specific line number (if applicable)
- **before**: Current code (for context)
- **after**: Proposed code change

**Examples**:

AEM Image Optimization:
\`\`\`json
{
  "file": "/apps/myproject/components/content/hero/hero.html",
  "line": 12,
  "before": "<img src=\\"\${image.src}\\" alt=\\"\${image.alt}\\">",
  "after": "<img src=\\"\${image.src}\\" alt=\\"\${image.alt}\\" loading=\\"eager\\" fetchpriority=\\"high\\" width=\\"\${image.width}\\" height=\\"\${image.height}\\">"
}
\`\`\`

Font Loading:
\`\`\`json
{
  "file": "/apps/myproject/clientlibs/clientlib-base/css/fonts.css",
  "after": "@font-face {\\n  font-family: 'CustomFont';\\n  src: url('/fonts/custom.woff2') format('woff2');\\n  font-display: swap;\\n  font-weight: 400;\\n}"
}
\`\`\`

### Validation Criteria

Include validation criteria so developers can verify the fix:
- "Bundle size reduces by ~165KB"
- "TBT improves by at least 300ms"
- "Coverage shows <10% unused code in main bundle"
- "LCP element loads within first 2 requests"

**Note**: Your JSON output will be automatically formatted into a human-readable markdown report. Focus on generating complete, accurate, structured data.
`;
}

/**
 * Returns structured output format instructions for agent findings (Phase 1)
 * @param {string} agentName - Name of the agent
 * @return {string} Structured output format instructions
 */
export function getStructuredOutputFormat(agentName) {
  return `
## Output Format (Phase 1 - Structured Findings)

You must output your findings as a JSON object with the following schema:

\`\`\`json
{
  "agentName": "${agentName}",
  "findings": [
    {
      "id": "string (unique ID, e.g., 'psi-lcp-1', 'har-ttfb-1')",
      "type": "bottleneck | waste | opportunity",
      "metric": "LCP | CLS | INP | TBT | TTFB | FCP | TTI | SI",
      "description": "string (human-readable finding, min 10 chars)",

      "evidence": {
        "source": "string (data source: psi, har, coverage, crux, rum, code, html, rules, perfEntries)",
        "reference": "string (specific data point: audit name, file:line, timing breakdown, etc.)",
        "confidence": number (0-1, your confidence in this finding)
      },

      "estimatedImpact": {
        "metric": "string (which metric improves)",
        "reduction": number (estimated improvement: ms, score, bytes, etc.)",
        "confidence": number (0-1, confidence in estimate)",
        "calculation": "string (optional: show your work)"
      },

      "reasoning": {
        "observation": "string (what you observed in the data)",
        "diagnosis": "string (why this is causing the problem)",
        "mechanism": "string (how it impacts the metric)",
        "solution": "string (why the proposed fix will work)",
        "codeExample": "string (OPTIONAL: AEM-specific code example with file path, using \`\`\`lang\\ncode\`\`\` format)"
      },

      "relatedFindings": ["array of related finding IDs (optional)"],
      "rootCause": boolean (true = root cause, false = symptom)
    }
  ],
  "metadata": {
    "executionTime": number (ms),
    "dataSourcesUsed": ["array of data sources examined"],
    "coverageComplete": boolean (did you examine all relevant data?)
  }
}
\`\`\`

### Finding Type Classification

- **bottleneck**: Resources/code blocking critical metrics (render-blocking scripts, slow TTFB, etc.)
- **waste**: Unnecessary resources that don't contribute to UX (unused code, oversized images, etc.)
- **opportunity**: Optimization chances that aren't currently blocking but could improve metrics (missing preload, better caching, etc.)

### Evidence Requirements

- **source**: Must match your data source (e.g., "psi", "har", "coverage")
- **reference**: Be specific - include audit names, file paths with line numbers, timing breakdowns, etc.
- **confidence**:
  - 0.9-1.0: Direct measurement, highly reliable data
  - 0.7-0.8: Strong correlation, reliable audit
  - 0.5-0.6: Reasonable inference, some uncertainty
  - <0.5: Speculative, uncertain

### Impact Estimation

- Provide quantified estimates (not just "improves performance")
- Show your calculation if non-obvious
- Be conservative - under-promise, over-deliver
- Consider cascading effects (e.g., FCP → LCP)

### Root Cause vs Symptom

- **Root cause (true)**: Fundamental issue causing the problem (e.g., "full library imports instead of tree-shaking")
- **Symptom (false)**: Observable effect of underlying issue (e.g., "LCP is slow at 4.2s")

### Chain-of-Thought Reasoning (Phase 2)

The **reasoning** field captures your analytical process using a structured 4-step chain:

1. **observation**: What specific data point did you observe?
   - Example: "Hero image (hero.jpg, 850KB) loaded with priority: Low in HAR"

2. **diagnosis**: Why is this observation problematic?
   - Example: "Low priority prevents browser from prioritizing this LCP resource, causing delayed fetch"

3. **mechanism**: How does this problem affect the metric?
   - Example: "Image fetch delayed by ~800ms, directly delaying LCP paint event"

4. **solution**: Why will your proposed fix address the root cause?
   - Example: "Adding fetchpriority='high' signals browser to prioritize image, eliminating the 800ms delay"

**Guidelines**:
- Be specific with data references (file names, sizes, timings)
- Connect observation → diagnosis → mechanism → solution
- Use byte sizes from coverage (not just percentages)
- Reference per-domain timings from HAR
- Cite font-display values from font strategy

### Code Example Guidelines (Optional in Findings)

Agents MAY include a code example in \`reasoning.codeExample\` if the fix is implementation-specific:

**Format**:
\`\`\`lang
File: /absolute/path/to/file.ext

code here
\`\`\`

**When to include**:
- Clear, actionable implementation (e.g., "add fetchpriority='high' to hero image")
- AEM-specific patterns (clientlib, HTL, dispatcher config)
- Simple fixes that don't require multi-file changes

**When to skip**:
- Complex architectural changes (defer to final synthesis)
- Multi-step implementations
- Requires extensive explanation

**Example**:
\`\`\`json
"reasoning": {
  "solution": "Adding fetchpriority='high' to the hero image will signal the browser to prioritize it",
  "codeExample": "File: /apps/myproject/components/content/hero/hero.html\\n\\n<img src=\\"\\$\{image.src\}\\"\\n     fetchpriority=\\"high\\"\\n     loading=\\"eager\\" />"
}
\`\`\`

### Example Finding (Phase 2 with Reasoning)

\`\`\`json
{
  "id": "psi-lcp-1",
  "type": "bottleneck",
  "metric": "LCP",
  "description": "Three render-blocking scripts delay LCP by 850ms",
  "evidence": {
    "source": "psi.audits.render-blocking-resources",
    "reference": "app.js (420ms), analytics.js (280ms), vendor.js (150ms)",
    "confidence": 0.85
  },
  "estimatedImpact": {
    "metric": "LCP",
    "reduction": 650,
    "confidence": 0.75,
    "calculation": "850ms blocking → ~600-700ms LCP improvement (not 1:1 due to cascading)"
  },
  "reasoning": {
    "observation": "PSI reports 3 render-blocking scripts: app.js (420ms), analytics.js (280ms), vendor.js (150ms), total 850ms",
    "diagnosis": "Scripts without async/defer block HTML parsing until they execute, preventing LCP element from rendering",
    "mechanism": "Render blocking delays FCP by 850ms, which cascades to delay LCP by ~600-700ms (not 1:1 due to parallel resource loading)",
    "solution": "Adding async/defer attributes allows parsing to continue, eliminating blocking time and improving LCP"
  },
  "relatedFindings": ["coverage-unused-1"],
  "rootCause": true
}
\`\`\`

**IMPORTANT**: Output ONLY valid JSON. Do not include any text before or after the JSON object.
`;
}

// Centralized per-phase bullet lists (no headings), used by both
// initializeSystem (single-shot) and agent prompts (multi-agent)
export const PHASE_FOCUS = {
  CRUX: (n) => `### Step ${n}: CrUX Data Analysis
- Analyze Chrome User Experience Report (CrUX) field data for the URL
- Evaluate historical Core Web Vitals trends from real users
- Identify distribution patterns for LCP, CLS, and INP metrics
- Compare performance across device types (mobile vs. desktop)
- Determine if there are specific user segments experiencing poor performance
- Identify pages with similar templates that perform better
- Set realistic improvement targets based on field data percentiles
- Note regional variations in performance if present

**Evidence Requirements for Field Data**:
- CrUX evidence references must include BOTH metric name AND value with percentile
- ✅ GOOD: "CLS p75: 1.81 (poor, 18x threshold)" or "LCP p75: 3500ms, FCP p75: 1800ms"
- ❌ BAD: "CLS: 1.81" (too short, missing context)
- Include distribution data when relevant: "75% of users experience CLS > 0.25"
- Reference histogram bins for severity context: "good: 15%, needs-improvement: 20%, poor: 65%"`,

  RUM: (n) => `### Step ${n}: Real User Monitoring (RUM) Analysis
- Analyze recent RUM data (last 7 days) for the specific page being analyzed
- Compare RUM metrics to CrUX aggregate data to identify page-specific issues
- Identify temporal trends: Is performance improving or degrading over the 7-day period?
- Analyze device/connection breakdown if available (mobile vs desktop, connection types)
- Look for outliers: Are there specific user sessions with extremely poor metrics?
- Identify interaction patterns: Which elements trigger poor INP?
- Correlate LCP targets with actual LCP elements observed in RUM

**Key Differences from CrUX**:
- RUM is page-specific, CrUX is origin-level or URL-level aggregate
- RUM is recent (7 days), CrUX is 28-day rolling average
- RUM may have more granular attribution data (targets, interaction types)
- Use RUM to validate or contradict CrUX findings

**Evidence Requirements for RUM Data**:
- RUM evidence must include metric name, value, sample size, and time context
- ✅ GOOD: "RUM INP p75: 450ms (n=1,234 samples over 7 days), worst: 1200ms on /checkout"
- ✅ GOOD: "RUM LCP trending worse: 2.1s → 2.8s over past week"
- ❌ BAD: "INP is slow" (no specifics)
- Include comparison to CrUX when relevant: "RUM INP (450ms) worse than CrUX (380ms) - recent regression?"
- Reference specific pages/URLs if performance varies across the site`,

  PSI: (n) => `### Step ${n}: PageSpeed Assessment
- Evaluate PSI/Lighthouse mobile results
- Identify key bottlenecks for each metric
- Establish baseline performance measurements
- Record current values for LCP, CLS, and INP
- Note any immediate red flags in the results`,

  PERF_OBSERVER: (n) => `### Step ${n}: Performance Observer Analysis
- Analyze performance entries captured during page load simulation
- Examine largest-contentful-paint entries to identify LCP candidates, their timings, elements, and potential delays
- **PRIORITY 2: Use CSS-to-CLS Attribution for layout shift analysis**
  * Check the "CLS by Type" breakdown (font-swap, unsized-media, content-insertion, animation)
  * Use the "Top CLS Issues (with CSS Attribution)" section for specific findings
  * Cite the exact CSS property causing each shift (e.g., "font-family: Proximanova")
  * Reference the stylesheet location (e.g., "/styles/fonts.css")
  * Include the element selector affected (e.g., "body > h1")
  * Use the shift type to inform recommendations (e.g., "font-swap → use font-display: optional or size-adjust")
  * Example: "Element 'body > h1' has 0.15 CLS due to font-family: Proximanova in /styles/fonts.css (font-swap type)" not just "layout shift detected"
- Analyze layout-shift entries to pinpoint the exact timing, score, and source elements contributing to CLS
- **PRIORITY 3: Analyze INP (Interaction to Next Paint) using EventTiming entries (Issue #2 fix)**
  * Examine 'event' entries (EventTiming API) for interaction latency breakdown:
    - duration: Total interaction latency (input delay + processing time + presentation delay)
    - processingStart - startTime: Input delay (time from user interaction to event handler start)
    - processingEnd - processingStart: Processing time (event handler execution duration)
    - duration - (processingEnd - startTime): Presentation delay (rendering after handler)
  * Identify interactions with duration >200ms (poor INP threshold):
    - Example: "Click on button.submit-form took 340ms (input delay: 20ms, processing: 280ms, presentation: 40ms)"
  * Note the target element (button, link, input, etc.) and its selector for recommendations
  * If no 'event' entries, check 'first-input' entries for FID (First Input Delay) as fallback
  * Correlate high event durations with longtask entries to identify blocking JavaScript
  * Recommend specific optimizations: break up long tasks, use requestIdleCallback, debounce handlers
- Identify longtask entries (duration, timing) that contribute to high TBT/INP, noting potential attribution if available
- Review resource timing entries for critical resources, comparing with HAR data for discrepancies or finer details
- Correlate paint timings (first-paint, first-contentful-paint) with resource loading and rendering events`,

  HAR: (n) => `### Step ${n}: HAR File Analysis
- Examine network waterfall for resource loading sequence and timing
- Identify critical path resources that block rendering
- Analyze request/response headers for optimization opportunities
- **PRIORITY 1: Use Third-Party Script Analysis for detailed attribution**
  * Cite specific third-party categories (analytics, advertising, social, etc.) from the "Third-Party Script Analysis" section
  * Reference execution times and network times per category
  * Identify render-blocking third-party scripts by name and domain
  * Use the "Top Scripts by Execution Time" list for specific recommendations
  * Reference long task attribution to specific third-party scripts
  * Example: "analytics category: 3 scripts, 450ms execution (Google Analytics: 280ms)" not just "third-party scripts are slow"
- **PRIORITY 2: Use Server-Timing Headers for TTFB Diagnosis (Issue #3 fix)**
  * Check the "Server-Timing Breakdown" section in the HAR summary
  * Identify which tier is the bottleneck: CDN, cache, dispatcher, origin
  * Look for cache hit/miss indicators (HIT, MISS, REVALIDATE, STALE, EXPIRED)
  * Analyze origin time vs edge time to determine root cause:
    - High origin time (>200ms) → Slow Sling Models, DB queries, or backend processing
    - High CDN time but low origin → Network latency or CDN routing issues
    - Cache MISS → Fix cache headers, increase TTL, check invalidation rules
  * Example: "Server-Timing shows origin=1200ms vs CDN=5ms - optimize publish tier, not CDN" not just "high TTFB"
  * Correlate Server-Timing with TTFB from timing breakdown to validate findings
- Pinpoint third-party resources causing delays with specific domains and timing
- Identify connection setup overhead (DNS, TCP, TLS) for key domains
- Examine resource priorities and their impact on loading sequence
- Detect TTFB issues that might indicate server-side performance problems
- Look for render-blocking resources that could be deferred or optimized
- Analyze resource sizes and compression efficiency
- Identify cache misses or short cache durations
- **Use third-party categorization** from the Third-Party Script Analysis:
  * Analytics (google-analytics, segment, omniture, mixpanel, amplitude) → NEVER preconnect, always async
  * Advertising (doubleclick, adsense) → NEVER preconnect, defer below fold
  * Consent (onetrust, cookiebot, termly, iubenda) → NEVER preconnect, always defer to post-LCP
  * Tag managers (googletagmanager, tealium, adobedtm) → async unless Target personalization
  * CDN (cloudfront, fastly, akamai) → preconnect ONLY if hosts LCP resource
  * Testing/Personalization (optimizely, vwo, at.js, target, googleoptimize) → preconnect ONLY if above-fold A/B test
  * Support (zendesk, intercom, drift) → NEVER preconnect, defer
  * Monitoring (newrelic, datadog, sentry, rollbar) → NEVER preconnect, async
  * Session Replay (clarity.microsoft, contentsquare) → NEVER preconnect, defer to post-interaction (Issue #4 fix)
  * Feature Flags (launchdarkly, statsig) → preconnect ONLY if controls above-fold, consider SSR (Issue #4 fix)
  * Marketing (hubspot, marketo, klaviyo) → NEVER preconnect, defer (Issue #4 fix)
  * Forms (typeform, jotform) → preconnect ONLY if form above-fold (Issue #4 fix)
  * Video (wistia, vidyard, brightcove) → preconnect ONLY if video is LCP element (Issue #4 fix)
- Reference the \`getCategoryRecommendation()\` function output for each category
- Example: "session-replay category (clarity.microsoft.com): NEVER preconnect, action: defer, reason: 200-500ms overhead"
- **PRIORITY 3: Analyze JS Request Chains for Sequential Loading Patterns**
  * Look for the "JS Request Chains" section in the HAR summary — it shows sequential script loading chains
  * Sequential chains create waterfall delays: each script must be downloaded AND executed before triggering the next level's imports
  * Common pattern in bundled sites: main.js imports translations.js which imports adobe.js which loads alloy.js
  * Each level in the chain adds the script's download time + execution time before the next level can start
  * For chains with depth >= 3 and total delay > 500ms, recommend preloading the chain scripts
  * Recommendation: Add \`<link rel="preload" as="script">\` in the HTML \`<head>\` (or via HTTP Link headers) for the scripts in the chain. This allows the browser to download ALL scripts in parallel while still executing them in dependency order
  * This is different from removing scripts — the scripts still need to run, they just don't need to be discovered sequentially
  * Example finding: "3-level JS chain (main.js → translations.js → adobe.js) adds 3.3s sequential delay. Preloading translations.js and adobe.js would allow parallel download, saving ~2s of network waterfall time"
  * Only recommend preloading for core framework/library scripts — not for individual page-specific blocks or components`,

  HTML: (n) => `### Step ${n}: Markup Analysis
- Examine provided HTML for the page
- Identify the LCP element and verify its loading attributes
- Review resource hints (preload, preconnect, prefetch) implementation
- Analyze critical CSS strategy and render-blocking resources
- Evaluate HTML structure and its impact on rendering sequence
- Examine script loading strategies (async, defer, modules)
- Check for proper image attributes (width, height, loading, fetchpriority)

**CRITICAL: Third-Party Script Analysis** (for Causal Graph Completeness)
- Coverage agent will find large third-party scripts as SYMPTOMS
- You MUST create ROOT CAUSE findings about HOW they're loaded to connect the graph
- Required checks:
  1. **Loading Strategy**: Are third-party scripts async/defer or render-blocking?
     - ✅ GOOD: \`<script async src="https://cdn.cookielaw.org/otBannerSdk.js">\`
     - ❌ BAD: \`<script src="https://cdn.cookielaw.org/otBannerSdk.js">\` (blocks rendering)
  2. **Preconnect Optimization**: Large third-party domains (>50KB) should have preconnect hints
     - ✅ GOOD: \`<link rel="preconnect" href="https://cdn.cookielaw.org">\`
     - ❌ BAD: No preconnect for 100KB+ third-party scripts
  3. **Load Timing**: Are consent/analytics scripts in <head> (early) or before </body> (late)?
     - ⚠️ Note: Consent scripts may need early load for legal compliance
     - ❌ BAD: Non-essential analytics in <head> blocking render
- Evidence requirements:
  - Reference specific script URLs with async/defer/type attributes
  - Note position in document (<head> vs <body>)
  - Include category (consent, analytics, tag-manager, social, monitoring)
  - Example: "OneTrust consent script (otBannerSdk.js) in <head> without async/defer, category: consent"`,

  RULES: (n) => `### Step ${n}: Rule Violation Analysis
- Review the provided summary of failed, manually evaluated rules
- Correlate specific rule violations with findings from previous phases (PSI, PerfObserver, HAR, Markup)
- Use these violations as targeted pointers for deeper investigation, particularly in the Code Review phase
- Prioritize AEM configuration-level solutions over direct code changes, if applicable
- Note any AEM-specific rule failures that might point to configuration-level, component-level or platform-level optimizations
- Assess the potential impact of each reported violation on CWV metrics`,

  COVERAGE: (n) => `### Step ${n}: Code Coverage Analysis
- Analyze JavaScript and CSS coverage data from page load simulation
- Identify unused code portions that can be safely removed or deferred
- Correlate unused code with resource loading performance impact
- Identify code that's loaded but only used for specific user interactions
- Determine opportunities for code splitting and lazy loading strategies
- Assess the potential savings from removing dead code entirely
- Prioritize deferral/removal candidates based on:
  * Size of unused portions (target >20KB savings)
  * Impact on critical rendering path
  * Execution timing relative to user interactions
  * Dependencies and bundling considerations
- Map unused code to specific functions, components, or libraries
- Evaluate trade-offs between code removal complexity and performance gains
- Identify patterns where entire third-party libraries are loaded but minimally used`,

  CODE_REVIEW: (n) => `### Step ${n}: Code Review
- Analyze provided JS/CSS for optimization opportunities, informed by coverage analysis in Phase 7
- Evaluate rendering sequence and execution patterns in scripts.js
- Identify load phase assignments (eager, lazy, delayed) for resources
- Examine JS patterns that might cause long tasks
- Review CSS for render-blocking issues and optimization opportunities
- Identify inefficient code patterns and suggest specific improvements
- Analyze event listener implementations for INP impact

**Evidence Requirements for Code Review**:
- Code evidence must reference specific files with context (>10 chars)
- ✅ GOOD: "Files: main.js and /d251aa49a8a3/main.js from cdn-cgi/challenge-platform" or "clientlib-site.js:L45 uses blocking fetch()"
- ❌ BAD: "main.js" (too short, no context)
- Include line numbers when possible for specific patterns
- Reference multiple related files together for pattern-based findings
- When hypothesizing about performance impact, note that you're predicting (use "likely", "may", "could") since Code Agent doesn't see actual execution data`,
};
