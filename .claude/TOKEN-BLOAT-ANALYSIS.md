# Token Bloat Analysis: CWV Agent Data Collection

## Executive Summary

**Current State**: Sending **3.3M tokens** of data to LLM agents
**Optimized State**: Could reduce to **~1.0M tokens** (70% reduction)
**Root Cause**: Sending raw/full data instead of CWV-focused summaries

---

## Token Usage Breakdown (Krisshop.com Mobile)

| Data Source | Current Tokens | % of Total | Status |
|-------------|----------------|------------|--------|
| **Code Files** | 1,157,696 | 35% | ❌ Full source code |
| **Performance Entries** | 810,674 | 24% | ❌ Full HTML + metrics |
| **Rules** | 427,190 | 13% | ❌ Prettified HTML in failures |
| **HTML** | 333,257 | 10% | ❌ Complete rendered page |
| **Coverage** | 282,269 | 9% | ⚠️ Detailed segment mapping |
| **PSI** | 254,356 | 8% | ✅ Already summarized |
| **RUM** | 1,082 | <1% | ✅ Optimized |
| **CrUX** | 596 | <1% | ✅ Optimized |
| **JS API** | 3,396 | <1% | ✅ Minimal |
| **TOTAL** | **3,270,516** | 100% | 🔴 **Needs optimization** |

---

## Detailed Analysis by Data Source

### 1. Performance Entries: 810K tokens (24%) - **HIGH PRIORITY**

**Location**: `src/tools/lab/performance-collector.js`

**What's Being Sent**:
```javascript
// Line 35-73: Collects full element HTML for every CLS/LCP event
await appendEntries(entries, 'largest-contentful-paint', (e) => ({
  ...clone(e),
  element: e.element?.outerHTML  // ← Full HTML of LCP element (50-200KB)
}));

await appendEntries(entries, 'layout-shift', (e) => ({
  ...clone(e),
  sources: e.sources?.map((s) => {
    return {
      node: s.node?.outerHTML,  // ← Full HTML of shifted element (100-500KB)
      cssProperties: {...},      // ← All computed styles
      parentLayout: {...}        // ← Parent computed styles
    };
  })
}));
```

**Why It's Bloated**:
- LCP entries include `<div class="hero-banner">...entire HTML tree...</div>` (50-200KB per element)
- CLS entries include full HTML for EVERY shifted element (can be 10-50 elements × 5-50KB each)
- Computed styles for every affected element (20-30 properties × 10-50 elements)

**What Agents Actually Need for CWV**:
```javascript
// LCP
{
  tag: "img",                    // Element type
  selector: ".hero-banner img",  // CSS selector
  renderTime: 2540,              // When it rendered
  loadTime: 2350,                // When resource loaded
  size: 156480,                  // Element size in pixels
  url: "hero.jpg"                // Resource URL
}

// CLS
{
  tag: "div",
  selector: ".product-carousel",
  value: 0.25,                   // Shift score
  hadRecentInput: false,
  previousRect: { x: 0, y: 200, width: 400, height: 300 },
  currentRect: { x: 0, y: 450, width: 400, height: 300 },
  cssIssues: ["missing aspect-ratio", "no min-height"],
  parentLayout: "flex column"
}
```

**Optimization Strategy**:
1. Replace `element.outerHTML` with `{tag, id, class[], selector}` (saves 95%)
2. Replace full computed styles with CLS-relevant flags:
   - Has `aspect-ratio`?
   - Has explicit `width`/`height`?
   - Has `min-height`?
   - Font loading strategy?
3. Limit CLS sources to top 5 by impact (saves 80%)

**Expected Reduction**: 810K → **120K tokens** (85% reduction)

---

### 2. Code Files: 1.16M tokens (35%) - **HIGHEST PRIORITY**

**Location**: `src/tools/code.js` + `src/prompts/analysis.js:149-166`

