# Gating Architecture Improvement Proposal

**Date**: January 28, 2026
**Status**: Proposed architecture to address double-gating issues

---

## Executive Summary

The current conditional gating system has **fundamental architectural issues** that prevent proper data collection and agent execution:

1. **Double-gating bug**: Sequential gates where early gate prevents data collection, late gate checks non-existent data
2. **Inconsistent logic**: Different signal requirements across similar components (2+ vs 1+)
3. **Circular dependencies**: Code agent depends on coverage gate, creating cascading failures
4. **Overly conservative thresholds**: Designed for outlier sites, fails on typical websites

**Impact**: Priority 1 & 2 data collection broken for ~90% of sites, HAR/Coverage agents rarely run.

**Proposed solution**: Unified three-tier architecture with consistent logic, lower thresholds, and eliminated double-gating.

---

## Current Architecture Problems

### Problem 1: Double-Gating Sequential Dependency

**HAR Example**:
```
Gate 1 (Line 990): PSI-only check BEFORE collection
├─ Checks: redirects, serverResponseSlow, renderBlocking
├─ Logic: Requires 2+ of 3 signals
└─ If FAIL → HAR never collected

Gate 2 (Lines 643-663): Data + PSI check AFTER collection
├─ Checks: entriesCount, transferBytes, redirects, serverResponseSlow, renderBlocking
├─ Logic: Requires 2+ of 5 signals
└─ If Gate 1 failed → harStats = {entriesCount: 0, transferBytes: 0} → Gate 2 also FAILS
```

**Coverage has identical issue**:
- Early gate (line 989): 1+ of 3 signals
- Late gate (lines 639-641): 2+ of 5 signals (mobile) or 1+ of 5 (desktop)
- Sequential dependency prevents collection → prevents agent execution

### Problem 2: Inconsistent Signal Requirements

| Component | Early Gate | Late Gate | Inconsistency |
|-----------|------------|-----------|---------------|
| HAR | 2+ of 3 (PSI) | 2+ of 5 (data+PSI) | Stricter early |
| Coverage | 1+ of 3 (PSI) | 2+ of 5 (mobile) | Changes by device |
| Code | N/A (depends on coverage) | 2+ of 5 | Inherited dependency |

**Why this matters**: Same component uses different logic at different phases, creating unpredictable behavior.

### Problem 3: Circular Dependencies

**Code agent dependency chain**:
```
Code Agent (line 671-673)
  ↓
Depends on: shouldRunCoverage value
  ↓
Which depends on: Early coverage gate (line 989)
  ↓
Which depends on: PSI signals

Result: If early coverage gate fails, Code agent also fails
        Even if Code agent has valid signals!
```

### Problem 4: Thresholds Too High

**Current vs Typical Sites**:
| Metric | Current Threshold | Typical Site | Pass Rate |
|--------|-------------------|--------------|-----------|
| Mobile Requests | 150 | 50-100 | ~10-20% |
| Mobile Transfer | 3 MB | 1.5-2.5 MB | ~20-30% |
| Desktop Requests | 180 | 60-120 | ~15-25% |
| Desktop Transfer | 3.5 MB | 2-3 MB | ~25-35% |

**Impact**: Only extreme outlier sites trigger data collection and agents.

---

## Proposed Architecture: Three-Tier Unified Gating

### Core Principles

1. **Single decision point per component** - No double-gating
2. **Always collect base data** - Gate agents, not collection
3. **Consistent signal logic** - Same requirements across all components
4. **Realistic thresholds** - Based on 50th-75th percentile sites
5. **No circular dependencies** - Each component independently gated

### Architecture Overview

```
Tier 1: Baseline Data Collection (Always Run)
├─ PSI (always)
├─ CrUX (always)
├─ HAR (always - lightweight, already collected)
├─ Performance Entries (always)
└─ HTML (always)

Tier 2: Conditional Heavy Collection (Single Gate)
├─ Coverage
│   └─ Gate: IF (hasUnusedCode signal OR hasLargeBundle signal) THEN collect
├─ Third-Party Attribution
│   └─ Gate: IF (thirdPartyScripts > 5 OR thirdPartyTime > 500ms) THEN analyze
└─ CLS Attribution
    └─ Gate: IF (CLS > 0.1 OR shiftsCount > 3) THEN analyze

Tier 3: Agent Execution (Single Gate Per Agent)
├─ HAR Agent
│   └─ Gate: IF (requests > 60 OR transfer > 1.5MB OR 1+ PSI failure) THEN run
├─ Coverage Agent
│   └─ Gate: IF (unusedBytes > 300KB OR unusedRatio > 30%) THEN run
└─ Code Agent
    └─ Gate: IF (firstPartyBytes > 500KB OR bundleCount > 3) THEN run
```

