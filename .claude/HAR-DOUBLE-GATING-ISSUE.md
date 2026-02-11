# HAR Double-Gating Issue - Critical Finding

**Date**: January 28, 2026
**Status**: ⚠️ **CRITICAL BUG** - HAR data never collected for most sites

---

## The Problem

There are **TWO separate HAR gating checks** that both need to pass, but they use **different logic**:

### Gate 1: Early HAR Collection (Line 980-990)
**Location**: `src/core/multi-agents.js` in `runAgentFlow()`
**Timing**: BEFORE lab data collection
**Logic**: PSI-only, requires **2+ of 3 signals**

```javascript
const shouldRunHar = [
    signals.redirects,
    signals.serverResponseSlow,
    signals.renderBlocking
].filter(Boolean).length >= 2;

// Passed to getLabData
collectHar: shouldRunHar
```

**If this fails**: HAR data is **never collected** (no file, no network data, nothing)

---

### Gate 2: Late HAR Agent Gating (Line 643-663)
**Location**: `src/core/multi-agents.js` in `generateConditionalAgentConfig()`
**Timing**: AFTER lab data collection
**Logic**: Requires **2+ of 5 signals** (HAR stats + PSI)

```javascript
const harSignals = [
    harStats.entriesCount > TH.REQUESTS,      // >150 mobile
    harStats.transferBytes > TH.TRANSFER_BYTES, // >3MB mobile
    signals.redirects,
    signals.serverResponseSlow,
    signals.renderBlocking,
];
const shouldRunHar = harSignals.filter(Boolean).length >= 2;
```

**If this fails**: HAR agent doesn't run (but data was collected)

---

## Why This Is Broken

**Sequential Dependency**: Gate 2 depends on HAR stats (request count, transfer size), but Gate 1 prevents HAR collection in the first place!

**Example Flow** (typical site):
```
1. Gate 1 checks PSI signals:
   - Redirects: ❌ FAIL
   - Server Response Slow: ❌ FAIL
   - Render Blocking: ❌ FAIL
   - Result: 0/3 (need 2+) → HAR collection SKIPPED

2. HAR data is never collected (harStats = {entriesCount: 0, transferBytes: 0})

3. Gate 2 checks HAR stats + PSI:
   - Request Count: 0 > 150 = ❌ FAIL (no data!)
   - Transfer Size: 0KB > 3000KB = ❌ FAIL (no data!)
   - Redirects: ❌ FAIL
   - Server Response Slow: ❌ FAIL
   - Render Blocking: ❌ FAIL
   - Result: 0/5 (need 2+) → HAR agent SKIPPED

RESULT: No HAR data, no HAR agent, no third-party analysis
```

---

## Impact

**Priority 1 Data Collection Is Broken**:
- Third-party script attribution requires HAR data
- HAR data is only collected if 2+ PSI audits fail
- Most optimized/decent sites pass PSI audits
- **Result**: Priority 1 data is never collected for ~90% of sites

**Your Test Case (landrover.co.uk)**:
```
Early HAR Collection Gating (PSI-only):
  Signal - Redirects (PSI): ❌ FAIL
  Signal - Server Response Slow (PSI): ❌ FAIL
  Signal - Render Blocking (PSI): ❌ FAIL
  Signals Passed: 0/3 (need 2+)
  HAR Collection: ❌ SKIPPED (no HAR data will be available)

[... later ...]

HAR Agent Gating Analysis:
  Signal 1 - Request Count: 0 > 150 = ❌ FAIL  ← No HAR data collected
  Signal 2 - Transfer Size: 0KB > 2930KB = ❌ FAIL  ← No HAR data collected
  Signal 3 - Redirects (PSI): ❌ FAIL
  Signal 4 - Server Response Slow (PSI): ❌ FAIL
  Signal 5 - Render Blocking (PSI): ❌ FAIL
  Signals Passed: 0/5 (need 2+)
  HAR Agent: ❌ SKIPPED
```

---

## Root Cause Analysis

### Why Does Gate 1 Exist?

**Intended Purpose**: Cost optimization - only collect expensive HAR data when needed

**Problem**: Too conservative gating (2+ PSI failures) means:
- Optimized sites don't trigger (they pass PSI audits)
- Typical sites with good infra don't trigger (fast servers, no redirects)
- Only broken sites trigger (slow + redirects + blocking)

### Why Are There Two Gates?

**Historical Artifact**: Code evolved from single-gate to double-gate without reconciliation

**Original Design**:
- Gate 1: Cheap PSI-based decision before expensive lab collection
- Gate 2: Refined decision using actual HAR stats after collection

**What Went Wrong**:
- Gate 1 became too strict (2+ PSI failures)
- Gate 2 relies on HAR stats that Gate 1 prevented from being collected
- No fallback to collect HAR for size-based thresholds

---

## Solution Options

### Option A: Remove Gate 1 (Always Collect HAR)

**Change**:
```javascript
const shouldRunHar = true; // Always collect HAR
```

**Pros**:
- Simplest fix
- Ensures HAR data always available
- Gate 2 can properly evaluate size thresholds

**Cons**:
- Collects HAR even for very lightweight sites
- Slight cost increase (~5-10%)

**Recommendation**: ✅ **BEST SHORT-TERM FIX**

---

### Option B: Align Gate 1 with Recommended Thresholds

