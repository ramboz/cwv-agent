import { getDeliverableFormat } from './shared.js';

/**
 * Generates the final action prompt for the analysis
 * @param {string} pageUrl - URL of the page being analyzed
 * @param {string} deviceType - Device type (mobile or desktop)
 * @returns {string} Final action prompt
 */
export const actionPrompt = (pageUrl, deviceType) =>`
Perform your final exhaustive and detailed analysis for url ${pageUrl} on a ${deviceType} device.

## Phase 5: Graph-Enhanced Synthesis Instructions

If you receive "Root Cause Prioritization" data from the causal graph:

1. **Focus on Root Causes**: Prioritize suggestions that address root causes over symptoms
   - Root causes are fundamental issues that cascade to multiple problems
   - Fixing one root cause often resolves multiple symptoms
   - Example: Unused code (root cause) → High TBT (symptom) → Poor INP (symptom)

2. **Combine Related Findings**: When multiple findings share the same root cause, create ONE holistic suggestion
   - Don't create separate suggestions for each symptom
   - Address the root cause comprehensively
   - Example: Instead of 3 separate suggestions for TBT, INP, and LCP, create one suggestion to remove unused code

3. **Order by Total Impact**: Use the "Total downstream impact" to prioritize
   - Higher impact root causes should appear first
   - Show cascading benefits in the description
   - Example: "Removing 1147KB unused code will improve TBT by 400ms, which cascades to INP improvement of ~200ms"

4. **Respect Graph Depth**: Deeper root causes (depth 2-3) are more fundamental
   - Depth 1: Direct causes (immediate problems)
   - Depth 2+: Root causes (fundamental issues)
   - Prioritize depth 2+ for strategic improvements

## Code Example Quality Standards

**GOOD Example** (AEM image optimization):
\`\`\`json
{
  "title": "Set fetchpriority=high on hero image",
  "description": "The hero image is discovered late and loads with default priority, delaying LCP by 800ms.",
  "implementation": "Update the Image Core Component HTL template to add fetchpriority='high' for above-the-fold images.",
  "codeExample": "File: /apps/myproject/components/content/hero/hero.html\\n\\n<img src=\\"\${image.src}\\"\\n     alt=\\"\${image.alt}\\"\\n     loading=\\"eager\\"\\n     fetchpriority=\\"high\\"\\n     width=\\"\${image.width}\\"\\n     height=\\"\${image.height}\\" />"
}
\`\`\`

**BAD Example** (too generic):
\`\`\`json
{
  "title": "Preload Critical Rendering Assets",
  "description": "Preload hero images to improve LCP",
  "implementation": "Add preload links in the head section",
  "codeExample": "<link rel=\\"preload\\" as=\\"image\\" href=\\"hero.jpg\\">"
}
\`\`\`
**Why bad**: Not maintainable (requires per-page modification), doesn't consider AEM template constraints

**GOOD Example** (font loading):
\`\`\`json
{
  "title": "Use font-display:swap with size-adjusted fallback",
  "description": "Custom fonts load without fallback strategy, causing FOUT and CLS of 0.08",
  "implementation": "Configure @font-face with font-display:swap and size-adjust fallback font to minimize layout shift",
  "codeExample": "File: /apps/myproject/clientlibs/clientlib-base/css/fonts.css\\n\\n@font-face {\\n  font-family: 'CustomFont';\\n  src: url('/fonts/customfont.woff2') format('woff2');\\n  font-display: swap;\\n  font-weight: 400;\\n}\\n\\n@font-face {\\n  font-family: 'CustomFont-fallback';\\n  src: local('Arial');\\n  size-adjust: 105%;\\n  ascent-override: 95%;\\n  descent-override: 25%;\\n}\\n\\nbody {\\n  font-family: 'CustomFont', 'CustomFont-fallback', sans-serif;\\n}"
}
\`\`\`

**BAD Example** (font loading):
\`\`\`json
{
  "title": "Preload fonts",
  "description": "Fonts load late",
  "implementation": "Preload custom fonts",
  "codeExample": "<link rel=\\"preload\\" as=\\"font\\" href=\\"font.woff2\\">"
}
\`\`\`
**Why bad**: Preloading fonts can waste bandwidth, doesn't address FOUT/CLS, missing font-display strategy

${getDeliverableFormat()}
`;