**What's Being Sent**:
```javascript
// analysis.js:149-166 (codeStep function)
export const codeStep = (pageUrl, resources, threshold = 100_000) => {
  const code = Object.entries(resources)
    .filter(([,value]) => estimateTokenSize(value) < threshold)  // Per-file 100KB limit
    .map(([key, value]) => `// File: ${key}\n${value}\n\n`)      // FULL SOURCE CODE
    .join('\n');
  return `${code}`;  // All files concatenated
};
```

**Example of What's Sent**:
```javascript
// File: https://www.krisshop.com/etc.clientlibs/site/clientlib-site.js
(function() {
  'use strict';

  // 500 lines of carousel logic
  function initCarousel(element) {
    const slides = element.querySelectorAll('.slide');
    const nextBtn = element.querySelector('.next');
    // ... 50 more lines ...
  }

  // 800 lines of product filtering
  function initFilters(container) {
    // ... entire implementation ...
  }

  // ... 5000+ more lines of code ...
})();
```

**Why It's Bloated**:
- Sends **complete source code** for every file < 100KB
- Multiple files can aggregate to 1M+ tokens
- Includes:
  - All comments and documentation
  - All function bodies (only need signatures)
  - All whitespace and formatting
  - Library code if bundled

**What Agents Actually Need for CWV**:

**Option A: Function-Level Analysis** (for code structure):
```javascript
// File: clientlib-site.js (350KB minified)
// CWV-Relevant Functions:
- initCarousel() → Called on: DOMContentLoaded → Duration: 85ms → Blocks main thread
- initFilters() → Called on: load → Duration: 120ms → Blocks main thread
- lazyLoadImages() → Called on: scroll → Uses IntersectionObserver ✓

// Third-Party Scripts:
- gtag.js (45KB) → Loaded: synchronously → Recommendation: defer
- pushengage.js (32KB) → Loaded: async ✓

// Render-Blocking Resources:
- clientlib-base.css (128KB) → 92% unused
- clientlib-site.css (94KB) → 87% unused
```

**Option B: Metrics Only** (preferred for CWV):
```javascript
{
  "files": [
    {
      "url": "clientlib-site.js",
      "size": 358400,
      "loadTiming": {
        "fetchStart": 850,
        "responseEnd": 1200,
        "duration": 350
      },
      "executionTiming": {
        "scriptEvaluation": 245,
        "longTasks": [
          {"start": 1200, "duration": 85, "function": "initCarousel"},
          {"start": 1300, "duration": 120, "function": "initFilters"}
        ]
      },
      "coverage": {
        "total": 358400,
        "used": 45280,
        "unused": 313120,
        "usedPercent": 12.6
      }
    }
  ]
}
```

**Optimization Strategy**:
1. **Don't send source code** - send metrics instead (from coverage + HAR)
2. For code review, send only:
   - Function names + signatures (not bodies)
   - Comments explaining CWV-relevant sections
   - Third-party script tags (not implementations)
3. Use coverage data + HAR timing to identify long-running functions
4. Let agents request specific code sections if needed (iterative)

**Expected Reduction**: 1.16M → **50-100K tokens** (91-95% reduction)

---

### 3. Rules: 427K tokens (13%) - **HIGH PRIORITY**

**Location**: `src/tools/rules.js:54-63` (summarize function)

**What's Being Sent**:
```javascript
// rules.js:29-52 (details function)
if (rule.element) {
  return prettifyWithOffset(rule.element, 4, 'html');  // Full prettified HTML
}
if (rule.elements) {
  return rule.elements.map(e => prettifyWithOffset(e, 4, 'html')).join('\n');
}
```

**Example Output**:
```markdown
- Render-blocking CSS files detected:
  - Recommendation: Use critical CSS inline or async loading
  - <link
        rel="stylesheet"
        href="/etc.clientlibs/site/clientlibs/clientlib-base.css"
        type="text/css"
        integrity="sha256-abc123..."
        crossorigin="anonymous">
  - <link
        rel="stylesheet"
        href="/etc.clientlibs/site/clientlibs/clientlib-site.css"
        type="text/css"
        integrity="sha256-def456..."
        crossorigin="anonymous">
  - (... 15 more prettified link tags, each 150+ chars ...)
```

**Why It's Bloated**:
- Prettified HTML with indentation (4 spaces per level)
- Full attributes for every element (integrity, crossorigin, type, etc.)
- No truncation or sampling of multiple elements

**What Agents Actually Need**:
```markdown
- Render-blocking CSS files detected (17 total):
  - Recommendation: Use critical CSS inline or async loading
  - Top offenders:
    • clientlib-base.css (128KB, blocks 340ms)
    • clientlib-site.css (94KB, blocks 280ms)
    • fonts.css (12KB, blocks 50ms)
  - See: <link rel="stylesheet" href="/etc.clientlibs/.../clientlib-base.css">
