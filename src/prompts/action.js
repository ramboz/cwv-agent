import { getDeliverableFormat, getTechnicalContext } from './shared.js';

/**
 * Generates the final action prompt for the analysis
 * @param {string} pageUrl - URL of the page being analyzed
 * @param {string} deviceType - Device type (mobile or desktop)
 * @param {string} cms - CMS type (ams, cs, eds)
 * @returns {string} Final action prompt
 */
export const actionPrompt = (pageUrl, deviceType, cms = 'eds') => `
Produce the final analysis and actionable suggestion list for ${pageUrl} on a ${deviceType} device.
Your output is a ranked set of optimization suggestions — each one grounded in upstream agent findings, classified with a semanticType, and tied to concrete code changes.

${getTechnicalContext(cms)}

## Synthesis Rules

### Prioritize Root Causes Over Symptoms
If you receive "Root Cause Prioritization" data from the causal graph, apply these rules; otherwise infer root causes from the findings yourself.

1. **Focus on root causes, not symptoms.** Root causes cascade to multiple problems; fixing one often resolves many.
   Example: Unused code (root cause) → High TBT (symptom) → Poor INP (symptom).
2. **Combine related findings into one suggestion** when they share a root cause. Do not emit a separate suggestion per symptom.
   Example: Merge TBT + INP + LCP findings caused by the same unused code into one "Remove unused code" suggestion.
3. **Order by total downstream impact.** Higher-impact root causes go first; describe cascading benefits in the suggestion.
   Example: "Removing 1147KB unused code will improve TBT by 400ms, which cascades to INP improvement of ~200ms."
4. **Respect graph depth.** Depth 1 = direct causes; depth 2+ = fundamental root causes — prefer depth 2+ for strategic suggestions.

### Every Suggestion Must Have a semanticType
The \`semanticType\` field drives downstream filtering, targeted analysis modes, and SpaceCat categorization.

- **Inherit from findings.** Use the semanticType of the primary finding the suggestion addresses.
- **For merged suggestions.** Use the semanticType of the root cause finding.
  Example: Merging unused-code + TBT + INP → \`unused-code\`.
  Example: Merging lcp-image + CLS on the same image → \`lcp-image\`.
- **When uncertain.** Prefer the most specific matching type; fall back to the finding with highest impact.

Valid types (use the most specific that applies):
- \`lcp-image\` — LCP-specific image issues (missing preload, fetchpriority, lazy-loading on the LCP element)
- \`font-format\` — font format/loading issues (missing font-display, FOIT/FOUT)
- \`font-preload\` — missing font preload or preconnect to font CDN
- \`image-sizing\` — missing width/height/aspect-ratio causing CLS
- \`unused-code\` — unused CSS/JS in bundles
- \`js-execution\` — long tasks, heavy JavaScript execution
- \`layout-shift\` — CLS issues (dynamic inserts, unsized elements)
- \`blocking-resource\` — render-blocking CSS/JS
- \`ttfb\` — server response time / backend
- \`third-party\` — third-party scripts impacting performance
- \`resource-preload\` — missing preload hints for critical resources
- Add others as appropriate.

### Every Suggestion Must Include Concrete codeChanges
- GOOD: \`{ "file": "/apps/myproject/components/content/hero/hero.html", "after": "..." }\`
- BAD: \`{ "file": "Update your component template" }\`

Match code examples to the CMS architecture:
- AEM AMS/CS → clientlib categories, HTL templates, dispatcher config
- EDS → block structure, styles.css, lazy-styles.css

Before/after convention:
- Modifying existing code → provide both \`before\` and \`after\`
- Adding new files/config → \`after\` only
- Multi-file changes → each file uses its own before/after (or just after)

${getDeliverableFormat()}
`;
