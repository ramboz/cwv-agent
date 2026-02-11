# Phase 2: Chain-of-Thought Reasoning Implementation Summary

## Overview
Added structured reasoning to agent findings, forcing agents to explicitly connect observations → diagnosis → mechanism → solution. This improves root cause attribution, transparency, and suggestion quality.

## Changes Made

### 1. Schema Update (`src/prompts/shared.js`)

**Added `reasoning` field to AgentFinding schema** (lines 153-159):
```json
"reasoning": {
  "observation": "string (what you observed in the data)",
  "diagnosis": "string (why this is causing the problem)",
  "mechanism": "string (how it impacts the metric)",
  "solution": "string (why the proposed fix will work)"
}
```

**Added documentation** (lines 196-225):
- Explains the 4-step chain
- Provides good/bad examples
- References Phase A+ rich data (bytes, per-domain, fonts)

**Updated example finding** (lines 227-250):
- Shows complete reasoning for render-blocking scripts
- Demonstrates observation → diagnosis → mechanism → solution flow

---

### 2. Agent Prompt Updates (`src/prompts/analysis.js`)

**Added `getChainOfThoughtGuidance()` function** (lines 219-289):
- 4-step reasoning framework (observation, diagnosis, mechanism, solution)
- 3 detailed examples using Phase A+ rich data:
  1. Coverage with byte sizes (1147KB unused in clientlib-site.js)
  2. HAR per-domain timings (fonts.googleapis.com DNS+SSL overhead)
  3. Font strategy (Proximanova preload opportunity)
- Bad example showing what NOT to do

**Updated ALL 8 agent prompts** to include chain-of-thought guidance:
1. ✅ CrUX Agent (line 290)
2. ✅ RUM Agent (uses cruxAgentPrompt)
3. ✅ PSI Agent (line 302)
4. ✅ Performance Observer Agent (line 339)
5. ✅ HAR Agent (line 349)
6. ✅ HTML Agent (line 389)
7. ✅ Rules Agent (line 399)
8. ✅ Coverage Agent (line 409)
9. ✅ Code Review Agent (line 445)

---

## How Chain-of-Thought Works

### The 4-Step Framework:

```json
{
  "reasoning": {
    "observation": "What specific data did you see?",
    "diagnosis": "Why is this problematic?",
    "mechanism": "How does it affect the metric?",
    "solution": "Why will the fix work?"
  }
}
```

### Example 1: Coverage Analysis (Using Phase A+ Byte Data)

**Before (Phase 1)**:
```json
{
  "description": "High unused JavaScript detected",
  "evidence": {
    "source": "coverage",
    "reference": "clientlib-site.js: 34% unused"
  }
}
```

**After (Phase 2)**:
```json
{
  "description": "Remove 1147KB unused code from clientlib-site.js",
  "evidence": {
    "source": "coverage",
    "reference": "clientlib-site.js: 3348KB total, 1147KB unused (34%)"
  },
  "reasoning": {
    "observation": "clientlib-site.js is 3348KB total, with 1147KB unused code (34% waste)",
    "diagnosis": "Unused JavaScript is downloaded, parsed, and kept in memory despite never executing, wasting bandwidth and processing time",
    "mechanism": "1147KB unused code adds ~400ms download time on 3G and ~150ms parse time, directly delaying TBT and indirectly delaying LCP",
    "solution": "Tree-shaking and code splitting removes 1147KB, eliminating download/parse overhead and improving TBT by ~550ms"
  }
}
```

### Example 2: HAR Analysis (Using Per-Domain Summary)

**Before (Phase 1)**:
```json
{
  "description": "External fonts cause delays",
  "evidence": {
    "source": "har",
    "reference": "fonts.googleapis.com requests"
  }
}
```

**After (Phase 2)**:
```json
{
  "description": "Preconnect to fonts.googleapis.com to save 215ms",
  "evidence": {
    "source": "har.perDomainSummary",
    "reference": "fonts.googleapis.com: 8 requests, 340KB, DNS: 120ms, SSL: 95ms"
  },
  "reasoning": {
    "observation": "fonts.googleapis.com domain: 8 requests, 340KB, 1800ms total (225ms avg), with DNS: 120ms, SSL: 95ms",
    "diagnosis": "High connection overhead (215ms for DNS+SSL) for external font domain delays font loading",
    "mechanism": "Fonts block text rendering when not using font-display: swap, delaying FCP and potentially LCP",
    "solution": "Adding <link rel='preconnect' href='https://fonts.googleapis.com' crossorigin> eliminates 215ms connection overhead"
  }
}
```

### Example 3: HTML Analysis (Using Font Strategy)

**Before (Phase 1)**:
```json
{
  "description": "Critical fonts should be preloaded",
  "evidence": {
    "source": "html",
    "reference": "Proximanova font"
  }
}
```