```

**Optimization Strategy**:
1. Replace prettified HTML with compact tag notation: `<link rel="stylesheet" href="...">`
2. Sample top 3 elements instead of all
3. Focus on actionable metrics (size, blocking time) over full attributes
4. Use counts ("17 total") instead of enumerating all

**Expected Reduction**: 427K → **80-100K tokens** (75-80% reduction)

---

### 4. HTML Markup: 333K tokens (10%) - **HIGH PRIORITY**

**Location**: `src/tools/lab/index.js:108-110` + `src/prompts/analysis.js:125-129`

**What's Being Sent**:
```javascript
// index.js:108
fullHtml = await page.evaluate(() => document.documentElement.outerHTML);

// analysis.js:125-129 (htmlStep)
export const htmlStep = (pageUrl, resourcesOrHtml) => `
Analyze the full rendered HTML for CWV issues:
${typeof resourcesOrHtml === 'string' ? resourcesOrHtml : resourcesOrHtml?.[pageUrl]}
`;
```

**What's Included in Full HTML**:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="...">
  <!-- 50+ meta tags -->
  <!-- 20+ script tags with full inline code -->
  <!-- 15+ link tags -->
  <!-- Inline styles (5-50KB) -->
</head>
<body>
  <!-- Entire rendered page DOM (200-500KB) -->
  <header>...</header>
  <main>
    <div class="hero-banner">
      <img src="..." />
      <!-- 100+ nested divs -->
    </div>
    <!-- 500+ product cards with full markup -->
  </main>
  <footer>...</footer>
  <!-- Inline scripts (50-100KB) -->
</body>
</html>
```

**Why It's Bloated**:
- Complete rendered HTML of entire page (1-10MB compressed to 333K tokens)
- Includes all scripts, styles, content, comments
- No extraction of CWV-relevant sections

**What Agents Actually Need for CWV**:

**Critical Sections Only**:
```javascript
{
  "head": {
    "preload": ["<link rel='preload' as='image' href='hero.jpg'>"],
    "preconnect": ["<link rel='preconnect' href='https://fonts.googleapis.com'>"],
    "renderBlocking": [
      {"tag": "link", "href": "clientlib-base.css", "media": "all"},
      {"tag": "link", "href": "clientlib-site.css", "media": "all"}
    ],
    "scripts": [
      {"tag": "script", "src": "gtag.js", "async": false, "defer": false},
      {"tag": "script", "src": "pushengage.js", "async": true}
    ]
  },
  "lcpCandidates": [
    {"tag": "img", "selector": ".hero-banner img", "size": [1200, 600], "loading": "eager"},
    {"tag": "div", "selector": ".hero-banner", "hasBackgroundImage": true}
  ],
  "lazyLoadMarkers": [
    {"tag": "img", "loading": "lazy", "position": "above-fold", "warning": "LCP candidate"}
  ],
  "missingDimensions": [
    {"tag": "img", "selector": ".product-card img", "count": 24}
  ]
}
```

**Optimization Strategy**:
1. Extract `<head>` metadata only (preload, preconnect, scripts, styles)
2. Identify LCP candidates (large images, hero sections) - send selector + attributes
3. Find lazy-load markers above fold
4. Find images without width/height attributes
5. **Don't send**: full body content, footer, navigation, product details

**Expected Reduction**: 333K → **20-40K tokens** (88-94% reduction)

---

### 5. Coverage: 282K tokens (9%) - **MEDIUM PRIORITY**

**Location**: `src/tools/lab/coverage-collector.js:55-86`

**What's Being Sent**:
```javascript
// coverage-collector.js:71-79
for (const [fileUrl, fileData] of Object.entries(result)) {
  summary += formatFileUsage(fileUrl, fileData);  // Per-file breakdown
}
```