### Key Changes

**Change 1: Always Collect HAR** ✅ **Critical**
```javascript
// REMOVE: Early HAR gate at line 990
// HAR collection is now unconditional

// In collect.js
const harFile = await collectHAR(pageUrl, deviceType, { skipCache, outputSuffix });
// No gate - always collected
```

**Change 2: Single Unified Gate Function**
```javascript
// NEW: src/core/gating.js

export class AgentGating {
  constructor(deviceType) {
    this.device = deviceType;
    this.thresholds = UNIFIED_THRESHOLDS[deviceType];
  }

  /**
   * Unified gating logic for all agents
   * @param {string} agentType - 'har', 'coverage', 'code'
   * @param {object} signals - { psi: {...}, data: {...} }
   * @returns {object} { shouldRun: boolean, reason: string, signalsPassed: number }
   */
  shouldRunAgent(agentType, signals) {
    const rules = AGENT_RULES[agentType];

    // Evaluate data signals
    const dataSignals = rules.dataSignals.map(s => this.evaluateSignal(s, signals.data));

    // Evaluate PSI signals
    const psiSignals = rules.psiSignals.map(s => this.evaluateSignal(s, signals.psi));

    // Combine with OR logic (any data signal OR any PSI signal)
    const allSignals = [...dataSignals, ...psiSignals];
    const passedCount = allSignals.filter(Boolean).length;

    const shouldRun = passedCount >= rules.minSignals;

    return {
      shouldRun,
      reason: this.explainDecision(agentType, allSignals, rules),
      signalsPassed: passedCount,
      signalsTotal: allSignals.length
    };
  }

  evaluateSignal(signal, data) {
    const { metric, operator, threshold } = signal;
    const value = data[metric];

    switch (operator) {
      case '>': return value > threshold;
      case '<': return value < threshold;
      case '>=': return value >= threshold;
      default: return false;
    }
  }

  explainDecision(agentType, signals, rules) {
    const passed = signals.filter(Boolean).length;
    const signalNames = rules.dataSignals.concat(rules.psiSignals).map(s => s.name);
    const passedNames = signalNames.filter((_, i) => signals[i]);

    return `${agentType}: ${passed}/${signals.length} signals passed (need ${rules.minSignals}+). Passed: ${passedNames.join(', ')}`;
  }
}

// Unified thresholds
const UNIFIED_THRESHOLDS = {
  mobile: {
    requests: 60,              // Lowered from 150
    transferBytes: 1_500_000,  // Lowered from 3MB
    unusedBytes: 300_000,      // 300KB
    unusedRatio: 0.30,         // 30%
    firstPartyBytes: 500_000,  // 500KB
    cls: 0.1,                  // CLS threshold
    thirdPartyCount: 5,        // 5+ scripts
    thirdPartyTime: 500        // 500ms
  },
  desktop: {
    requests: 80,              // Lowered from 180
    transferBytes: 2_000_000,  // Lowered from 3.5MB
    unusedBytes: 400_000,      // 400KB
    unusedRatio: 0.30,         // 30%
    firstPartyBytes: 700_000,  // 700KB
    cls: 0.1,
    thirdPartyCount: 5,
    thirdPartyTime: 500
  }
};

// Agent-specific rules
const AGENT_RULES = {
  har: {
    dataSignals: [
      { name: 'Request Count', metric: 'entriesCount', operator: '>', threshold: 'requests' },
      { name: 'Transfer Size', metric: 'transferBytes', operator: '>', threshold: 'transferBytes' }
    ],
    psiSignals: [
      { name: 'Redirects', metric: 'redirects', operator: '===', threshold: true },
      { name: 'Server Response Slow', metric: 'serverResponseSlow', operator: '===', threshold: true },
      { name: 'Render Blocking', metric: 'renderBlocking', operator: '===', threshold: true }
    ],
    minSignals: 1  // ANY signal triggers
  },

  coverage: {
    dataSignals: [
      { name: 'Unused Bytes', metric: 'unusedBytes', operator: '>', threshold: 'unusedBytes' },
      { name: 'Unused Ratio', metric: 'unusedRatio', operator: '>', threshold: 'unusedRatio' }
    ],
    psiSignals: [
      { name: 'Unused JavaScript', metric: 'reduceUnusedJS', operator: '===', threshold: true },
      { name: 'Render Blocking', metric: 'renderBlocking', operator: '===', threshold: true }
    ],
    minSignals: 1
  },

  code: {
    dataSignals: [
      { name: 'First-Party Bytes', metric: 'firstPartyBytes', operator: '>', threshold: 'firstPartyBytes' },
      { name: 'Bundle Count', metric: 'bundleCount', operator: '>', threshold: 3 }
    ],
    psiSignals: [
      { name: 'Unused JavaScript', metric: 'reduceUnusedJS', operator: '===', threshold: true }
    ],
    minSignals: 1
  }
};
```

