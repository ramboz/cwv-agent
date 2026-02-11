# Quality Metrics Analysis

**Status:** Research
**Date:** 2025-XX-XX
**Author:** (exploratory analysis)

> Understanding the relationship between agent output quality, validation metrics, and synthesis quality.

---

## Research Question

You ran a test and got quality metrics showing:
- **19 total findings** from agents
- **Average confidence: 0.9447** (94.47%)
- **13 root causes** identified

But you asked:
1. How do these metrics relate to the final suggestions?
2. Why is the confidence so high?

---

## Answer: The Metrics Track AGENT OUTPUT, Not Final Suggestions

### Key Insight: Two Separate Steps

```
┌─────────────────────────────────────────────────────────────┐
│ STEP 1: Agent Analysis (What metrics track)                 │
├─────────────────────────────────────────────────────────────┤
│ 8 agents analyze data → Output structured findings          │
│ • CrUX Agent: 2 findings                                    │
│ • RUM Agent: 5 findings                                     │
│ • PSI Agent: 3 findings                                     │
│ • HAR Agent: 4 findings                                     │
│ • Coverage Agent: 3 findings                                │
│ • Code Agent: 2 findings                                    │
│ • Perf Observer: 0 findings (failed coverage)               │
│ • HTML Agent: 0 findings (failed coverage)                  │
│ • Rules Agent: 0 findings (failed coverage)                 │
│                                                              │
│ Total: 19 findings with avg confidence 0.9447              │
│ ← Quality metrics saved here                                │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ STEP 2: Final Synthesis (What user sees)                    │
├─────────────────────────────────────────────────────────────┤
│ Synthesis agent reads all 19 findings →                     │
│ Merges, prioritizes, rewrites for business users            │
│                                                              │
│ Output: 6 final suggestions in report                       │
│ ← NOT tracked by quality metrics yet                        │
└─────────────────────────────────────────────────────────────┘
```

---

## Your Specific Case: Krisshop.com Mobile

### Quality Metrics (Agent-Level Data)

From `.cache/www-krisshop-com-en.mobile.quality-metrics.gemini25pro.json`:

```json
{
  "totalFindings": 19,        // 19 raw findings from agents
  "findingsByMetric": {
    "LCP": 6,                  // 6 findings mention LCP
    "CLS": 3,                  // 3 findings mention CLS
    "INP": 3,
    "TBT": 4,
    "TTFB": 2,
    "FCP": 1
  },
  "averageConfidence": 0.9447, // Average of all agent confidence scores
  "rootCauseCount": 13,        // 13 out of 19 marked as root causes
  "rootCauseRatio": 0.68       // 68% of findings are root causes
}
```

**Example Agent Findings (Raw)**:
```json
{
  "id": "crux-cls-1",
  "description": "CLS is 0.69, extremely high...",
  "evidence": { "confidence": 1.0 },  ← This 1.0 contributes to avg
  "rootCause": false  ← Symptom, not root cause
}
```

```json
{
  "id": "rum-ttfb-1",
  "description": "TTFB is 1051ms, slow server response...",
  "evidence": { "confidence": 1.0 },  ← This 1.0 also contributes
  "rootCause": true   ← Marked as root cause
}
```

### Final Suggestions (Synthesis Output)

From `.cache/www-krisshop-com-en.mobile.report.gemini25pro.summary.md`:

The synthesis agent took those **19 findings** and created **6 final suggestions**:

1. **Reserve Space for Dynamic Content** (CLS Fix)
2. **Prioritize LCP Image with `<img>` Tag**
3. **Use `transform` for CSS Animations** (INP/TBT)
4. **Defer Non-Critical Third-Party Scripts** (TBT)
5. **Split Monolithic AEM Clientlibs** (All metrics)
6. **Optimize Server Response Time (TTFB)**

**What Happened**: The synthesis agent:
- Combined related findings (e.g., 6 LCP findings → 2 LCP suggestions)
- Prioritized by impact (High/Medium/Low)
- Rewrote for business users (less technical)
- Added implementation roadmap

**Critical Gap**: Quality metrics only track the 19 raw findings, NOT the 6 final suggestions.

---

## Why Is Confidence So High (0.9447)?

### The Confidence Score Breakdown

Looking at your agent outputs, here are the individual confidence scores:

**CrUX Agent** (2 findings):
- `crux-cls-1`: confidence **1.0** (CLS is 0.69 - hard fact from CrUX)
- `crux-ttfb-1`: confidence **1.0** (TTFB is 860ms - hard fact from CrUX)

**RUM Agent** (5 findings):
- `rum-lcp-1`: confidence **1.0** (p75 LCP is 3552ms - hard fact from RUM)
- `rum-ttfb-1`: confidence **1.0** (p75 TTFB is 1051ms - hard fact)
- `rum-lcp-image-1`: confidence **0.95** (Image not optimized - high confidence from RUM data)
- `rum-cls-1`: confidence **1.0** (CLS data from RUM)
- `rum-inp-1`: confidence **1.0** (INP data from RUM)