**Example Output** (formatFileUsage):
```markdown
### JavaScript: clientlib-site.js

**Usage Breakdown:**
- Pre-LCP execution: 12.3% (45KB / 365KB)
  - initCarousel:1234 (pre-lcp)
  - setupNav:2456 (pre-lcp)
  - lazyLoad:3678 (pre-lcp)
  - ... (50+ more function mappings)

- Post-LCP execution: 5.4% (20KB / 365KB)
  - handleClick:4567 (post-lcp)
  - ... (30+ more function mappings)

- Not executed: 82.3% (300KB / 365KB)
  - unusedFunc1:5678 (not-used)
  - unusedFunc2:6789 (not-used)
  - ... (200+ more function mappings)
```

**Why It's Bloated**:
- Per-function breakdown (can be 100-500 functions per file)
- Multiple files × 100-500 mappings = massive output
- Falls back to raw `coverageData` object if summary fails (even worse - 500K+)

**What Agents Actually Need**:
```javascript
{
  "files": [
    {
      "url": "clientlib-site.js",
      "size": 365000,
      "preLcpPercent": 12.3,
      "preLcpBytes": 45000,
      "postLcpPercent": 5.4,
      "postLcpBytes": 20000,
      "unusedPercent": 82.3,
      "unusedBytes": 300000,
      "topOpportunities": [
        {"function": "unusedAnalytics", "bytes": 85000},
        {"function": "unusedFeatureX", "bytes": 42000},
        {"function": "unusedFeatureY", "bytes": 38000}
      ]
    }
  ],
  "totalUnused": 1250000,
  "totalSize": 1580000,
  "unusedPercent": 79.1
}
```

