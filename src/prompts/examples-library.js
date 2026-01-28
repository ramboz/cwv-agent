/**
 * Examples library for few-shot learning
 * Organized by agent type and metric
 */

export const examplesLibrary = {
  // PSI Agent Examples
  psi: [
    {
      title: 'LCP Issue with Render Blocking',
      metric: 'LCP',
      cms: 'all',
      hasRichData: false,
      input: 'LCP = 4.2s, render-blocking-resources audit shows 3 scripts (850ms savings)',
      goodOutput: JSON.stringify({
        findings: [
          {
            id: 'psi-lcp-1',
            type: 'bottleneck',
            metric: 'LCP',
            description: 'Three render-blocking scripts delay LCP by 850ms',
            reasoning: {
              observation: 'PSI render-blocking-resources audit identifies 3 scripts: app.js (420ms), analytics.js (280ms), vendor.js (150ms)',
              diagnosis: 'These scripts block HTML parsing, preventing browser from constructing DOM and starting LCP element loading',
              mechanism: 'Blocking delays FCP by 850ms, which cascades to LCP. Hero image cannot start loading until scripts execute.',
              solution: 'Defer non-critical scripts (analytics, vendor), load app.js asynchronously, or split into critical/non-critical chunks',
            },
            evidence: {
              source: 'psi.audits.render-blocking-resources',
              reference: '3 blocking scripts totaling 850ms: app.js (420ms), analytics.js (280ms), vendor.js (150ms)',
              confidence: 0.85,
            },
            estimatedImpact: {
              metric: 'LCP',
              reduction: 650,
              confidence: 0.75,
            },
            rootCause: true,
          },
        ],
      }, null, 2),
      reasoning: 'Concrete evidence from PSI audit, clear causal chain (blocking → FCP → LCP), realistic impact estimate (not 1:1 due to other factors)',
      badOutput: JSON.stringify({
        findings: [
          {
            description: 'Scripts are blocking',
            estimatedImpact: { reduction: 2000 },
          },
        ],
      }, null, 2),
      badReasoning: 'Vague description, no reasoning, unrealistic impact (exceeds observed LCP), missing evidence source',
    },

    {
      title: 'No Issues Found',
      metric: 'all',
      cms: 'all',
      hasRichData: false,
      input: 'All metrics passing, no failing audits',
      goodOutput: JSON.stringify({
        findings: [],
      }, null, 2),
      reasoning: "Don't invent problems when none exist. Empty findings array is valid.",
    },

    {
      title: 'Unused JavaScript Detection',
      metric: 'TBT',
      cms: 'all',
      hasRichData: true,
      input: 'TBT = 850ms, unused-javascript audit shows 420KB unused, coverage data shows 65% of app.bundle.js unused',
      goodOutput: JSON.stringify({
        findings: [
          {
            id: 'psi-tbt-1',
            type: 'waste',
            metric: 'TBT',
            description: 'TBT exceeds threshold by 600ms due to 420KB unused JavaScript',
            reasoning: {
              observation: 'PSI unused-javascript audit: 420KB unused. Coverage confirms 65% of app.bundle.js (645KB total) is unused code.',
              diagnosis: 'Unused JavaScript is still parsed, compiled, and kept in memory, blocking main thread unnecessarily',
              mechanism: '420KB unused code adds ~400ms parse/compile time (1ms per KB heuristic), directly contributing to 850ms TBT',
              solution: 'Tree-shake unused imports, code-split by route, lazy-load non-critical features',
            },
            evidence: {
              source: 'psi.audits.unused-javascript',
              reference: '420KB unused across 3 bundles. app.bundle.js: 420KB unused (65% of 645KB total)',
              confidence: 0.9,
            },
            estimatedImpact: {
              metric: 'TBT',
              reduction: 400,
              confidence: 0.8,
            },
            rootCause: true,
          },
        ],
      }, null, 2),
      reasoning: 'Uses both PSI audit AND coverage data for higher confidence. Explains mechanism (parse/compile overhead). Realistic impact based on 1ms/KB heuristic.',
    },
  ],

  // Coverage Agent Examples
  coverage: [
    {
      title: 'Full Library Imports',
      metric: 'TBT',
      cms: 'all',
      hasRichData: true,
      input: 'Coverage shows Lodash: 98KB (12% used), Moment.js: 67KB (8% used)',
      goodOutput: JSON.stringify({
        findings: [
          {
            id: 'coverage-unused-1',
            type: 'waste',
            metric: 'TBT',
            description: '165KB unused code from full library imports (Lodash, Moment.js)',
            reasoning: {
              observation: 'Coverage data: Lodash 98KB total, 12% used (12KB). Moment.js 67KB total, 8% used (5KB). Total waste: 86KB + 62KB = 148KB.',
              diagnosis: 'Full library imports bring entire library even when only small portions are used. Dead code elimination cannot remove unused functions due to side effects.',
              mechanism: 'Browser must parse, compile, and allocate memory for all 165KB. Parse/compile adds ~165ms blocking time to TBT.',
              solution: 'Replace "import _ from \'lodash\'" with "import { debounce } from \'lodash-es\'". Replace Moment.js with native Intl.DateTimeFormat or date-fns.',
            },
            evidence: {
              source: 'coverage.app.bundle.js',
              reference: 'Lodash: 98KB (12% used, 86KB waste). Moment.js: 67KB (8% used, 62KB waste). Total: 148KB unused.',
              confidence: 0.95,
            },
            estimatedImpact: {
              metric: 'TBT',
              reduction: 165,
              confidence: 0.85,
            },
            rootCause: true,
          },
        ],
      }, null, 2),
      reasoning: 'Precise byte-level measurement, identifies specific libraries, explains why tree-shaking fails, provides concrete alternative',
    },
  ],

  // HAR Agent Examples
  har: [
    {
      title: 'Slow TTFB from Server',
      metric: 'TTFB',
      cms: 'all',
      hasRichData: true,
      input: 'HAR shows document request: DNS 20ms, TCP 30ms, SSL 50ms, Wait 800ms, Download 100ms',
      goodOutput: JSON.stringify({
        findings: [
          {
            id: 'har-ttfb-1',
            type: 'bottleneck',
            metric: 'TTFB',
            description: 'Server response time (Wait) is 800ms, exceeding recommended 600ms',
            reasoning: {
              observation: 'HAR timing breakdown for document: DNS 20ms, TCP 30ms, SSL 50ms, Wait 800ms, Download 100ms. Total TTFB = 900ms.',
              diagnosis: 'Wait time (800ms) represents server processing time. This is 200ms over recommended 600ms threshold.',
              mechanism: 'High Wait time delays when browser can start parsing HTML, which cascades to all dependent resources. Affects FCP, LCP, and overall page load.',
              solution: 'Optimize server-side rendering, implement caching (CDN, Redis), reduce database queries, enable compression',
            },
            evidence: {
              source: 'har.mainDocument.timings',
              reference: 'Wait: 800ms (exceeds 600ms threshold). Total TTFB: 900ms. DNS+TCP+SSL are normal (100ms combined).',
              confidence: 0.9,
            },
            estimatedImpact: {
              metric: 'TTFB',
              reduction: 200,
              confidence: 0.7,
            },
            rootCause: true,
          },
        ],
      }, null, 2),
      reasoning: 'Uses HAR timing breakdown to isolate bottleneck (Wait time, not network). Distinguishes network latency from server processing. Realistic impact (reduce to threshold).',
    },

    {
      title: 'Third-Party Script Blocking',
      metric: 'TBT',
      cms: 'all',
      hasRichData: true,
      input: 'HAR shows analytics.js from third-party domain: Wait 400ms, Download 200ms, blocks 600ms total',
      goodOutput: JSON.stringify({
        findings: [
          {
            id: 'har-thirdparty-1',
            type: 'bottleneck',
            metric: 'TBT',
            description: 'Third-party analytics script blocks for 600ms',
            reasoning: {
              observation: 'HAR entry for https://analytics.example.com/analytics.js: Wait 400ms, Download 200ms. Script is render-blocking (loaded in <head>).',
              diagnosis: 'Third-party domain adds network latency (TTFB 400ms). Script blocks HTML parsing while loading and executing.',
              mechanism: 'Blocking script prevents browser from parsing subsequent HTML. 600ms blocking time directly adds to TBT. Also delays LCP element discovery.',
              solution: 'Load analytics.js asynchronously (async attribute), or defer until after page load. Consider moving to after closing </body> tag.',
            },
            evidence: {
              source: 'har.https://analytics.example.com/analytics.js',
              reference: 'Third-party domain, Wait 400ms, Download 200ms, total 600ms. Render-blocking in <head>.',
              confidence: 0.85,
            },
            estimatedImpact: {
              metric: 'TBT',
              reduction: 600,
              confidence: 0.75,
            },
            rootCause: true,
          },
        ],
      }, null, 2),
      reasoning: 'Identifies third-party domain, explains network latency impact, provides concrete solution (async/defer)',
    },
  ],

  // RUM Agent Examples
  rum: [
    {
      title: 'Slow Click Interactions',
      metric: 'INP',
      cms: 'all',
      hasRichData: true,
      input: 'RUM shows p75 INP = 450ms, top slow interaction: click on navigation menu = 650ms (50 samples)',
      goodOutput: JSON.stringify({
        findings: [
          {
            id: 'rum-inp-1',
            type: 'bottleneck',
            metric: 'INP',
            description: 'Navigation menu click interactions are slow (650ms), causing poor INP',
            reasoning: {
              observation: 'RUM data: p75 INP = 450ms (exceeds 200ms threshold). Slowest interaction: click on #nav-menu averaging 650ms across 50 samples.',
              diagnosis: 'Menu click handler runs expensive DOM manipulation or heavy JavaScript synchronously, blocking main thread',
              mechanism: 'Long-running click handler delays visual feedback to user. 650ms delay perceived as sluggish interaction. Multiple slow interactions contribute to 450ms p75 INP.',
              solution: 'Profile menu click handler, defer non-critical work (setTimeout), virtualize long lists, debounce rapid clicks, use CSS animations instead of JS',
            },
            evidence: {
              source: 'rum.interactions',
              reference: 'p75 INP: 450ms. Slowest: click #nav-menu, 650ms average, 50 samples. Target: <200ms.',
              confidence: 0.8,
            },
            estimatedImpact: {
              metric: 'INP',
              reduction: 250,
              confidence: 0.7,
            },
            rootCause: false,
          },
        ],
      }, null, 2),
      reasoning: 'Uses real user data (p75), identifies specific interaction (#nav-menu), provides sample size for confidence',
    },
  ],

  // Validation Agent Examples (for meta-learning)
  validation: [
    {
      title: 'Implausible Impact Estimate',
      input: 'Finding claims 2500ms LCP reduction, but observed LCP is only 2000ms',
      output: 'BLOCK: Impact estimate (2500ms) exceeds observed metric value (2000ms). Physically impossible to save more time than exists.',
    },

    {
      title: 'Weak Evidence',
      input: 'Finding says "scripts are slow" without file names or timings',
      output: 'ADJUST: Confidence reduced to 0.3. Evidence lacks specificity (no file names, no timings, no concrete data references).',
    },

    {
      title: 'Missing Reasoning',
      input: 'Finding has description and impact but no reasoning field',
      output: 'BLOCK: Missing required reasoning field. Cannot verify causal logic without observation → diagnosis → mechanism → solution chain.',
    },
  ],
};