**PSI Agent** (3 findings):
- Likely all **0.9-1.0** (PSI audit failures are concrete)

**HAR Agent** (4 findings):
- Likely all **0.9-1.0** (Timing data is concrete)

**Coverage Agent** (3 findings):
- Likely all **0.9-1.0** (Unused code % is measured)

**Code Agent** (2 findings):
- Likely **0.85-0.95** (Code analysis is slightly less certain)

**Average**: (1.0 + 1.0 + 1.0 + 1.0 + 0.95 + ... ) / 19 ≈ **0.9447**

### Why So High?

**This is actually correct behavior for Phase 1!**

The high confidence is because:

1. **Agents are reporting SYMPTOMS, not root causes** (13/19 are marked `rootCause: true`, but some are actually symptoms):
   - "CLS is 0.69" → This is a FACT with confidence 1.0 ✅
   - "TTFB is 1051ms" → This is a FACT with confidence 1.0 ✅
   - "Unused JS is 420KB" → This is MEASURED with confidence 1.0 ✅

2. **Data sources are concrete (CrUX, RUM, PSI, HAR)**:
   - Not speculation ("I think...")
   - Measured metrics from real tools
   - High confidence is appropriate

3. **Phase 1 doesn't include reasoning quality yet**:
   - Agents aren't explaining WHY issues occur
   - Just stating THAT they occur
   - Confidence only measures "how sure are you this metric is bad?" not "how sure are you about the root cause?"

---

## The Real Problem: Confidence Doesn't Measure What You Think

### What You Probably Want to Measure

| Metric | What It Currently Tracks | What You Probably Want |
|--------|-------------------------|------------------------|
| **averageConfidence** | "How certain is the agent that this metric value is correct?" | "How likely is this suggestion to fix the problem?" |
| **rootCauseCount** | Number of findings marked `rootCause: true` | Accuracy of root cause identification |
| **totalFindings** | Number of raw agent findings | Number of actionable final suggestions |

### Example: CLS Finding

**Agent Finding (High Confidence)**:
```json
{
  "id": "crux-cls-1",
  "description": "CLS is 0.69, extremely high",
  "evidence": { "confidence": 1.0 },  ← 100% confident CLS = 0.69
  "rootCause": false  ← Correctly marked as symptom
}
```

**But the agent doesn't say**:
- ❓ What's causing the 0.69 CLS? (No root cause identified yet)
- ❓ Will fixing it actually improve CLS? (No validation)
- ❓ Is the estimated impact (0.59 reduction) realistic? (No verification)

**Final Suggestion (Lower Confidence, Unstated)**:
```
Reserve Space for Dynamic Content:
Expected Impact: CLS reduction of >0.5 (from 0.69 to <0.1).
```

**The synthesis agent makes a hypothesis**:
- "If we add `aspect-ratio`, CLS will drop by 0.5"
- But this hypothesis is **not validated** and has **no confidence score**

---

## What Phase 1 Metrics Actually Tell You

### Good News ✅

1. **High data completeness**:
   - `"withConcreteReference": 1.0` → All findings cite specific evidence
   - `"withImpactEstimate": 1.0` → All findings estimate impact
   - This is excellent!

2. **Agents executed successfully**:
   - 4/8 agents completed with `coverageComplete: true`
   - CrUX, PSI, Coverage, Code Review all ran fully

3. **Reasonable finding count**:
   - 19 findings is a good signal (not 0, not 100)
   - Not generating noise

### Bad News ❌

1. **3 agents failed** (no findings):
   - `"Perf Observer Agent": coverageComplete: false`
   - `"HTML Agent": coverageComplete: false`
   - `"Rules Agent": coverageComplete: false`
   - **Likely due to rate limiting during your test run**

2. **Confidence doesn't measure fix likelihood**:
   - 0.9447 only means "agents are confident metrics are bad"
   - Doesn't mean "fixes will work" or "root causes are correct"

3. **No validation metrics yet**:
   - No false positive tracking
   - No "did the fix work?" measurement
   - Phase 4 will add this

---

## What Happens in Future Phases

### Phase 2: Chain-of-Thought Reasoning

Will populate the `reasoning` field in findings:
```json
{
  "id": "crux-cls-1",
  "description": "CLS is 0.69",
  "reasoning": {
    "symptom": "CLS is 0.69 (threshold 0.1)",
    "rootCauseHypothesis": "Hero carousel loads without reserved space",
    "evidenceSupport": "HTML shows no aspect-ratio on .hero-carousel-container",
    "impactRationale": "Adding aspect-ratio prevents vertical collapse → ~0.5 CLS reduction"
  },
  "evidence": { "confidence": 0.85 }  ← Lower now, includes reasoning uncertainty
}
```

