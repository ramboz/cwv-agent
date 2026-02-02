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

## Code Example Requirements (Expanded)

**CRITICAL**: Every suggestion MUST include a complete, AEM-specific code example in the codeChanges array with:

1. **File specification**: Use codeChanges array with file property
   - ✅ GOOD: { "file": "/apps/myproject/components/content/hero/hero.html", "after": "..." }
   - ❌ BAD: { "file": "Update your component template" }
   - ❌ BAD: Using "codeExample" string field (schema requires codeChanges array)

2. **Context-specific implementation**: Match the CMS architecture
   - AEM AMS/CS: Show clientlib categories, HTL templates, dispatcher config
   - EDS: Show block structure, styles.css, lazy-styles.css

3. **Before/After diff format** when modifying existing code:
   \`\`\`diff
   - <script src="analytics.js"></script>
   + <script src="analytics.js" defer></script>
   \`\`\`

4. **Complete configuration** for multi-file changes:
   - Clientlib .content.xml
   - Dispatcher .any configuration
   - HTL template modifications

5. **Verification instructions** with specific commands:
   - Tool to use (lighthouse, chrome-devtools, curl, etc.)
   - Step-by-step verification method
   - Expected result with concrete values
   - Acceptance criteria with thresholds

**AEM-Specific Requirements**:

For AEM sites (AMS or Cloud Service), include:

1. **Clientlib structure** if suggesting CSS/JS changes:
   \`\`\`xml
   <!-- .content.xml -->
   <?xml version="1.0" encoding="UTF-8"?>
   <jcr:root xmlns:cq="http://www.day.com/jcr/cq/1.0"
       categories="[cq.myproject.critical]"
       embed="[cq.myproject.fonts]"/>
   \`\`\`

2. **Dispatcher configuration** if suggesting caching changes:
   \`\`\`apache
   # dispatcher.any
   /statfileslevel "2"
   /cache {
     /rules {
       /0001 { /glob "*.html" /type "allow" }
     }
   }
   \`\`\`

3. **HTL template paths** with Core Component version:
   \`\`\`html
   <!-- /apps/myproject/components/content/hero/hero.html -->
   <sly data-sly-use.image="com.adobe.cq.wcm.core.components.models.Image">
     <img src="\$\{image.src\}"
          fetchpriority="high"
          loading="eager"/>
   </sly>
   \`\`\`

**Verification Template**:

Every suggestion MUST include this structure:

\`\`\`json
{
  "howToVerify": {
    "tool": "lighthouse | chrome-devtools | curl | web-vitals-library | webpack-bundle-analyzer",
    "method": "Step-by-step instructions:\\n1. Open Chrome DevTools\\n2. Navigate to Network tab\\n3. ...",
    "expectedResult": "TTFB should decrease from 651ms to below 400ms",
    "acceptanceCriteria": "TTFB ≤ 800ms (passing), target <400ms (optimal)"
  }
}
\`\`\`

**Examples of Complete Suggestions**:

GOOD Example (TTFB optimization with dispatcher config):
\`\`\`json
{
  "title": "Optimize Dispatcher Cache for Static Assets",
  "description": "The server TTFB is 651ms due to low dispatcher cache hit ratio. Static assets are being served from publish instances instead of dispatcher cache.",
  "solution": "Update dispatcher.any to enable statfile-level caching and increase cache TTL for static resources.",
  "codeChanges": [
    {
      "file": "/etc/httpd/conf.dispatcher.d/dispatcher.any",
      "after": "/cache {\\n  /statfileslevel \\"2\\"  # Enable granular cache invalidation\\n  /rules {\\n    /0001 { /glob \\"*.html\\" /type \\"allow\\" }\\n    /0002 { /glob \\"/content/*\\" /type \\"allow\\" }\\n  }\\n  /headers {\\n    \\"Cache-Control\\"\\n    \\"Content-Type\\"\\n  }\\n}\\n\\n/clientheaders {\\n  \\"Host\\"\\n  \\"User-Agent\\"\\n}"
    }
  ],
  "verification": {
    "tool": "curl",
    "method": "1. Test cache headers:\\n   curl -I https://www.qualcomm.com/\\n2. Look for X-Dispatcher: dispatcher header\\n3. Check Age header increasing on subsequent requests\\n4. Monitor dispatcher.log for cache hits",
    "expectedImprovement": "X-Dispatcher header present, Age header increments on reload, dispatcher.log shows HIT instead of MISS",
    "acceptanceCriteria": "TTFB ≤ 400ms for cached responses, cache hit ratio >80%"
  }
}
\`\`\`

GOOD Example (Clientlib code-splitting):
\`\`\`json
{
  "title": "Split Clientlibs into Critical and Non-Critical Categories",
  "description": "800KB of CSS is loaded synchronously with 100% unused on initial render, blocking LCP by 2+ seconds.",
  "solution": "Create separate clientlib categories for critical (above-fold) and non-critical (below-fold) CSS. Load critical CSS synchronously in <head>, load non-critical CSS asynchronously with JavaScript.",
  "codeChanges": [
    {
      "file": "/apps/myproject/clientlibs/clientlib-critical/.content.xml",
      "after": "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?>\\n<jcr:root xmlns:cq=\\"http://www.day.com/jcr/cq/1.0\\"\\n    categories=\\"[cq.myproject.critical]\\"\\n    embed=\\"[cq.myproject.fonts]\\"/>"
    },
    {
      "file": "/apps/myproject/components/structure/page/head.html",
      "after": "<!-- Load critical CSS synchronously -->\\n<sly data-sly-use.clientlib=\\"/libs/granite/sightly/templates/clientlib.html\\">\\n  <sly data-sly-call=\\"\\$\{clientlib.css @ categories='cq.myproject.critical'\}\\"/>\\n</sly>\\n\\n<!-- Load non-critical CSS asynchronously -->\\n<script>\\nif ('requestIdleCallback' in window) {\\n  requestIdleCallback(() => {\\n    const link = document.createElement('link');\\n    link.rel = 'stylesheet';\\n    link.href = '/etc.clientlibs/myproject/clientlibs/clientlib-base.min.css';\\n    document.head.appendChild(link);\\n  });\\n} else {\\n  setTimeout(() => {\\n    const link = document.createElement('link');\\n    link.rel = 'stylesheet';\\n    link.href = '/etc.clientlibs/myproject/clientlibs/clientlib-base.min.css';\\n    document.head.appendChild(link);\\n  }, 1);\\n}\\n</script>"
    }
  ],
  "verification": {
    "tool": "chrome-devtools",
    "method": "1. Open Chrome DevTools Coverage tab\\n2. Reload the page\\n3. Filter by CSS files\\n4. Check unused bytes for critical vs non-critical clientlibs\\n5. Open Network tab, filter by CSS\\n6. Verify non-critical CSS loads after LCP (check timing)",
    "expectedImprovement": "Critical CSS <50KB with <20% unused. Non-critical CSS loads after LCP event. Render-blocking CSS reduced from 800KB to <50KB.",
    "acceptanceCriteria": "LCP improves by >2s, FCP improves by >900ms, Lighthouse 'Eliminate render-blocking resources' audit passes"
  }
}
\`\`\`

BAD Example (too generic):
\`\`\`json
{
  "title": "Optimize JavaScript",
  "description": "JavaScript is slow",
  "solution": "Use code splitting",
  "codeChanges": [
    {
      "file": "src/app.js",
      "after": "// Split your code\\nimport('./module.js')"
    }
  ]
}
\`\`\`
Why bad: No AEM-specific file paths, no context about clientlibs, no verification object, no acceptance criteria, code example doesn't show AEM patterns

**When to use before/after vs just after in codeChanges:**
- Use "before" + "after" when modifying existing code (showing diff/replacement)
  - Example: Changing an existing HTL template, modifying dispatcher rules
- Use only "after" when adding new files or configurations
  - Example: Creating new clientlib .content.xml, adding new dispatcher cache rules
- For multi-file changes, each file can independently use before/after or just after
  - Example: Modify existing HTL (before/after) + create new clientlib (just after)

${getDeliverableFormat()}
`;
