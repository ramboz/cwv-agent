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

## Your Analysis Focus
${PHASE_FOCUS.CRUX(step())}

${getChainOfThoughtGuidance()}

${getStructuredOutputFormat('CrUX Agent')}
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

## Your Analysis Focus
${PHASE_FOCUS.PERF_OBSERVER(step())}

${getChainOfThoughtGuidance()}

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

## Your Analysis Focus
${PHASE_FOCUS.HTML(step())}

${getChainOfThoughtGuidance()}

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

## Your Task

Analyze all provided findings and build a comprehensive causal graph showing how issues relate and which are root causes vs symptoms.
`;
}