**Optimization Strategy**:
1. Aggregate by file, not function
2. Sample top 3 opportunities per file (largest unused sections)
3. Remove per-function mappings (agents don't need this granularity)
4. Keep only summary percentages and top offenders

**Expected Reduction**: 282K → **40-60K tokens** (78-85% reduction)

---

### 6. PSI: 254K tokens (8%) - **LOW PRIORITY** ✅

**Status**: Already using summary from `src/tools/psi.js`

**Potential Optimization**:
- Still sends `full` PSI JSON in addition to summary
- Could strip to summary-only (save ~50K tokens)

---

## Summary: Recommended Optimizations

### Priority 1: Immediate Impact (Save 2.0M tokens)

| Source | Current | Optimized | Savings | Effort |
|--------|---------|-----------|---------|--------|
| **Code Files** | 1.16M | 80K | 1.08M (93%) | Medium |
| **Performance Entries** | 810K | 120K | 690K (85%) | Easy |
| **HTML** | 333K | 30K | 303K (91%) | Easy |
| **TOTAL P1** | 2.30M | 230K | **2.07M (90%)** | 1-2 days |

### Priority 2: Additional Gains (Save 400K tokens)

| Source | Current | Optimized | Savings | Effort |
|--------|---------|-----------|---------|--------|
| **Rules** | 427K | 90K | 337K (79%) | Easy |
| **Coverage** | 282K | 50K | 232K (82%) | Easy |
| **PSI** | 254K | 200K | 54K (21%) | Easy |
| **TOTAL P2** | 963K | 340K | **623K (65%)** | 1 day |

### Combined Impact

**Current Total**: 3.27M tokens
**Optimized Total**: 0.57M tokens
**Total Savings**: 2.70M tokens (82% reduction)

---

## Implementation Plan

### Phase A: Quick Wins (1 day)

**1. Performance Entries** (`performance-collector.js:35-73`):
```javascript
// Replace full HTML with selector
await appendEntries(entries, 'largest-contentful-paint', (e) => ({
  tag: e.element?.tagName,
  selector: getSelector(e.element),  // New helper function
  renderTime: e.renderTime,
  loadTime: e.loadTime,
  size: e.size,
  url: e.url
}));

// For CLS, capture only critical info
await appendEntries(entries, 'layout-shift', (e) => ({
  value: e.value,
  hadRecentInput: e.hadRecentInput,
  sources: e.sources?.slice(0, 5).map(s => ({  // Top 5 only
    tag: s.node?.tagName,
    selector: getSelector(s.node),
    previousRect: s.previousRect,
    currentRect: s.currentRect,
    cssIssues: detectCssIssues(s.node)  // Helper: checks aspect-ratio, min-height
  }))
}));
```

**2. HTML Extraction** (`lab/index.js:108 + analysis.js:125`):
```javascript
// New function: extractCwvRelevantHtml(page)
export async function extractCwvRelevantHtml(page) {
  return await page.evaluate(() => {
    const head = {
      preload: Array.from(document.querySelectorAll('link[rel="preload"]'))
        .map(l => ({href: l.href, as: l.as})),
      scripts: Array.from(document.querySelectorAll('script[src]'))
        .map(s => ({src: s.src, async: s.async, defer: s.defer})),
      renderBlocking: Array.from(document.querySelectorAll('link[rel="stylesheet"]:not([media="print"])'))
        .map(l => ({href: l.href, media: l.media}))
    };

    // Find LCP candidates (large images, hero sections)
    const lcpCandidates = Array.from(document.querySelectorAll('img, [style*="background-image"]'))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 300 && rect.height > 200;  // Substantial size
      })
      .slice(0, 5)  // Top 5 only
      .map(el => ({
        tag: el.tagName,
        selector: getSelector(el),
        width: el.width,
        height: el.height,
        loading: el.loading,
        hasBackgroundImage: el.style.backgroundImage ? true : false
      }));

    return {head, lcpCandidates};
  });
}
```

**3. Rules Formatting** (`rules.js:29-52`):
```javascript
// Replace prettifyWithOffset with compact format
const details = (rule) => {
  if (!rule.element && !rule.elements) return null;

  if (rule.element) {
    // Extract tag + key attributes only
    const match = rule.element.match(/<(\w+)[^>]*(?:id|class|href|src)=["']([^"']+)["']/);
    return match ? `<${match[1]} ${match[0]}>` : rule.element.substring(0, 80);
  }

  if (rule.elements && rule.elements.length > 0) {
    const count = rule.elements.length;
    // Show count + sample first 3
    const samples = rule.elements.slice(0, 3).map(e => {
      const match = e.match(/<(\w+)[^>]*(?:id|class|href|src)=["']([^"']+)["']/);
      return match ? `<${match[1]} ${match[0]}>` : e.substring(0, 60);
    });
    return `${count} elements (samples: ${samples.join(', ')})`;
  }
};
```

**Expected Savings**: ~1.3M tokens (40% total reduction)

---

### Phase B: Code Optimization (1-2 days)

**Option 1: Metrics-Only** (Recommended):
```javascript
// analysis.js:149-166 - Replace codeStep
export const codeStep = (pageUrl, resources, harData, coverageData, threshold = 100_000) => {
  // Build metrics from coverage + HAR instead of sending source
  const codeMetrics = Object.entries(resources)
    .filter(([key]) => key !== pageUrl)
    .map(([url, content]) => {
      const har = harData.find(e => e.url === url);
      const cov = coverageData[url];

      return {
        url,
        size: content.length,
        loadTiming: har ? {
          fetchStart: har.fetchStart,
          duration: har.duration
        } : null,
        coverage: cov ? {
          usedPercent: cov._isLoadedPreLcp ? (cov.preLcpBytes / cov.totalBytes * 100) : 0,
          unusedBytes: cov.unusedBytes
        } : null
      };
    });

  return JSON.stringify({files: codeMetrics}, null, 2);
};
```

**Option 2: Selective Source** (If code review needed):
```javascript
// Only send code for files with known issues
export const codeStep = (pageUrl, resources, issues) => {
  const relevantFiles = issues
    .filter(i => i.type === 'code-review-needed')
    .map(i => i.fileUrl);

  const code = Object.entries(resources)
    .filter(([url]) => relevantFiles.includes(url))
    .map(([url, content]) => {
      // Send only function signatures
      const functions = extractFunctionSignatures(content);  // New helper
      return `// File: ${url}\n${functions.join('\n')}\n\n`;
    })
    .join('\n');

  return code;
};

