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

If any metric already meets Google's "good" thresholds, explicitly state this and skip all recommendations for that metric.

Present your findings as:

### 1. MARKDOWN REPORT (for human review):
1. Executive summary with the url that was tested, key metrics and impact estimates
2. Prioritized recommendations table (only for metrics that fail thresholds) with:
  - Impact rating (High/Medium/Low)
  - Implementation complexity (Easy/Medium/Hard)
  - Affected metric(s)
  - Expected improvement range
3. Detailed technical recommendations (only for failing metrics), organized by metric, with:
  - a short title
  - a description for the issue targeted towards business users
  - implementation priority (High/Medium/Low)
  - implementation effort (Easy/Medium/Hard)
  - expected impact on metrics
  - order the suggestions from High impact / Low effort to Low impact / High effort
4. Implementation roadmap highlighting quick wins vs. strategic improvements

Only provide actionable recommendations that will meaningfully improve user experience and Core Web Vitals scores.

### 2. STRUCTURED JSON (for automation) - MANDATORY
Immediately after the markdown report, include this exact section and schema:

---

## STRUCTURED DATA FOR AUTOMATION

\`\`\`json
{
  "url": "string - tested URL",
  "deviceType": "string - mobile or desktop",
  "timestamp": "string - ISO timestamp of analysis",
  "summary": {
    "lcp": { "current": "string", "target": "2.5s", "status": "good|needs-improvement|poor" },
    "cls": { "current": "string", "target": "0.1", "status": "good|needs-improvement|poor" },
    "inp": { "current": "string", "target": "200ms", "status": "good|needs-improvement|poor" }
  },
  "suggestions": [
    {
      "id": "number - sequential ID starting from 1",
      "title": "string - short, actionable title",
      "description": "string - business-friendly description of the issue",
      "metric": "string - primary metric affected (LCP, CLS, INP)",
      "priority": "string - High, Medium, or Low",
      "effort": "string - Easy, Medium, or Hard",
      "impact": "string - expected improvement range",
      "implementation": "string - technical implementation details",
      "codeExample": "string - REQUIRED concrete code example (see requirements below)",
      "category": "string - performance category (images, css, javascript, fonts, third-party, etc.)"
    }
  ]
}
\`\`\`

Instructions for JSON extraction:
- Extract individual recommendations from the detailed section
- Each item becomes one suggestion object
- Put technical details and code examples in the appropriate fields
- Ensure the JSON is valid and properly escaped
- Include all actionable recommendations

**CRITICAL: Code Example Requirements**
EVERY suggestion MUST include a concrete, copy-paste code example in the "codeExample" field:
- For AEM: Include HTL template paths, clientlib categories, or Dispatcher config
- For image optimizations: Show actual HTML attribute changes (loading, fetchpriority)
- For font loading: Show @font-face declarations with font-display and size-adjust
- For JavaScript: Show actual code snippets with file paths
- For CSS: Show actual selectors and properties
- AVOID: Generic "use X technique" without actual code
- EXAMPLE FORMAT: "File: /apps/myproject/components/hero/hero.html\\n<img src=\\"\${image.src}\\" loading=\\"eager\\" fetchpriority=\\"high\\" />"
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
- Note regional variations in performance if present`,

  PSI: (n) => `### Step ${n}: PageSpeed Assessment
- Evaluate PSI/Lighthouse mobile results
- Identify key bottlenecks for each metric
- Establish baseline performance measurements
- Record current values for LCP, CLS, and INP
- Note any immediate red flags in the results`,

  PERF_OBSERVER: (n) => `### Step ${n}: Performance Observer Analysis
- Analyze performance entries captured during page load simulation
- Examine largest-contentful-paint entries to identify LCP candidates, their timings, elements, and potential delays
- Analyze layout-shift entries to pinpoint the exact timing, score, and source elements contributing to CLS
- Identify longtask entries (duration, timing) that contribute to high TBT/INP, noting potential attribution if available
- Review resource timing entries for critical resources, comparing with HAR data for discrepancies or finer details
- Examine event and first-input entries (if available) for insights into input delay and event handling duration related to INP
- Correlate paint timings (first-paint, first-contentful-paint) with resource loading and rendering events`,

  HAR: (n) => `### Step ${n}: HAR File Analysis
- Examine network waterfall for resource loading sequence and timing
- Identify critical path resources that block rendering
- Analyze request/response headers for optimization opportunities
- Pinpoint third-party resources causing delays
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
- Check for proper image attributes (width, height, loading, fetchpriority)`,

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
- Analyze event listener implementations for INP impact`,
};