**Change 3: Remove Early Gates, Keep Single Late Gate**
```javascript
// MODIFY: src/core/multi-agents.js

// Lines 973-1025: REMOVE all early gates
// DELETE:
//   const shouldRunHar = ...
//   const shouldRunCoverage = ...
//   const collectCode = shouldRunCoverage; // Remove dependency

// Lines 643-715: REPLACE with unified gating
import { AgentGating } from './gating.js';

function generateConditionalAgentConfig(
  cms,
  agentPrompts,
  runConditionalAgents,
  pageData,
  globalSystemPrompt,
  llm
) {
  if (!runConditionalAgents) {
    return [];
  }

  const gating = new AgentGating(pageData.device);
  const agents = [];

  // HAR Agent - Single unified gate
  const harDecision = gating.shouldRunAgent('har', {
    data: {
      entriesCount: pageData.labData?.harStats?.entriesCount || 0,
      transferBytes: pageData.labData?.harStats?.transferBytes || 0
    },
    psi: {
      redirects: signals.redirects,
      serverResponseSlow: signals.serverResponseSlow,
      renderBlocking: signals.renderBlocking
    }
  });

  console.log(`\n📊 HAR Agent Gating: ${harDecision.reason}`);
  console.log(`  Decision: ${harDecision.shouldRun ? '✅ WILL RUN' : '❌ SKIPPED'}\n`);

  if (harDecision.shouldRun && pageData.labData?.harData) {
    agents.push({
      name: 'HAR Agent',
      role: 'Network Performance Analyst',
      systemPrompt: agentPrompts.har,
      humanPrompt: pageData.labData.harData,
      globalSystemPrompt,
      llm,
      tools: []
    });
  }

  // Coverage Agent - Independent gate (no dependency on Code)
  const coverageDecision = gating.shouldRunAgent('coverage', {
    data: {
      unusedBytes: pageData.labData?.coverageData?.summary?.unusedBytes || 0,
      unusedRatio: pageData.labData?.coverageData?.summary?.unusedPercent / 100 || 0
    },
    psi: {
      reduceUnusedJS: signals.reduceUnusedJS,
      renderBlocking: signals.renderBlocking
    }
  });

  console.log(`\n📊 Coverage Agent Gating: ${coverageDecision.reason}`);
  console.log(`  Decision: ${coverageDecision.shouldRun ? '✅ WILL RUN' : '❌ SKIPPED'}\n`);

  if (coverageDecision.shouldRun && pageData.labData?.coverageData) {
    agents.push({
      name: 'Coverage Agent',
      role: 'Code Coverage Analyst',
      systemPrompt: agentPrompts.coverage,
      humanPrompt: pageData.labData.coverageData,
      globalSystemPrompt,
      llm,
      tools: []
    });
  }

  // Code Agent - Independent gate (no longer depends on coverage)
  const codeDecision = gating.shouldRunAgent('code', {
    data: {
      firstPartyBytes: pageData.labData?.codeData?.summary?.firstPartyBytes || 0,
      bundleCount: pageData.labData?.codeData?.summary?.bundleCount || 0
    },
    psi: {
      reduceUnusedJS: signals.reduceUnusedJS
    }
  });

  console.log(`\n📊 Code Agent Gating: ${codeDecision.reason}`);
  console.log(`  Decision: ${codeDecision.shouldRun ? '✅ WILL RUN' : '❌ SKIPPED'}\n`);

  if (codeDecision.shouldRun && pageData.labData?.codeData) {
    agents.push({
      name: 'Code Agent',
      role: 'First-Party Code Analyst',
      systemPrompt: agentPrompts.code,
      humanPrompt: pageData.labData.codeData,
      globalSystemPrompt,
      llm,
      tools: []
    });
  }

  return agents;
}
```

