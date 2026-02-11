# Priority 1 & 2 Data Integration Status

**Date**: January 28, 2026
**Status**: ✅ **FULLY WIRED** - Data flows from collectors to agents

**Last Updated**: January 28, 2026 (implementation completed)

---

## Executive Summary

Priority 1 (Third-Party Script Attribution) and Priority 2 (CSS-to-CLS Attribution) data collectors are **implemented and collecting data**, but the data is **NOT being passed to agents** for use in generating suggestions.

**Impact**: Agents cannot generate specific recommendations using the new detailed data because they never receive it.

---

## Data Flow Analysis

### ✅ What's Working

1. **Data Collection** (src/tools/lab/index.js)
   - `analyzeThirdPartyScripts()` successfully collects third-party analysis
   - `attributeCLStoCSS()` successfully collects CLS attribution
   - Both are cached to disk correctly

2. **Data Storage** (src/core/multi-agents.js)
   - `getLabData()` returns `thirdPartyAnalysis` and `clsAttribution`
   - Both fields added to `pageData` object (lines 1045-1046)

### ❌ What's Missing

**The agents never receive this data in their prompts!**

**Current Agent Data Flow**:
```
pageData object → Summary functions → Agent prompts
    ↓                     ↓                 ↓
thirdPartyAnalysis   (NOT USED)      harSummaryStep()
clsAttribution       (NOT USED)      perfSummaryStep()
```

**Problem**: The summary functions (`summarizeHAR()`, `summarizePerformanceEntries()`) don't include the new Priority 1 & 2 data, so agents never see it.

---

## Detailed Gap Analysis

### Priority 1: Third-Party Script Attribution

**Collected Data** (src/tools/lab/third-party-attributor.js):
```javascript
{
  scripts: [
    {
      url, domain, category,  // 10 categories: analytics, advertising, social, etc.
      network: { wait, download, total },
      execution: { totalTime, mainThreadTime },
      initiator: { url, type, lineNumber },
      isRenderBlocking,
      longTaskAttribution: [...]
    }
  ],
  byCategory: { analytics: [...], advertising: [...] },
  categoryImpact: [
    { category: 'analytics', executionTime: 450, scripts: 3 }
  ],
  summary: {
    totalScripts, totalTransferSize, totalNetworkTime,
    totalExecutionTime, totalBlockingTime, renderBlockingCount
  }
}
```

**How Agents Currently Receive HAR Data**:
```javascript
// Line 681 in multi-agents.js
steps.push({
  name: 'HAR Agent',
  sys: harAgentPrompt(cms),
  hum: harSummaryStep(harSummary)  // ❌ harSummary doesn't include thirdPartyAnalysis
});
```

**What `summarizeHAR()` Returns** (src/tools/lab/har-collector.js:15-33):
- Large transfers (generic, no categorization)
- Long blocking times (no third-party attribution)
- Long TTFB
- Deprioritized resources
- Timing breakdown
- HTTP/1 resources
- Redirects
- Server headers
- Per-domain summary (basic, no categories or execution time)

**Missing from Agent**:
- Third-party script categories (analytics, ads, social)
- Per-category execution time and impact
- Initiator chains (which script loaded which script)
- Long task attribution to specific third-party scripts

---

### Priority 2: CSS-to-CLS Attribution

**Collected Data** (src/tools/lab/cls-attributor.js):
```javascript
{
  totalShifts: 5,
  totalCLS: 0.28,
  byType: {
    'font-swap': {
      count: 2,
      totalCLS: 0.15,
      shifts: [...]
    },
    'unsized-media': {
      count: 2,
      totalCLS: 0.10,
      shifts: [...]
    }
  },
  topIssues: [
    {
      value: 0.15,
      element: 'body > h1',
      cause: {
        type: 'font-swap',
        description: 'Font swap caused height change without width change',
        recommendation: 'Use font-display: optional or size-adjust fallback',
        cssProperty: 'font-family: Proximanova',
        priority: 'High'
      },
      stylesheet: {
        href: '/styles/fonts.css',
        selector: 'h1',
        property: 'font-family',
        value: 'Proximanova'
      }
    }
  ]
}
```

