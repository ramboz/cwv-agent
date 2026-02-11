# Cleanup: Removed Unused INP Interaction Collector

## Summary
Removed 381 lines of unused code related to synthetic INP interaction testing that was never integrated into the data collection pipeline.

## Rationale

### Why Remove?
1. **Never Used** - Not imported or called anywhere in the codebase
2. **Synthetic INP is Unreliable** - Lab tests can't measure real user interactions accurately
3. **Better Data Sources Available** - RUM and CrUX provide real field data
4. **Maintenance Burden** - 381 lines of dead code to maintain

### Why Synthetic INP Testing Doesn't Work
- Lab tests run in controlled, empty browser contexts
- No real user variability (network, device performance, multitasking)
- No real user interaction patterns
- Google explicitly states: "INP can only be measured in the field"
- Puppeteer clicking buttons ≠ real users with slow devices/networks

### What We Keep (Better Sources)
✅ **CrUX (Chrome UX Report)** - Real field data from Chrome users
✅ **RUM (Real User Monitoring)** - Actual user interactions with full context
✅ **Agent Awareness** - Agents understand INP thresholds and optimization strategies

## Files Deleted

### 1. `src/tools/lab/interaction-collector.js` (381 lines)
- InteractionCollector class extending LabDataCollector
- 38 interaction targets (nav, buttons, forms, etc.)
- PerformanceObserver-based measurement
- Synthetic interaction simulation with Puppeteer
- Full implementation that was never used

## Files Modified

### 1. `src/prompts/analysis.js`
**Removed:**
- `inpInteractionStep()` function (10 lines)
- `inpInteractionAgentPrompt()` function (73 lines)

**Total removed:** 83 lines of unused prompt functions

### 2. `src/prompts/index.js`
**Removed exports:**
- `inpInteractionStep` (2 occurrences - import and export)
- `inpInteractionAgentPrompt` (2 occurrences - import and export)

**Total removed:** 4 lines

## Total Cleanup

- **Files Deleted:** 1 (381 lines)
- **Lines Removed from Existing Files:** 87 lines
- **Total Dead Code Eliminated:** 468 lines
- **References Cleaned:** 6 (imports, exports, unused functions)

## Verification

### INP Data Flow (Unchanged - Still Working)

1. **CrUX Collection** ✅
   - `src/tools/crux.js` line 32: Collects `interaction_to_next_paint` p75
   - Proper thresholds (200ms good, 500ms needs improvement)
   - Status display (Good/Needs Improvement/Poor)

2. **RUM Collection** ✅
   - `src/tools/rum.js` lines 103-111: Real user INP from bundles
   - P75 calculation from actual interactions
   - Interaction type breakdown
   - Top slow interactions
   - Fallback to CrUX via `extractCrUXINP()`

3. **Agent Knowledge** ✅
   - System prompts mention INP threshold (under 200ms)
   - Analysis prompts reference INP optimization
   - Action prompts include INP causality examples
   - All agents aware of INP in performance analysis

### Testing
```bash
# Verify no broken imports
node index.js --action agent --url https://www.adobe.com --device mobile --skip-cache

# Expected: Should work normally with INP data from CrUX/RUM
```

## Impact Assessment

### Positive Impacts ✅
1. **Simpler Codebase** - 468 fewer lines to maintain
2. **Less Confusion** - Clear that INP comes from field data only
3. **Focus on Quality** - Prioritize improving RUM coverage instead
4. **Reduced Complexity** - One less collector to test and debug

### No Negative Impacts ❌
- INP measurement still works via CrUX and RUM
- Agent analysis unchanged - still optimizes for INP
- No features lost - synthetic testing was never used
- No breaking changes - nothing depended on this code

## Recommendation: ✅ Approved

This cleanup eliminates dead code that:
- Was never integrated
- Wouldn't provide reliable data anyway
- Adds complexity without value
- Can be re-implemented if truly needed (YAGNI)

The real INP data sources (CrUX, RUM) remain fully functional and provide superior signal quality compared to synthetic testing.

---

**Date:** January 30, 2026
**Status:** Complete
**Impact:** Low risk, high value cleanup
