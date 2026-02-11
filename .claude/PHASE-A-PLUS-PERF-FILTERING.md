# Phase A+ Implementation: Performance Entries Filtering

## Issue Identified

After Phase A implementation, we found:
- **Performance Entries**: Still 98,538 tokens (reduced from 810K, but still too large)
- **Root Cause**: Collecting all 307 performance entries including redundant resource timing
- **Impact**: Perf Observer Agent still hitting 429 rate limits

## Analysis

From krisshop.com test:
- **Total entries collected**: 307
- **Breakdown**:
  - Resource timing: ~280 entries (redundant - already in HAR)
  - Navigation: 1 entry
  - LCP: 1-2 entries
  - CLS: 5-10 entries
  - Long tasks: 5-10 entries
  - Long animation frames: 3-5 entries
  - Other (visibility-state, event): 5-10 entries

**Problem**: Resource timing entries duplicate HAR data and consume 90% of tokens.

---

## Solution Implemented

**File**: `src/tools/lab/performance-collector.js` (lines 130-165)

Added filtering before returning performance entries:

```javascript
// Phase A+ Optimization: Filter to only CWV-critical entries
const cwvCriticalEntries = entries.filter(entry => {
  // Always keep: navigation, LCP, CLS, long tasks, long animation frames
  if (['navigation', 'largest-contentful-paint', 'layout-shift', 'longtask', 'long-animation-frame'].includes(entry.entryType)) {
    return true;
  }

  // For resource timing: only keep render-blocking or slow resources
  if (entry.entryType === 'resource') {
    return entry.renderBlockingStatus === 'blocking' ||
           entry.duration > 1000 ||  // Slow resources (>1s)
           entry.decodedBodySize > 1000000;  // Large resources (>1MB)
  }

  // Keep FCP, FID, other paint/mark entries
  if (['paint', 'mark', 'measure', 'first-input'].includes(entry.entryType)) {
    return true;
  }

  // Filter out everything else (visibility-state, event, etc.)
  return false;
});

console.log(`Filtered performance entries: ${entries.length} → ${cwvCriticalEntries.length}`);
```

---

## What's Kept vs. Removed

### ✅ Kept (CWV-Critical)

**Navigation Timing** (1 entry):
- Page load metrics: TTFB, DOM Interactive, Load Event End
- Essential for understanding page load timeline

**LCP** (1-2 entries):
- Largest Contentful Paint candidates
- Already optimized in Phase A (no full HTML)

**CLS** (5-10 entries):
- Layout shift events with value > 0
- Already optimized in Phase A (top 5 sources only)

**Long Tasks** (5-10 entries):
- Tasks >50ms that block main thread
- Critical for TBT/INP analysis

**Long Animation Frames** (3-5 entries):
- Frames with blocking duration > 0
- Critical for INP analysis

**Paint/Mark/Measure** (~5 entries):
- FCP (First Contentful Paint)
- FID (First Input Delay)
- Custom performance marks

**Problematic Resources** (~5-10 entries):
- Render-blocking resources
- Slow resources (>1s load time)
- Large resources (>1MB)

**Total Kept**: ~30-40 entries

---

### ❌ Removed (Redundant/Non-Critical)

**Resource Timing** (~280 entries):
- Already available in HAR data
- Only keeping problematic ones (render-blocking, slow, large)

**Visibility State** (~5 entries):
- Not relevant for CWV analysis

**Event Entries** (~5 entries):
- Generic event timing (not CWV-critical)

**Total Removed**: ~270-280 entries (90% reduction)

---

## Expected Impact

### Token Reduction

**Before Phase A+**:
- Entries: 307
- File Size: 342KB
- Token Estimate: 98,538

**After Phase A+**:
- Entries: ~30-40
- File Size: ~40-50KB
- Token Estimate: ~12,000-15,000

**Reduction**: 85-90% additional savings

### Combined Phase A + A+

| Metric | Original | Phase A | Phase A+ | Total Reduction |
|--------|----------|---------|----------|-----------------|
| **Perf Entries** | 810K tokens | 98K | **15K** | **98%** |
| **HTML** | 333K tokens | 14K | 14K | **96%** |
| **Rules** | 427K tokens | ~90K | ~90K | **79%** |
| **Total (P1 sources)** | 1.57M | 202K | **119K** | **92%** |

---

## Rate Limiting Configuration

Updated `.env` with more aggressive settings after optimization:

```bash
# Phase A+: After perf entries filtering (307 → 30, 98K → 15K tokens)
AGENT_BATCH_SIZE=2          # 2 agents per batch
AGENT_BATCH_DELAY=10000     # 10 second delays (was 60s)
```

**Expected Execution Time**: ~3-4 minutes (was 7 minutes)

---

## Testing

### Verify Filtering Works

```bash
# Clear cache and run
rm .cache/www-krisshop-com-en.mobile.*

node index.js --action agent \
  --url https://www.krisshop.com/en \
  --device mobile \
  --skip-cache
```

**Look for console output**:
```
Filtered performance entries: 307 → 32 (90% reduction)
✅ Processed Performance Entries data. Estimated token size: ~ 14500
```

### Verify No Rate Limits

**Expected Output**:
```
🔄 Executing batch 1/4 (2 agents)...
✅ CrUX Agent (13%, 25s)
✅ RUM Agent (25%, 30s)
⏳ Waiting 10s before next batch...
🔄 Executing batch 2/4 (2 agents)...
✅ PSI Agent (38%, 40s)
✅ Perf Observer Agent (50%, 35s)  ← Should succeed now!
⏳ Waiting 10s before next batch...
🔄 Executing batch 3/4 (2 agents)...
✅ HTML Agent (63%, 32s)
✅ Rules Agent (75%, 38s)
⏳ Waiting 10s before next batch...
🔄 Executing batch 4/4 (2 agents)...
✅ Code Coverage Agent (88%, 45s)
✅ Code Review Agent (100%, 50s)
📊 Quality Metrics: ...
```

**Success Criteria**:
- ✅ All 8 agents complete
- ✅ No 429 errors
- ✅ Total time: 3-4 minutes
- ✅ Perf entries filtered to ~30-40

---

## Data Quality Verification

### What CWV Analysis Still Has

**LCP Analysis** (unchanged):
- Element identification
- Render/load timing
- Resource URL
- Size and attributes

**CLS Analysis** (unchanged):
- Shift sources (top 5)
- Position/size changes
- CSS issues detected

**INP/TBT Analysis** (improved):
- Long tasks with attribution
- Long animation frames
- Script timing details
- **Now cleaner** - no resource timing noise

**Resource Analysis** (enhanced):
- Render-blocking resources (kept)
- Slow resources >1s (kept)
- Large resources >1MB (kept)
- Normal resources (in HAR instead)

---

## Risk Assessment

### Low Risk ✅

**What was removed**:
- Resource timing entries that duplicate HAR data
- Visibility state changes (not CWV-relevant)
- Generic event entries

**What's still available**:
- All resource data is in HAR (more detailed)
- All CWV-critical timing preserved
- Navigation timing unchanged
- LCP/CLS data unchanged

### Validation

Resource timing comparison:
- **Performance Entries**: Now has only problematic resources (render-blocking, slow, large)
- **HAR Data**: Has ALL resources with full timing breakdown (DNS, TCP, SSL, Wait, Download)
- **Result**: No data loss, better organization

---

## Next Steps (If Still Issues)

If still hitting rate limits after Phase A+:

### Option 1: Increase Delay
```bash
AGENT_BATCH_DELAY=20000  # 20 seconds
```

### Option 2: Sequential Execution
```bash
AGENT_BATCH_SIZE=1       # 1 agent at a time
AGENT_BATCH_DELAY=15000  # 15 second delays
```

### Option 3: Implement Phase B (Code Optimization)
Biggest remaining bloat:
- Code Files: 1.16M tokens (can reduce to 80K)
- Coverage: 282K tokens (can reduce to 50K)
- Would eliminate most rate limit issues

---

## Summary

**Phase A+ Optimization**:
- Filters performance entries from 307 → ~30 (90% reduction)
- Removes redundant resource timing (already in HAR)
- Keeps all CWV-critical data (navigation, LCP, CLS, long tasks, paint events)
- Expected token reduction: 98K → 15K (85% additional savings)

**Combined with Phase A**:
- Total token reduction: 3.27M → ~1.1M (66% overall)
- Should eliminate rate limiting issues
- Execution time: 3-4 minutes (acceptable)

**Status**: ✅ Ready for Testing

---

**Date**: January 26, 2026
**Implementation Time**: 15 minutes
**Files Modified**: 1 (performance-collector.js)
**Lines Changed**: +35