**How Agents Currently Receive Perf Data**:
```javascript
// Line 674 in multi-agents.js
steps.push({
  name: 'Perf Observer Agent',
  sys: perfObserverAgentPrompt(cms),
  hum: perfSummaryStep(perfEntriesSummary)  // ❌ perfEntriesSummary doesn't include clsAttribution
});
```

**What `summarizePerformanceEntries()` Returns** (src/tools/lab/performance-collector.js:168-248):
- Navigation timing (basic)
- LCP entries (element, timing)
- Long tasks (duration, blocking time)
- Long animation frames
- Layout shifts (value, hadRecentInput) - **BUT NO CSS ATTRIBUTION**
- Resource timing issues

**Missing from Agent**:
- CSS property causing each shift (font-family, width, height, etc.)
- Stylesheet location (which CSS file has the problematic rule)
- Shift type classification (font-swap, content-insertion, unsized-media, animation)
- Specific element selectors affected
- Recommendation per shift type

---

## Required Fixes

### Option 1: Enhance Summary Functions (Recommended)

**Modify** `src/tools/lab/har-collector.js`:
```javascript
export function summarizeHAR(harData, deviceType, thirdPartyAnalysis = null) {
  // ... existing code ...

  // NEW: Add third-party attribution section
  if (thirdPartyAnalysis?.summary) {
    report += '\n**Third-Party Script Analysis:**\n\n';
    report += `* Total Scripts: ${thirdPartyAnalysis.summary.totalScripts}\n`;
    report += `* Total Execution Time: ${thirdPartyAnalysis.summary.totalExecutionTime}ms\n`;
    report += `* Render-Blocking: ${thirdPartyAnalysis.summary.renderBlockingCount}\n\n`;

    if (thirdPartyAnalysis.categoryImpact.length > 0) {
      report += '**By Category:**\n';
      thirdPartyAnalysis.categoryImpact.slice(0, 5).forEach(cat => {
        report += `* ${cat.category}: ${cat.scripts} scripts, ${cat.executionTime}ms execution\n`;
      });
    }
  }

  return report;
}
```

**Modify** `src/tools/lab/performance-collector.js`:
```javascript
export function summarizePerformanceEntries(performanceEntries, deviceType, maxTokens = null, clsAttribution = null) {
  // ... existing code ...

  // ENHANCE: Layout shifts section with CSS attribution
  const significantLayoutShifts = entriesByType['layout-shift']?.filter(entry => entry.value > 0.1) || [];
  if (significantLayoutShifts.length > 0 || clsAttribution?.summary) {
    markdownOutput += `## Significant Layout Shifts\n\n`;

    // NEW: Include CSS attribution if available
    if (clsAttribution?.summary) {
      markdownOutput += `**Total CLS**: ${clsAttribution.summary.totalCLS.toFixed(3)}\n\n`;

      if (clsAttribution.summary.byType) {
        markdownOutput += '**CLS by Type:**\n';
        Object.entries(clsAttribution.summary.byType).forEach(([type, data]) => {
          markdownOutput += `* ${type}: ${data.count} shifts, CLS ${data.totalCLS.toFixed(3)}\n`;
        });
        markdownOutput += '\n';
      }

      if (clsAttribution.summary.topIssues?.length > 0) {
        markdownOutput += '**Top CLS Issues (with CSS Attribution):**\n';
        clsAttribution.summary.topIssues.slice(0, 5).forEach((issue, i) => {
          markdownOutput += `${i+1}. **Element**: ${issue.element}\n`;
          markdownOutput += `   - **Value**: ${issue.value.toFixed(3)}\n`;
          markdownOutput += `   - **Cause**: ${issue.cause.description}\n`;
          markdownOutput += `   - **CSS**: ${issue.stylesheet?.property}: ${issue.stylesheet?.value}\n`;
          markdownOutput += `   - **File**: ${issue.stylesheet?.href || 'inline'}\n`;
          markdownOutput += `   - **Recommendation**: ${issue.cause.recommendation}\n\n`;
        });
      }
    } else {
      // Fallback to old format
      significantLayoutShifts
        .sort((a, b) => b.value - a.value)
        .forEach(entry => {
          markdownOutput += formatLayoutShiftEntry(entry);
        });
    }
  }

  return markdownOutput;
}
```

**Update Calls** in `src/core/multi-agents.js`:
```javascript
// Line 681 - Pass thirdPartyAnalysis to HAR summary
const harSummaryText = summarizeHAR(pageData.har, deviceType, pageData.thirdPartyAnalysis);
steps.push({
  name: 'HAR Agent',
  sys: harAgentPrompt(cms),
  hum: harSummaryStep(harSummaryText)
});