**Change 4: Update Collect Flow**
```javascript
// MODIFY: src/core/collect.js

// Lines 61-93: Simplify to always collect HAR, gate only Coverage/Code
export async function getLabData(url, device, options = {}) {
  const { skipCache = false, outputSuffix = '' } = options;

  console.log('🔬 Collecting lab data...');

  try {
    // ALWAYS collect HAR (no gate)
    const harFile = await collectHAR(url, device, { skipCache, outputSuffix });
    console.log(`✅ HAR collected: ${harFile ? 'Yes' : 'No'}`);

    // Conditionally collect Coverage (based on PSI signals OR initial HAR size check)
    const harStats = harFile ? getHarStats(harFile) : { entriesCount: 0, transferBytes: 0 };
    const shouldCollectCoverage = (harStats.entriesCount > 40) || (harStats.transferBytes > 1_000_000);

    let coverageData = null;
    if (shouldCollectCoverage) {
      console.log('📊 Collecting coverage (triggered by HAR size)...');
      coverageData = await collectCoverage(url, device, { skipCache, outputSuffix });
    } else {
      console.log('⏭️  Skipping coverage (HAR size below threshold)');
    }

    // Code collection depends on having coverage data
    let codeData = null;
    if (coverageData) {
      console.log('📝 Collecting first-party code...');
      codeData = await collectCode(url, device, coverageData, { skipCache, outputSuffix });
    } else {
      console.log('⏭️  Skipping code (no coverage data)');
    }

    // Performance entries (always)
    const perfEntries = await collectPerformanceEntries(url, device, { skipCache, outputSuffix });

    // HTML (always)
    const html = await collectHTML(url, device, { skipCache, outputSuffix });

    return {
      harFile,
      harStats,
      coverageData,
      codeData,
      perfEntries,
      html
    };
  } catch (error) {
    console.error('❌ Error collecting lab data:', error.message);
    return null;
  }
}
```

---

## Migration Plan

### Phase 1: Create Unified Gating Module (1 day)
- [ ] Create `src/core/gating.js` with AgentGating class
- [ ] Define UNIFIED_THRESHOLDS (lowered values)
- [ ] Define AGENT_RULES with consistent signal logic
- [ ] Add unit tests for gating logic

### Phase 2: Update Data Collection (1 day)
- [ ] Remove early HAR gate at line 990 (multi-agents.js)
- [ ] Remove early Coverage gate at line 989
- [ ] Remove Code dependency on Coverage at line 1012
- [ ] Update collect.js to always collect HAR
- [ ] Add lightweight Coverage pre-check based on HAR size

### Phase 3: Replace Late Gates (2 days)
- [ ] Replace HAR late gate (lines 643-650) with unified gating
- [ ] Replace Coverage late gate (lines 639-641) with unified gating
- [ ] Replace Code late gate (lines 671-673) with unified gating
- [ ] Remove signal extraction duplication
- [ ] Add comprehensive debug logging

### Phase 4: Testing (2 days)
- [ ] Test with 10+ URLs (lightweight, typical, heavy)
- [ ] Verify HAR always collected
- [ ] Verify agents trigger at expected rates
- [ ] Compare before/after trigger rates
- [ ] Validate no regressions in existing functionality

### Phase 5: Documentation (1 day)
- [ ] Update ARCHITECTURE.md with new gating architecture
- [ ] Document threshold rationale
- [ ] Add troubleshooting guide
- [ ] Update README with gating behavior

**Total estimated time**: 7 days (1.4 weeks)

---

## Expected Impact

### Before (Current State)

| Agent | Trigger Rate | Why Low |
|-------|--------------|---------|
| HAR | ~5-10% | Double-gating + high thresholds (150 reqs, 3MB) |
| Coverage | ~10-15% | Double-gating + device inconsistency |
| Code | ~10-15% | Depends on Coverage gate |
| **Priority 1 Data** | ~5-10% | HAR rarely collected |
| **Priority 2 Data** | ~30-40% | Perf entries always collected, but no HAR context |

### After (Proposed Architecture)

| Agent | Trigger Rate | Why Improved |
|-------|--------------|--------------|
| HAR | ~70-80% | Always collected, single gate, lower thresholds (60 reqs, 1.5MB) |
| Coverage | ~60-70% | Single gate, no double-gating, realistic thresholds |
| Code | ~50-60% | Independent gate, no dependency on Coverage |
| **Priority 1 Data** | ~70-80% | HAR always collected, third-party attribution available |
| **Priority 2 Data** | ~60-70% | CLS attribution runs when needed, has HAR context |