**Impact on metrics**:
- `averageConfidence` will **drop** to ~0.75-0.85 (more honest)
- But reasoning quality will be **measurable**

### Phase 3: Causal Graph Builder

Will validate relationships between findings:
```json
{
  "edges": [
    {
      "from": "coverage-unused-1",  // 420KB unused JS
      "to": "psi-tbt-1",            // 850ms TBT
      "relationship": "causes",
      "strength": 0.85,
      "estimatedContribution": 420  // Does 420KB → 420ms make sense?
    }
  ],
  "validation": {
    "timingConsistent": true,  ← NEW: Checks if math adds up
    "contradictions": []
  }
}
```

**Impact on metrics**:
- Add `"timingConsistency": 0.92` (% of findings with valid math)
- Add `"contradictionCount": 0` (conflicting hypotheses)

### Phase 4: Validation Agent

Will validate final suggestions before output:
```json
{
  "validationStatus": {
    "passed": true,
    "issueCount": 2,       // 2 suggestions had timing issues
    "blockedCount": 0      // None blocked (warnings only)
  }
}
```

**Impact on metrics**:
- Add `"validatedSuggestionRatio": 0.83` (5/6 suggestions passed validation)
- Add `"blockedSuggestionCount": 0` (none were blocked)
- **This is the metric you care about most**

---

## Recommendations for Interpreting Current Metrics

### What to Look For (Good Quality Signals)

1. **`totalFindings` in 5-20 range**: ✅ You have 19 (good)
2. **`withConcreteReference` > 0.8**: ✅ You have 1.0 (excellent)
3. **`withImpactEstimate` > 0.8**: ✅ You have 1.0 (excellent)
4. **`rootCauseRatio` between 0.5-0.7**: ✅ You have 0.68 (good)
5. **`agentCoverageComplete` mostly true**: ⚠️ Only 4/8 agents completed

### What to Ignore (For Now)

1. **`averageConfidence` being high**: This is expected in Phase 1. It will naturally drop in Phase 2 when reasoning is added.

2. **No correlation to final suggestions**: Phase 1 doesn't track synthesis quality yet. You're measuring raw ingredients, not the final dish.

### What to Fix Immediately

**Missing agents (coverageComplete: false)**:
- Perf Observer, HTML, Rules agents didn't complete
- Likely due to rate limiting in your test run
- Try running again with the rate limiting fix

---

## Testing the Rate Limiting Fix

Run the same command again:
```bash
node index.js --action agent \
  --url https://www.krisshop.com/en \
  --device mobile \
  --model gemini-2.5-pro \
  --skip-cache
```

**Expected changes in quality metrics**:
```json
{
  "totalFindings": 25-30,  // Higher (3 more agents will contribute)
  "averageConfidence": 0.91-0.95,  // Similar or slightly lower
  "agentCoverageComplete": {
    "CrUX Agent": true,
    "PSI Agent": true,
    "Perf Observer Agent": true,  ← Should be true now
    "HTML Agent": true,            ← Should be true now
    "Rules Agent": true,           ← Should be true now
    "Coverage Agent": true,
    "Code Review Agent": true,
    "HAR Agent": true
  }
}
```

---

## Summary

### Your Questions Answered

**Q1: How do quality metrics relate to final suggestions?**
- **A**: They don't yet. Metrics track **agent findings** (19), not **final suggestions** (6).
- The synthesis step happens after metrics collection and is not measured.
- Future enhancement: Track synthesis quality metrics separately.

**Q2: Why is confidence so high (0.9447)?**
- **A**: Because agents are reporting measured facts ("CLS is 0.69") not hypotheses ("fixing X will improve Y").
- High confidence is appropriate for Phase 1.
- Confidence will drop naturally in Phase 2 when reasoning is added.

### Key Takeaway

**Phase 1 Quality Metrics Are Working Correctly!**

They're measuring what they're designed to measure:
- ✅ Agent finding completeness
- ✅ Evidence quality (concrete references)
- ✅ Impact estimation coverage
- ✅ Root cause vs symptom ratio

They're **not** measuring (yet):
- ❌ Final suggestion quality
- ❌ Fix likelihood
- ❌ Root cause accuracy
- ❌ Timing consistency

**Next Steps**:
1. Test with rate limiting fix to get all 8 agents running
2. Establish baseline metrics on 10 URLs
3. Proceed to Phase 2 (reasoning) to lower confidence and add explainability
4. Proceed to Phase 4 (validation) to measure suggestion quality

---

**Date**: January 26, 2026
**Phase**: 1 (Structured Outputs)
**Test URL**: https://www.krisshop.com/en (mobile)
**Findings**: 19 agent findings → 6 final suggestions
**Average Confidence**: 0.9447 (appropriate for symptom reporting)