// Line 674 - Pass clsAttribution to perf summary
const perfSummaryText = summarizePerformanceEntries(
  pageData.perfEntries,
  deviceType,
  null,  // maxTokens
  pageData.clsAttribution  // NEW
);
steps.push({
  name: 'Perf Observer Agent',
  sys: perfObserverAgentPrompt(cms),
  hum: perfSummaryStep(perfSummaryText)
});
```

---

### Option 2: Add Dedicated Agent Steps (Alternative)

Create dedicated steps for Priority 1 & 2 data:

**New Prompt Functions** in `src/prompts/analysis.js`:
```javascript
export const thirdPartyStep = (thirdPartyAnalysis) => `
${stepVerbose()} here is the detailed third-party script analysis:

${JSON.stringify(thirdPartyAnalysis, null, 2)}
`;

export const clsAttributionStep = (clsAttribution) => `
${stepVerbose()} here is the CSS-to-CLS attribution analysis:

${JSON.stringify(clsAttribution, null, 2)}
`;
```

**Update Agent Invocations** in `src/core/multi-agents.js`:
```javascript
// After HAR agent
if (pageData.thirdPartyAnalysis) {
  steps.push({
    name: 'HAR Agent',
    sys: harAgentPrompt(cms),
    hum: harSummaryStep(harSummary) + '\n\n' + thirdPartyStep(pageData.thirdPartyAnalysis)
  });
}

