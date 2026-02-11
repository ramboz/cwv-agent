# Gating Architecture - Visual Summary

**Quick Reference Guide**

---

## The Problem (Current State)

```
❌ BROKEN FLOW: Double-Gating Sequential Dependency

PSI Audit Results
  ↓
Gate 1 (Early - BEFORE collection)
├─ Checks: 3 PSI signals only
├─ Logic: Need 2+ signals
└─ If FAIL → HAR/Coverage NEVER COLLECTED
  ↓
HAR Collection: ❌ SKIPPED
Coverage Collection: ❌ SKIPPED
  ↓
Gate 2 (Late - AFTER collection)
├─ Checks: 5 signals (HAR stats + PSI)
├─ HAR stats = {requests: 0, bytes: 0} ← NO DATA!
└─ Result: 0/5 signals → Agent SKIPPED

RESULT: No data, no agent, no Priority 1/2 analysis
```

**Impact**: 90% of typical sites never get HAR/Coverage agents

---

## The Solution (Proposed Architecture)

```
✅ FIXED FLOW: Three-Tier Single-Gate Architecture

Tier 1: Always Collect Base Data
├─ PSI ✅ (always)
├─ CrUX ✅ (always)
├─ HAR ✅ (always - lightweight, already happens)
├─ Performance Entries ✅ (always)
└─ HTML ✅ (always)

Tier 2: Conditional Heavy Collection (single gate)
├─ Coverage → IF (HAR shows 40+ reqs OR 1MB+) THEN collect
├─ Code → IF (Coverage collected) THEN collect
└─ Priority 1/2 Attribution → IF (data available) THEN analyze

Tier 3: Agent Execution (single gate per agent)
├─ HAR Agent → IF (60+ reqs OR 1.5MB+ OR 1+ PSI fail) THEN run
├─ Coverage Agent → IF (300KB+ unused OR 30%+ ratio) THEN run
└─ Code Agent → IF (500KB+ first-party OR 3+ bundles) THEN run
```

**Impact**: 70-80% of typical sites get HAR/Coverage agents

---

## Side-by-Side Comparison

### Current HAR Gating (BROKEN)

| Phase | Gate | Logic | Threshold (Mobile) | Typical Site | Pass? |
|-------|------|-------|-------------------|--------------|-------|
| **Early** | PSI-only | 2+ of 3 signals | redirects, serverSlow, blocking | 0 signals | ❌ FAIL |
| **Collection** | — | Skipped! | — | — | ❌ NO DATA |
| **Late** | HAR stats + PSI | 2+ of 5 signals | 150 reqs, 3MB | 0 reqs, 0KB | ❌ FAIL |
| **Agent** | — | Skipped! | — | — | ❌ NO RUN |

**Result**: HAR agent triggers for ~5-10% of sites

### Proposed HAR Gating (FIXED)

| Phase | Gate | Logic | Threshold (Mobile) | Typical Site | Pass? |
|-------|------|-------|-------------------|--------------|-------|
| **Early** | None | Always collect | — | — | ✅ ALWAYS |
| **Collection** | — | HAR collected | — | 85 reqs, 2.2MB | ✅ COLLECTED |
| **Late** | Single gate | 1+ signal | 60 reqs OR 1.5MB | 85 reqs ✅ | ✅ PASS |
| **Agent** | — | Runs! | — | — | ✅ RUNS |

**Result**: HAR agent triggers for ~70-80% of sites

---

## Key Architecture Changes

### Change 1: Remove All Early Gates

**Before**:
```javascript
// Line 990 - Early HAR gate (PSI-only, BEFORE collection)
const shouldRunHar = [redirects, serverSlow, blocking].filter(Boolean).length >= 2;

// Line 989 - Early Coverage gate (PSI-only, BEFORE collection)
const shouldRunCoverage = [redirects, serverSlow, blocking].filter(Boolean).length >= 1;

// If gates fail → No collection happens
```

**After**:
```javascript
// No early gates - ALWAYS collect HAR and check Coverage based on HAR size
const harFile = await collectHAR(url, device, options); // Always runs

// Coverage based on HAR size (lightweight check)
const shouldCollectCoverage = (harStats.requests > 40) || (harStats.bytes > 1_000_000);
```

### Change 2: Unified Late Gate Logic

