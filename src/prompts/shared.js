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
      "title": "string - short, actionable title (required)",
      "description": "string - business-friendly description of the issue (required)",
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
      "validationCriteria": ["array of strings - how to verify the fix worked (optional)"]
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
        "solution": "string (why the proposed fix will work)"
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
- Identify longtask entries (duration, timing) that contribute to high TBT/INP, noting potential attribution if available
- Review resource timing entries for critical resources, comparing with HAR data for discrepancies or finer details
- Examine event and first-input entries (if available) for insights into input delay and event handling duration related to INP
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
- Pinpoint third-party resources causing delays with specific domains and timing
- Identify connection setup overhead (DNS, TCP, TLS) for key domains
- Examine resource priorities and their impact on loading sequence
- Detect TTFB issues that might indicate server-side performance problems
- Look for render-blocking resources that could be deferred or optimized
- Analyze resource sizes and compression efficiency
- Identify cache misses or short cache durations`,

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