// After Perf Observer agent
if (pageData.clsAttribution) {
  steps.push({
    name: 'Perf Observer Agent',
    sys: perfObserverAgentPrompt(cms),
    hum: perfSummaryStep(perfEntriesSummary) + '\n\n' + clsAttributionStep(pageData.clsAttribution)
  });
}
```

---

### Option 3: Update PHASE_FOCUS Prompts (Complementary)

**Enhance** `src/prompts/shared.js` PHASE_FOCUS.HAR to mention third-party analysis:
```javascript
HAR: (n) => `### Step ${n}: HAR File Analysis
- Examine network waterfall for resource loading sequence and timing
- Identify critical path resources that block rendering
- **PRIORITY 1: Analyze third-party script attribution by category (analytics, ads, social, etc.)**
  * Use thirdPartyAnalysis.categoryImpact to identify high-impact categories
  * Cite specific scripts with execution times from thirdPartyAnalysis.scripts
  * Reference initiator chains to understand loading dependencies
  * Identify render-blocking third-party scripts
- Analyze request/response headers for optimization opportunities
- Identify connection setup overhead (DNS, TCP, TLS) for key domains
- ...
`,
```

**Enhance** `src/prompts/shared.js` PHASE_FOCUS.PERF_OBSERVER to mention CLS attribution:
```javascript
PERF_OBSERVER: (n) => `### Step ${n}: Performance Observer Analysis
- Analyze performance entries captured during page load simulation
- Examine largest-contentful-paint entries to identify LCP candidates
- **PRIORITY 2: Analyze layout-shift entries with CSS attribution**
  * Use clsAttribution.byType to identify shift categories (font-swap, unsized-media, etc.)
  * Reference clsAttribution.topIssues for specific elements and CSS properties
  * Include stylesheet locations from clsAttribution data
  * Cite specific CSS rules causing shifts
- Identify longtask entries that contribute to high TBT/INP
- ...
`,
```

---

## Recommendation

**Implement Option 1 + Option 3**:
1. Enhance summary functions to include Priority 1 & 2 data (Option 1)
2. Update PHASE_FOCUS prompts to explicitly guide agents (Option 3)

**Why this approach**:
- ✅ Minimal code changes (2 files modified)
- ✅ Data flows naturally through existing pipeline
- ✅ Agents receive formatted, actionable summaries
- ✅ No architectural changes needed
- ✅ Backward compatible (works if data unavailable)

**Avoid Option 2**: Adding separate steps would lengthen prompts unnecessarily and duplicate data already in summaries.

---

## Files to Modify

| File | Changes | Complexity |
|------|---------|------------|
| `src/tools/lab/har-collector.js` | Add third-party section to `summarizeHAR()` | Easy |
| `src/tools/lab/performance-collector.js` | Add CLS attribution to `summarizePerformanceEntries()` | Medium |
| `src/core/multi-agents.js` | Pass new parameters to summary functions | Easy |
| `src/prompts/shared.js` | Update PHASE_FOCUS.HAR and PHASE_FOCUS.PERF_OBSERVER | Easy |

**Total Effort**: ~2-3 hours

---

## Testing Plan

After implementation:

1. **Run with test URL**:
   ```bash
   node index.js --url "https://www.qualcomm.com" --device mobile --skip-cache
   ```

2. **Verify summaries include new data**:
   - Check HAR summary includes "Third-Party Script Analysis" section
   - Check Perf summary includes "CLS by Type" and "Top CLS Issues (with CSS Attribution)"

3. **Verify agents use new data**:
   - Check agent findings reference third-party categories (e.g., "analytics scripts")
   - Check agent findings cite CSS properties and stylesheets for CLS issues

4. **Verify suggestions are more specific**:
   - Before: "Defer third-party scripts" (generic)
   - After: "Defer analytics scripts (Google Analytics: 280ms)" (specific)
   - Before: "Fix layout shifts" (generic)
   - After: "Use font-display: optional for Proximanova in fonts.css" (specific)

---

## Success Criteria

✅ **Data Wired Correctly**:
- [ ] `summarizeHAR()` includes thirdPartyAnalysis
- [ ] `summarizePerformanceEntries()` includes clsAttribution
- [ ] Summary functions called with new parameters
- [ ] PHASE_FOCUS prompts updated

✅ **Agents Receive Data**:
- [ ] HAR Agent prompt contains "Third-Party Script Analysis" section
- [ ] Perf Observer Agent prompt contains "CLS by Type" section
- [ ] Agent findings reference specific categories and CSS properties

✅ **Suggestions Improved**:
- [ ] Third-party suggestions cite categories (analytics, ads, etc.)
- [ ] CLS suggestions cite specific CSS properties and files
- [ ] Impact estimates reference execution times from thirdPartyAnalysis
- [ ] CLS recommendations reference shift types from clsAttribution

---

## Next Steps

1. Implement Option 1 changes (enhance summary functions)
2. Implement Option 3 changes (update PHASE_FOCUS)
3. Test with qualcomm.com (known third-party and CLS issues)
4. Verify agent findings are more specific
5. Update DATA-COLLECTION-IMPLEMENTATION.md with final status


---

## ✅ IMPLEMENTATION COMPLETED

**Date**: January 28, 2026

### Changes Made

#### 1. Enhanced Summary Functions

**src/tools/lab/har-collector.js**:
- Modified `summarizeHAR()` signature: added `thirdPartyAnalysis` parameter
- Added "Third-Party Script Analysis (Priority 1 Data)" section to output
- Includes: total scripts, transfer size, network time, execution time, blocking time
- Includes: by-category breakdown sorted by execution time (top 8 categories)
- Includes: top 5 scripts by execution time with long task attribution

**src/tools/lab/performance-collector.js**:
- Modified `summarizePerformanceEntries()` signature: added `clsAttribution` parameter
- Enhanced "Significant Layout Shifts" section with CSS attribution
- Includes: total CLS and shift count
- Includes: "CLS by Type" breakdown (font-swap, unsized-media, content-insertion, animation)
- Includes: "Top CLS Issues (with CSS Attribution)" with 8 detailed issues
- Each issue includes: element selector, CLS value, shift type, CSS property/value, stylesheet location, recommendation, priority

#### 2. Wired Data Flow

**src/tools/lab/index.js**:
- Line 277-278: Load cached `thirdPartyAnalysis` and `clsAttribution` data
- Line 288-297: Early return (cache hit) - pass Priority 1 & 2 data to summary functions
- Line 415-419: Normal path - pass Priority 1 & 2 data to summary functions after collection

**Before**:
```javascript
let perfEntriesSummary = summarizePerformanceEntries(perfEntries, deviceType);
const harSummary = summarizeHAR(harFile, deviceType);
```

**After**:
```javascript
let perfEntriesSummary = summarizePerformanceEntries(perfEntries, deviceType, null, clsAttribution);
const harSummary = summarizeHAR(harFile, deviceType, thirdPartyAnalysis);
```

#### 3. Updated Agent Prompts

**src/prompts/shared.js - PHASE_FOCUS.HAR**:
- Added "PRIORITY 1: Use Third-Party Script Analysis" section
- Explicit instructions to cite categories, execution times, domains
- Example: "analytics category: 3 scripts, 450ms execution (Google Analytics: 280ms)"

**src/prompts/shared.js - PHASE_FOCUS.PERF_OBSERVER**:
- Added "PRIORITY 2: Use CSS-to-CLS Attribution" section
- Explicit instructions to use shift type breakdown and top issues list
- Instructions to cite CSS properties, stylesheet locations, element selectors
- Example: "Element 'body > h1' has 0.15 CLS due to font-family: Proximanova in /styles/fonts.css (font-swap type)"

### Files Modified

| File | Lines Changed | Type |
|------|---------------|------|
| `src/tools/lab/har-collector.js` | +47 | Enhanced summary function |
| `src/tools/lab/performance-collector.js` | +42 | Enhanced summary function |
| `src/tools/lab/index.js` | +7 | Wired data flow |
| `src/prompts/shared.js` | +18 | Updated agent guidance |

**Total**: 4 files, ~114 lines added

### Data Flow Diagram (Updated)

```
Data Collection
  ├─ analyzeThirdPartyScripts() → thirdPartyAnalysis
  ├─ attributeCLStoCSS() → clsAttribution
  └─ Cached to disk

