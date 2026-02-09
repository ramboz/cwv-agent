import { getDeliverableFormat, getTechnicalContext } from './shared.js';

/**
 * Generates the final action prompt for the analysis
 * @param {string} pageUrl - URL of the page being analyzed
 * @param {string} deviceType - Device type (mobile or desktop)
 * @param {string} cms - CMS type (ams, cs, eds)
 * @returns {string} Final action prompt
 */
export const actionPrompt = (pageUrl, deviceType, cms = 'eds') =>`
Perform your final exhaustive and detailed analysis for url ${pageUrl} on a ${deviceType} device.

${getTechnicalContext(cms)}

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

## CRITICAL: Semantic Type Classification

EVERY suggestion MUST include a semanticType field for downstream filtering and targeted analysis:

1. **Inherit from findings**: When creating a suggestion from agent findings, use the semanticType from the primary finding
   - If the suggestion addresses an LCP image issue, use "lcp-image"
   - If the suggestion addresses font loading, use "font-format" or "font-preload"
   - If the suggestion addresses missing image dimensions, use "image-sizing"

2. **For merged suggestions**: When combining multiple findings into one suggestion, use the semantic type of the root cause finding
   - Example: If merging unused-code + TBT + INP findings, use "unused-code" as semanticType
   - Example: If merging lcp-image + CLS findings about the same image, use "lcp-image" as the primary type

3. **Valid semantic types** (use the most specific type that matches):
   - **lcp-image**: LCP-specific image issues (missing preload, fetchpriority, lazy loading on LCP element)
   - **font-format**: Font format/loading issues (missing font-display, FOIT/FOUT)
   - **font-preload**: Missing font preload hints or preconnect to font CDN
   - **image-sizing**: Missing width/height/aspect-ratio attributes causing CLS
   - **unused-code**: Code waste (unused CSS/JS in bundles)
   - **js-execution**: Long tasks, heavy JavaScript execution
   - **layout-shift**: CLS issues (dynamic content insertion, unsized elements)
   - **blocking-resource**: Render-blocking CSS/JS resources
   - **ttfb**: Server response time, backend performance
   - **third-party**: Third-party scripts impacting performance
   - **resource-preload**: Missing preload hints for critical resources
   - And others as appropriate...

4. **When uncertain**: Choose the most specific type that matches the primary issue being addressed
   - Prefer specific types (lcp-image, font-preload) over generic types (resource-preload)
   - If truly ambiguous, use the type of the finding with highest impact

**Why this matters**: The semanticType field enables:
- Targeted analysis modes (light mode for quick wins, full mode for comprehensive audit)
- Downstream filtering by SpaceCat platform
- Better categorization and prioritization of suggestions

**Examples**:
- Suggestion about hero image loading → semanticType: "lcp-image"
- Suggestion about custom font optimization → semanticType: "font-format" or "font-preload"
- Suggestion about images missing dimensions → semanticType: "image-sizing"
- Suggestion about removing unused CSS → semanticType: "unused-code"

## Code Change Requirements

**Every suggestion MUST include codeChanges with AEM-specific file paths:**
- ✅ GOOD: { "file": "/apps/myproject/components/content/hero/hero.html", "after": "..." }
- ❌ BAD: { "file": "Update your component template" }

**Match the CMS architecture:**
- AEM AMS/CS: Show clientlib categories, HTL templates, dispatcher config
- EDS: Show block structure, styles.css, lazy-styles.css

**Before/After convention:**
- Use "before" + "after" when modifying existing code (showing diff/replacement)
- Use only "after" when adding new files or configurations
- For multi-file changes, each file can independently use before/after or just after

${getDeliverableFormat()}
`;