function extractFunctionSignatures(code) {
  // Regex to extract function names + params (not bodies)
  const funcRegex = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:function|\([^)]*\)\s*=>))\s*\([^)]*\)/g;
  const matches = [...code.matchAll(funcRegex)];
  return matches.map(m => m[0]);
}
```

**Expected Savings**: ~1.08M tokens (33% total reduction)

---

### Phase C: Coverage & Rules (1 day)

**Coverage Aggregation** (`coverage-collector.js:55-86`):
```javascript
export function summarizeCoverageData(result) {
  const fileSummaries = Object.entries(result).map(([url, data]) => {
    // Aggregate stats only
    const totalBytes = data.totalBytes || 0;
    const preLcpBytes = data.preLcpBytes || 0;
    const unusedBytes = data.unusedBytes || 0;

    // Top 3 opportunities (largest unused sections)
    const opportunities = Object.entries(data)
      .filter(([key]) => !key.startsWith('_'))  // Skip metadata
      .filter(([, value]) => value === 'not-used')
      .map(([funcName]) => ({func: funcName, bytes: estimateFunctionSize(funcName, data)}))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 3);

    return {
      url,
      totalBytes,
      preLcpBytes,
      preLcpPercent: (preLcpBytes / totalBytes * 100).toFixed(1),
      unusedBytes,
      unusedPercent: (unusedBytes / totalBytes * 100).toFixed(1),
      topOpportunities: opportunities
    };
  });

  return {
    files: fileSummaries,
    totalUnused: fileSummaries.reduce((sum, f) => sum + f.unusedBytes, 0),
    totalSize: fileSummaries.reduce((sum, f) => sum + f.totalBytes, 0)
  };
}
```

**Expected Savings**: ~550K tokens (17% total reduction)

---

## Testing Strategy

### 1. Baseline Measurement
```bash
# Current state
node index.js --action agent --url https://www.krisshop.com/en --device mobile --skip-cache

# Record:
# - Total tokens per data source
# - Total execution time
# - Number of findings generated
# - Quality metrics
```

### 2. Incremental Testing

Test each optimization phase separately:

**Phase A Test**:
```bash
# After perf entries + HTML + rules optimization
node index.js --action agent --url https://www.krisshop.com/en --device mobile --skip-cache

# Verify:
# - Token reduction matches estimate (~1.3M saved)
# - Findings quality unchanged (same # of findings)
# - No rate limit errors
```

**Phase B Test**:
```bash
# After code optimization
# Verify code review agent still identifies issues
```

### 3. Quality Validation

Compare before/after on 5-10 test URLs:
- Total findings count (should be ±10%)
- Root cause identification (should be unchanged)
- Average confidence (should be unchanged or higher)
- False positive rate (manual review of sample)

---

## Risk Assessment

### Low Risk (Phase A)
- Performance entries: Only removing redundant HTML
- HTML extraction: Only extracting relevant sections
- Rules formatting: Only changing output format

**Mitigation**: Full HTML still available in cache if needed

### Medium Risk (Phase B)
- Code analysis: Removing source code entirely

**Mitigation**:
- Agents can request specific files if needed
- Coverage + HAR data provides equivalent information
- Test thoroughly on diverse sites

---

## Expected Outcomes

### Token Reduction
- **Before**: 3.27M tokens → 6-7 minute execution, 3 agent failures
- **After**: 0.57M tokens → 2-3 minute execution, 0 failures

### Rate Limiting
- **Before**: 429 errors even with BATCH_SIZE=1, DELAY=10s
- **After**: Can use BATCH_SIZE=3, DELAY=2s (default) without errors

### Cost Reduction
- **Vertex AI**: ~80% reduction in API costs
- **Execution Time**: ~50% faster (less data to process)

### Quality Impact
- **Findings Count**: Unchanged (±5%)
- **Confidence Scores**: Slightly higher (less noise in data)
- **Root Cause Accuracy**: Unchanged or improved (more focused analysis)

---

## Conclusion

The CWV agent is sending **3x more data than necessary** because:
1. Full HTML instead of CWV-relevant extracts
2. Complete source code instead of metrics
3. Prettified markup in rule failures
4. Per-function coverage instead of file summaries

**Recommended Action**: Implement Phase A (Quick Wins) first to immediately reduce tokens by 40% and eliminate rate limiting issues. Then proceed to Phase B if code review quality remains high with metrics-only approach.

---

**Date**: January 26, 2026
**Analysis By**: Explore Agent (ab0a9a6)
**Test Case**: www.krisshop.com/en (mobile)
**Current Token Count**: 3,270,516
**Optimized Target**: 570,000 (82% reduction)