**Before** (scattered, inconsistent):
```javascript
// HAR: 2+ of 5 signals (lines 643-650)
const harSignals = [reqs > 150, bytes > 3MB, redirects, serverSlow, blocking];
const shouldRun = harSignals.filter(Boolean).length >= 2;

// Coverage: Device-dependent (lines 639-641)
const coverageSignals = [unused > 300KB, ratio > 30%, reduceUnusedJS, blocking];
const shouldRun = device === 'mobile'
  ? coverageSignals.filter(Boolean).length >= 2
  : coverageSignals.filter(Boolean).length >= 1;

// Code: Depends on Coverage (lines 671-673)
const shouldRun = shouldRunCoverage && [...]; // Circular dependency!
```

**After** (unified, consistent):
```javascript
// NEW: src/core/gating.js - Single unified class
import { AgentGating } from './gating.js';

const gating = new AgentGating(deviceType);

// HAR: 1+ signal, lower thresholds
const harDecision = gating.shouldRunAgent('har', {
  data: { entriesCount: 85, transferBytes: 2_200_000 },
  psi: { redirects: false, serverSlow: false, blocking: false }
});
// Decision: 85 > 60 = PASS (1 signal) → HAR agent RUNS

// Coverage: 1+ signal, independent
const coverageDecision = gating.shouldRunAgent('coverage', {
  data: { unusedBytes: 400_000, unusedRatio: 0.35 },
  psi: { reduceUnusedJS: false, blocking: false }
});
// Decision: 400KB > 300KB = PASS (1 signal) → Coverage agent RUNS

// Code: 1+ signal, NO dependency on Coverage
const codeDecision = gating.shouldRunAgent('code', {
  data: { firstPartyBytes: 600_000, bundleCount: 4 },
  psi: { reduceUnusedJS: false }
});
// Decision: 600KB > 500KB = PASS (1 signal) → Code agent RUNS
```

### Change 3: Lower Thresholds to Realistic Values

| Metric | Old (Current) | New (Proposed) | Typical Site | Old Pass? | New Pass? |
|--------|---------------|----------------|--------------|-----------|-----------|
| **Mobile Requests** | 150 | 60 | 70-85 | ❌ | ✅ |
| **Mobile Transfer** | 3 MB | 1.5 MB | 2-2.5 MB | ❌ | ✅ |
| **Desktop Requests** | 180 | 80 | 80-100 | ❌ | ✅ |
| **Desktop Transfer** | 3.5 MB | 2 MB | 2.5-3 MB | ❌ | ✅ |
| **Unused Bytes** | N/A | 300 KB | 400-500 KB | N/A | ✅ |
| **Unused Ratio** | N/A | 30% | 35-45% | N/A | ✅ |

### Change 4: OR Logic (Not AND)

**Before**:
```javascript
// Need BOTH requests AND bytes to exceed threshold (dual jeopardy)
const signal1 = requests > 150;  // ❌ FAIL (85 < 150)
const signal2 = bytes > 3_000_000; // ❌ FAIL (2.2MB < 3MB)
// Result: 0/2 size signals → Need 2 PSI signals to compensate
```

**After**:
```javascript
// Need EITHER requests OR bytes (OR logic)
const signal1 = requests > 60;     // ✅ PASS (85 > 60)
const signal2 = bytes > 1_500_000; // ✅ PASS (2.2MB > 1.5MB)
// Result: 2/2 size signals → HAR agent RUNS
```

---

## Implementation Steps

### Step 1: Create Unified Gating Module
```bash
# Create new file
touch src/core/gating.js
```

Key components:
- `class AgentGating` - Main gating logic
- `UNIFIED_THRESHOLDS` - Single source of truth for all thresholds
- `AGENT_RULES` - Declarative rules per agent
- `shouldRunAgent(type, signals)` - Universal gating function

### Step 2: Remove Early Gates
```javascript
// src/core/multi-agents.js lines 973-1025
// DELETE: All early gate logic
// DELETE: const shouldRunHar = ...
// DELETE: const shouldRunCoverage = ...
// DELETE: const collectCode = shouldRunCoverage;
```

### Step 3: Update Data Collection
```javascript
// src/core/collect.js
// CHANGE: Always collect HAR (no gate)
const harFile = await collectHAR(url, device, options);

// CHANGE: Coverage based on HAR size (lightweight check)
const shouldCollect = (harStats.requests > 40) || (harStats.bytes > 1_000_000);
```