Summary Generation
  ├─ summarizeHAR(har, deviceType, thirdPartyAnalysis) → harSummary ✅
  └─ summarizePerformanceEntries(perf, deviceType, null, clsAttribution) → perfEntriesSummary ✅

Agent Invocation
  ├─ HAR Agent receives harSummary (with Priority 1 data) ✅
  ├─ Perf Observer Agent receives perfEntriesSummary (with Priority 2 data) ✅
  └─ PHASE_FOCUS prompts guide agents to use new data ✅

Agent Analysis
  ├─ HAR Agent cites third-party categories and execution times
  └─ Perf Observer Agent cites CSS properties and stylesheet locations

Final Suggestions
  ├─ Third-party suggestions are specific (category, domain, timing)
  └─ CLS suggestions are specific (CSS property, file, element)
```

### Testing Checklist

Run with a test URL to verify:

```bash
node index.js --url "https://www.qualcomm.com" --device mobile --skip-cache
```

**Verify Summaries**:
- [ ] HAR summary includes "Third-Party Script Analysis (Priority 1 Data)" section
- [ ] Perf summary includes "CLS by Type (Priority 2 Data)" section
- [ ] Third-party categories listed with execution times
- [ ] CLS issues list CSS properties and stylesheets

**Verify Agent Findings**:
- [ ] HAR Agent references specific third-party categories (e.g., "analytics")
- [ ] HAR Agent cites execution times per category
- [ ] Perf Observer Agent references CSS properties causing shifts
- [ ] Perf Observer Agent cites stylesheet locations

**Verify Suggestions**:
- [ ] Third-party suggestions cite specific scripts (e.g., "Google Analytics: 280ms")
- [ ] CLS suggestions cite CSS properties (e.g., "font-family: Proximanova in /styles/fonts.css")
- [ ] Impact estimates use data from Priority 1 & 2 collectors
- [ ] Suggestions are more specific than before

### Expected Improvements

**Before Implementation**:
- Generic: "Defer third-party scripts"
- Generic: "Fix layout shifts"
- No specific attribution

**After Implementation**:
- Specific: "Defer analytics scripts (3 scripts, 450ms execution): Google Analytics (280ms), Adobe Analytics (120ms)"
- Specific: "Use font-display: optional for Proximanova font in /styles/fonts.css to prevent 0.15 CLS on 'body > h1' element (font-swap type)"
- Full attribution with files, properties, timings, categories

### Backward Compatibility

✅ **Fully backward compatible**:
- Summary functions have default `null` for new parameters
- If Priority 1 & 2 data unavailable, functions work as before
- No breaking changes to existing code
- Cache keys remain the same

### Status: COMPLETE ✅

All components wired, data flows from collectors through summaries to agents.
Ready for testing with real URLs.