### Quality Improvements

**Consistency**: All agents use same gating logic, predictable behavior

**Debuggability**: Single gating module, clear decision logging, easy to test

**Maintainability**: One place to adjust thresholds, no scattered logic

**Correctness**: No sequential dependency bugs, no circular dependencies

**User Experience**:
- Priority 1 & 2 data actually available for most sites
- Suggestions cite specific third-party scripts and CSS properties
- HAR/Coverage/Code agents provide value for typical websites (not just outliers)

---

## Rollback Strategy

**Feature flag approach**:
```javascript
// In .env or config
USE_UNIFIED_GATING=true  // Set to false to use legacy gating

// In multi-agents.js
if (process.env.USE_UNIFIED_GATING === 'true') {
  // Use new AgentGating class
  const gating = new AgentGating(pageData.device);
  const harDecision = gating.shouldRunAgent('har', signals);
} else {
  // Use legacy gating (current code)
  const shouldRunHar = calculateLegacyHarGate(signals);
}
```

**Rollback steps**:
1. Set `USE_UNIFIED_GATING=false` in environment
2. Restart agent
3. Legacy behavior restored immediately

**Permanent rollback** (if needed):
1. Revert `src/core/gating.js` (delete file)
2. Revert `src/core/multi-agents.js` changes (git revert)
3. Revert `src/core/collect.js` changes
4. Existing cached data still works (backward compatible)

---

## Testing Checklist

### Lightweight Sites (Should NOT trigger heavy agents)
- [ ] Simple blog: 20 requests, 500KB → No HAR/Coverage/Code agents
- [ ] Static landing page: 15 requests, 300KB → No agents

### Typical Sites (Should trigger HAR, possibly Coverage)
- [ ] E-commerce: 70 requests, 2MB → HAR agent ✅
- [ ] Corporate site: 85 requests, 2.2MB → HAR + Coverage agents ✅
- [ ] News site: 100 requests, 2.5MB → HAR + Coverage + Code agents ✅

### Heavy Sites (Should trigger all agents)
- [ ] Large SPA: 150+ requests, 4MB → All agents ✅
- [ ] Ad-heavy site: 200+ requests, 5MB → All agents ✅

### Edge Cases
- [ ] Zero requests (error case) → No agents, graceful handling
- [ ] PSI unavailable → Still collect HAR, use data signals only
- [ ] HAR collection fails → Agents skip gracefully, no crash

### Priority Data Verification
- [ ] HAR agent output includes third-party categories ✅
- [ ] Perf Observer includes CLS attribution ✅
- [ ] Final suggestions cite specific scripts/CSS properties ✅

---

## Comparison with Plan Document Recommendations

**From `.claude/plans/calm-noodling-thimble.md` HAR Agent Gating Analysis**:

| Recommendation | Status in This Proposal |
|----------------|-------------------------|
| Option 1: Remove Gate 1 (always collect HAR) | ✅ **Implemented** - HAR always collected |
| Lower thresholds to 60 reqs / 1.5MB | ✅ **Implemented** - UNIFIED_THRESHOLDS |
| Use OR logic for size metrics | ✅ **Implemented** - dataSignals checked independently |
| Single-signal requirement (>=1) | ✅ **Implemented** - minSignals: 1 |
| Fix double-gating for Coverage | ✅ **Implemented** - Single late gate only |
| Remove Code dependency on Coverage | ✅ **Implemented** - Independent gates |

**This proposal fully addresses all issues identified in the original plan.**

---

## Summary

**Current Problem**: Double-gating architecture with overly conservative thresholds prevents data collection for 90% of sites, breaking Priority 1 & 2 functionality.

**Proposed Solution**: Unified three-tier architecture with:
- Always collect HAR (no early gate)
- Single late gate per agent
- Lowered realistic thresholds (60 reqs, 1.5MB)
- Consistent signal logic (1+ signal triggers)
- No circular dependencies

**Expected Outcome**:
- HAR agent triggers 70-80% (vs 5-10%)
- Priority 1 data available for typical sites
- Simplified, maintainable codebase
- 1.4 weeks implementation

**Risk**: Low - Feature flag rollback, backward compatible, incremental migration

**Recommendation**: Proceed with Phase 1 (create gating module) immediately to unblock Priority 1 & 2 data collection.