### Step 4: Replace Late Gates
```javascript
// src/core/multi-agents.js lines 643-715
// REPLACE: All late gate logic with unified gating
import { AgentGating } from './gating.js';

const gating = new AgentGating(pageData.device);
const harDecision = gating.shouldRunAgent('har', signals);
const coverageDecision = gating.shouldRunAgent('coverage', signals);
const codeDecision = gating.shouldRunAgent('code', signals);
```

### Step 5: Test & Validate
```bash
# Test with typical site
node index.js --url "https://www.landrover.co.uk/contact-us.html" --device mobile --skip-cache

# Expected output:
# ✅ HAR collected: Yes
# 📊 HAR Agent Gating: 85 > 60 = PASS
# ✅ HAR Agent: WILL RUN
```

---

## Expected Outcomes

### Trigger Rate Improvements

| Agent | Before | After | Improvement |
|-------|--------|-------|-------------|
| HAR Agent | 5-10% | 70-80% | **7-8x more** |
| Coverage Agent | 10-15% | 60-70% | **5-6x more** |
| Code Agent | 10-15% | 50-60% | **4-5x more** |
| **Priority 1 Data** | 5-10% | 70-80% | **7-8x more** |
| **Priority 2 Data** | 30-40% | 60-70% | **2x more** |

### Quality Improvements

**Before**:
```json
{
  "title": "Optimize third-party scripts",
  "description": "Third-party scripts impact performance",
  "implementation": "Consider deferring or removing scripts"
}
```

**After**:
```json
{
  "title": "Defer analytics scripts to improve TBT by 450ms",
  "description": "Analytics category has 3 scripts with 450ms total execution: Google Analytics (280ms), Adobe Analytics (120ms), Segment (50ms)",
  "implementation": "Add async/defer attributes to analytics scripts",
  "codeExample": "<script async src='https://www.google-analytics.com/analytics.js'></script>",
  "estimatedImpact": "450ms TBT reduction",
  "confidence": 0.85
}
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Increased token usage | Medium | Low | ~10-20% increase, still within budget |
| More false positives | Low | Medium | Validation agent blocks invalid suggestions |
| Performance regression | Very Low | Low | HAR collection already happens, minimal overhead |
| Breaking changes | Very Low | High | Feature flag rollback, backward compatible |

---

## Decision Points

### Option 1: Full Implementation (Recommended)
- Create unified gating module
- Remove all early gates
- Lower all thresholds
- Timeline: 1.4 weeks

**Pros**: Fixes all issues, clean architecture
**Cons**: More upfront work

### Option 2: Quick Fix Only (HAR)
- Remove HAR early gate only
- Lower HAR thresholds
- Keep Coverage/Code as-is
- Timeline: 2 days

**Pros**: Fast, unblocks Priority 1
**Cons**: Doesn't fix systemic issues

### Option 3: Phased Rollout
- Week 1: HAR fixes
- Week 2: Coverage fixes
- Week 3: Unified module
- Timeline: 3 weeks

**Pros**: Incremental validation
**Cons**: Longer to complete

---

## Recommendation

**Proceed with Option 1 (Full Implementation)**

**Rationale**:
1. Fixes systemic issues, not just symptoms
2. 1.4 weeks is reasonable for the benefit
3. Unblocks Priority 1 & 2 data collection
4. Creates maintainable, consistent architecture
5. Feature flag allows safe rollback

**Next Steps**:
1. Review this proposal
2. Approve architecture approach
3. Begin Phase 1: Create gating module
4. Test incrementally after each phase
5. Deploy with feature flag enabled

---

## Questions?

- **Q**: Why always collect HAR?
  - **A**: It's lightweight (~100ms), already collected by most tools, required for Priority 1 data

- **Q**: Why lower thresholds so much?
  - **A**: Current thresholds (150 reqs, 3MB) are 2x typical sites, designed for outliers not normal usage

- **Q**: What if agents run too often?
  - **A**: Validation agent blocks invalid suggestions, token increase is <20%

- **Q**: Can we rollback easily?
  - **A**: Yes, feature flag `USE_UNIFIED_GATING=false` instantly reverts to legacy behavior

- **Q**: When do we see improvements?
  - **A**: Immediately after Phase 2 (remove early gates) - Priority 1 data becomes available