**After (Phase 2)**:
```json
{
  "description": "Preload Proximanova regular weight to improve FCP",
  "evidence": {
    "source": "html.fontStrategy",
    "reference": "Proximanova (400 weight, normal style): font-display: swap, not preloaded"
  },
  "reasoning": {
    "observation": "Proximanova font (400 weight, normal style) has font-display: swap but is not preloaded",
    "diagnosis": "Critical font without preload hint is discovered late (after CSS parse), delaying text rendering",
    "mechanism": "Late font discovery adds ~300-500ms to FCP as browser must parse CSS, discover font, then fetch it",
    "solution": "Preloading with <link rel='preload' href='/fonts/ProximaNova-Regular.woff2' as='font' type='font/woff2' crossorigin> eliminates discovery delay"
  }
}
```

---

## Benefits

### 1. **Transparency**
- Users can see WHY agents reached conclusions
- Debugging is easier when reasoning is explicit
- Quality assurance can spot logical gaps

### 2. **Better Root Cause Attribution**
- Forced to connect evidence → cause → impact
- Distinguishes symptoms from root causes
- Catches logical leaps before submission

### 3. **Leverages Rich Data**
- Agents MUST use byte sizes (not just percentages)
- Agents MUST reference per-domain timings
- Agents MUST cite font strategy details

### 4. **Quality Improvement**
- Higher confidence in estimates (reasoning validates calculations)
- More specific suggestions (connected to concrete data)
- Fewer false positives (reasoning catches weak connections)

---

## Testing Instructions

Run analysis on a test site:

```bash
node index.js --action agent \
  --url https://www.krisshop.com/en \
  --device mobile \
  --skip-cache
```

### Verify Phase 2 Improvements:

1. **Check agent findings JSON** (`.cache/*.suggestions.*.json`):
   ```bash
   cat .cache/*.suggestions.*.json | jq '.findings[0].reasoning'
   ```
   - ✅ Should see `observation`, `diagnosis`, `mechanism`, `solution` fields
   - ✅ Should reference specific data (file names, byte sizes, timings)

2. **Check reasoning quality**:
   - ✅ Observations cite exact numbers (KB, ms, percentages)
   - ✅ Diagnosis explains WHY it's a problem
   - ✅ Mechanism traces causal path to metric
   - ✅ Solution justifies the fix approach

3. **Check data usage**:
   - ✅ Coverage findings mention byte sizes (e.g., "1147KB unused")
   - ✅ HAR findings mention per-domain timings (e.g., "DNS: 120ms, SSL: 95ms")
   - ✅ HTML findings mention font strategy (e.g., "font-display: swap, not preloaded")

4. **Compare quality metrics**:
   - Root cause ratio should improve (target: 85%+, was 78%)
   - Confidence should remain high (target: >90%)
   - Findings should be more specific (actionable suggestions)

---

## Expected Output Format

### Before Phase 2:
```json
{
  "findings": [
    {
      "description": "High unused JavaScript",
      "evidence": { "source": "coverage", "reference": "34% unused" },
      "estimatedImpact": { "metric": "TBT", "reduction": 200 }
    }
  ]
}
```

### After Phase 2:
```json
{
  "findings": [
    {
      "description": "Remove 1147KB unused code from clientlib-site.js",
      "evidence": {
        "source": "coverage",
        "reference": "clientlib-site.js: 3348KB total, 1147KB unused (34%)"
      },
      "reasoning": {
        "observation": "clientlib-site.js is 3348KB total, with 1147KB unused code (34% waste)",
        "diagnosis": "Unused JavaScript is downloaded, parsed, and kept in memory despite never executing",
        "mechanism": "1147KB adds ~400ms download + ~150ms parse time, directly delaying TBT",
        "solution": "Tree-shaking removes 1147KB, eliminating overhead and improving TBT by ~550ms"
      },
      "estimatedImpact": { "metric": "TBT", "reduction": 550 }
    }
  ]
}
```

---

## Files Modified

1. **`src/prompts/shared.js`** (+67 lines)
   - Added `reasoning` field to AgentFinding schema (lines 153-159)
   - Added chain-of-thought documentation (lines 196-225)
   - Updated example finding with reasoning (lines 227-250)

2. **`src/prompts/analysis.js`** (+73 lines)
   - Added `getChainOfThoughtGuidance()` function (lines 219-289)
   - Updated 8 agent prompts to include guidance (lines 290-450)

**Total**: +140 lines across 2 files

---

## Next Steps

1. **Test on reference sites** (krisshop.com, qualcomm.com, adobe.com)
2. **Validate reasoning quality** (manual review of findings)
3. **Compare metrics** (root cause ratio, confidence, specificity)
4. **Adjust if needed** (refine examples, add more guidance)
5. **Proceed to Phase 3** (Causal Graph Builder) once validated

---

## Completion Status

- ✅ Reasoning field added to schema
- ✅ Chain-of-thought guidance created
- ✅ All 8 agent prompts updated
- ⏳ Testing pending

Phase 2 implementation is complete and ready for testing!