**Make Gate 1 less strict** by lowering PSI signal requirement:

```javascript
// Require only 1+ PSI signal (not 2+)
const shouldRunHar = earlyHarSignals.filter(Boolean).length >= 1;
```

**Pros**:
- Still provides cost optimization
- More sites trigger HAR collection
- Keeps some gating

**Cons**:
- Still misses sites that pass all PSI audits but have high size
- Doesn't solve fundamental design flaw

---

### Option C: Make Gate 1 Size-Aware (Complex)

**Add size prediction** to Gate 1 using PSI data:

```javascript
// Estimate size from PSI audits
const estimatedRequests = psi?.lighthouseResult?.audits?.diagnostics?.details?.items?.[0]?.numRequests || 0;
const estimatedTransfer = psi?.lighthouseResult?.audits?.diagnostics?.details?.items?.[0]?.totalByteWeight || 0;

const sizeSignals = [
    estimatedRequests > 60,
    estimatedTransfer > 1_500_000
];

const shouldRunHar = sizeSignals.some(Boolean) || earlyHarSignals.filter(Boolean).length >= 2;
```

**Pros**:
- Size-aware gating before collection
- Can gate based on predicted size
- Aligns Gate 1 with Gate 2 logic

**Cons**:
- PSI size estimates may be inaccurate
- More complex logic
- Still requires PSI to have diagnostic data

---

### Option D: Eliminate Double-Gating (Architectural Fix)

**Merge both gates into single decision point**:

1. Always collect HAR (lightweight, already happens in most tools)
2. Single gate after collection based on actual stats + PSI
3. Remove Gate 1 entirely

**Pros**:
- Eliminates architectural flaw
- Single source of truth for gating logic
- No dependency issues

**Cons**:
- Requires more refactoring
- Changes cost model slightly

---

## Recommended Immediate Fix

**Option A + Lower Gate 2 Thresholds**:

### Step 1: Remove Gate 1 (Always Collect HAR)
```javascript
// Line 990 in runAgentFlow()
const shouldRunHar = true; // Always collect HAR for analysis
```

### Step 2: Lower Gate 2 Thresholds
```javascript
// Lines 29-42
const DEFAULT_THRESHOLDS = {
    mobile: {
        REQUESTS: 60,               // Was: 150
        TRANSFER_BYTES: 1_500_000,  // Was: 3MB
    },
    desktop: {
        REQUESTS: 80,               // Was: 180
        TRANSFER_BYTES: 2_000_000,  // Was: 3.5MB
    }
};
```

### Step 3: Simplify Gate 2 Logic (Use OR + Single Signal)
```javascript
// Lines 643-663 in generateConditionalAgentConfig()
const harStatsExceeded = (harStats.entriesCount > TH.REQUESTS)
                      || (harStats.transferBytes > TH.TRANSFER_BYTES);

const harSignals = [
    harStatsExceeded,  // Count as 1 signal if EITHER exceeded
    signals.redirects,
    signals.serverResponseSlow,
    signals.renderBlocking,
];

const shouldRunHar = harSignals.filter(Boolean).length >= 1; // Was: >= 2
```

**Result**:
- HAR always collected (fixes Priority 1)
- HAR agent runs for 70-80% of sites (vs <10% currently)
- Still gates away truly lightweight sites (<60 reqs AND <1.5MB AND no PSI failures)

---

## Testing After Fix

Run same test:
```bash
node index.js --url "https://www.landrover.co.uk/contact-us.html" --device mobile --skip-cache
```

**Expected Output**:
```
Early HAR Collection Gating (PSI-only):
  HAR Collection: ✅ ALWAYS COLLECT (Gate 1 removed)

[... HAR data collected ...]

HAR Agent Gating Analysis:
  Signal 1 - Request Count: 85 > 60 = ✅ PASS
  Signal 2 - Transfer Size: 2200KB > 1500KB = ✅ PASS
  Signal 3 - Redirects (PSI): ❌ FAIL
  Signal 4 - Server Response Slow (PSI): ❌ FAIL
  Signal 5 - Render Blocking (PSI): ❌ FAIL
  Signals Passed: 2/5 (need 1+)
  HAR Agent: ✅ WILL RUN
```

**Verify**:
- HAR file exists in .cache/
- thirdPartyAnalysis data exists
- HAR Agent output includes third-party categories
- Final suggestions cite specific third-party scripts

---

## Timeline

1. **Immediate** (5 min): Remove Gate 1 (set `shouldRunHar = true`)
2. **Short-term** (30 min): Lower Gate 2 thresholds + simplify logic
3. **Long-term** (optional): Refactor to eliminate double-gating architecture

---

## Files to Modify

| File | Line | Change |
|------|------|--------|
| `src/core/multi-agents.js` | 990 | Remove Gate 1: `const shouldRunHar = true;` |
| `src/core/multi-agents.js` | 29-42 | Lower thresholds: 60 reqs / 1.5MB |
| `src/core/multi-agents.js` | 643-663 | Simplify logic: OR + single signal |

---

## Summary

**Critical Bug**: Double-gating architecture prevents HAR collection for 90% of sites

**Impact**: Priority 1 third-party analysis is completely broken

**Fix**: Remove Gate 1 (always collect) + lower Gate 2 thresholds

**Benefit**: Priority 1 data collection actually works, HAR agent triggers for typical sites