/**
 * Get examples by agent type
 * @param {string} agentType - Agent type (psi, coverage, har, rum, validation)
 * @param {Object} filters - Optional filters (metric, cms, hasRichData)
 * @returns {Array} Filtered examples
 */
export function getExamples(agentType, filters = {}) {
  const examples = examplesLibrary[agentType] || [];

  if (Object.keys(filters).length === 0) {
    return examples;
  }

  return examples.filter(example => {
    if (filters.metric && example.metric !== 'all' && example.metric !== filters.metric) {
      return false;
    }

    if (filters.cms && example.cms !== 'all' && example.cms !== filters.cms) {
      return false;
    }

    if (filters.hasRichData !== undefined && example.hasRichData !== filters.hasRichData) {
      return false;
    }

    return true;
  });
}

/**
 * Format examples for prompt inclusion
 * @param {Array} examples - Examples array
 * @returns {string} Formatted examples string
 */
export function formatExamplesForPrompt(examples) {
  return examples
    .map((example, index) => {
      let output = `### Example ${index + 1}: ${example.title}\n\n`;
      output += `**Input**: ${example.input}\n\n`;
      output += `**Good Output**:\n\`\`\`json\n${example.goodOutput}\n\`\`\`\n\n`;
      output += `**Why Good**: ${example.reasoning}\n\n`;

      if (example.badOutput) {
        output += `**Bad Output**:\n\`\`\`json\n${example.badOutput}\n\`\`\`\n\n`;
        output += `**Why Bad**: ${example.badReasoning}\n\n`;
      }

      return output;
    })
    .join('\n---\n\n');
}
