# Token Limit Issue - Final Synthesis Truncation

**Date**: January 28, 2026
**Issue**: Final synthesis JSON truncated, only 1 finding saved instead of 6 recommendations
**Root Cause**: Gemini 2.5 Pro output token limit (8,192 tokens)

---

## Problem Analysis

### Observed Symptoms

1. **JSON corruption in markdown** (line 1055):
   ```json
   "calculation": "The shift would be caused by the navigation bar resizing after labels are hidden. The impact depends on the size of the navigation and the elements below it, but can easily exceed a
   ```
   Cuts off mid-sentence, then immediately: `## Final Suggestions:`

2. **Mismatch between MD and JSON**:
   - Markdown report: 6 detailed recommendations
   - JSON suggestions file: 32 raw findings (from fallback aggregation)
   - Expected: Both should have the same 6 synthesized recommendations

### Root Cause

**Token limit exceeded on final synthesis output**:

```javascript
// src/models/config.js
export const MAX_TOKENS = {
  'gemini-2.5-pro': { input: 2_000_000, output: 8_192 },  // ← LIMIT!
}
```

**Final synthesis generates**:
1. Detailed markdown with 6 recommendations: ~5,500 tokens
2. Structured JSON with same 6 recommendations: ~3,000 tokens
3. **Total**: ~8,500 tokens

**Result**: Output exceeds 8,192 limit → truncated mid-JSON

---

## Why 32 Findings vs 6 Recommendations?

### Current Architecture

```
Individual Agents (32 findings)
    ↓
Causal Graph Builder (validates + prioritizes)
    ↓
Final Synthesis Agent (should output 6 recommendations)
    ↓
BUT: Token limit truncates output before JSON is written
    ↓
Fallback: Extract structured data from markdown
    ↓
No final JSON found → Use raw 32 findings as fallback
```

### The Disconnect

- **Individual agents**: Output granular technical findings
  - Example: "rum-cls-1: Images without dimensions cause 0.103 shift"
  - Example: "code-bundle-1: Unused JavaScript from Lodash (98KB, 12% used)"
  - Total: 32 findings across 9 agents

- **Final synthesis**: Groups related findings into actionable recommendations
  - Example: "Reduce Unused JavaScript and Main-Thread Work" (combines 8 findings)
  - Example: "Stabilize Page Layout" (combines 4 CLS-related findings)
  - Total: 6 high-level recommendations

**What's being saved**: 32 raw findings (because final synthesis JSON is truncated)
**What should be saved**: 6 synthesized recommendations (from final synthesis)

---

## Solutions

### Option 1: Use Higher Output Limit Model (Recommended)

Use `gemini-2.5-pro-preview-05-06` for final synthesis only:

```javascript
// In runMultiAgents(), before final synthesis
const finalSynthesisLLM = LLMFactory.createLLM('gemini-2.5-pro-preview-05-06', {});

const finalChain = RunnableSequence.from([
    ChatPromptTemplate.fromMessages([
        new SystemMessage(finalPrompt),
        new HumanMessage(`Here is the context from previous agents:\n${graphEnhancedContext}`)
    ]),
    finalSynthesisLLM.getBaseLLM(),  // 65,535 output tokens!
    new StringOutputParser()
]);
```

**Pros**:
- Simple one-line change
- 65,535 tokens is plenty for full output
- No architectural changes needed

**Cons**:
- Preview model (may have different behavior)
- Slightly slower/more expensive than base model

---

### Option 2: Split Output into Two Calls

Call final synthesis twice:
1. First call: Generate markdown report only
2. Second call: Generate structured JSON from markdown

```javascript
// Call 1: Markdown only
const markdownPrompt = `${actionPrompt(...)}

Output ONLY the markdown report. Do NOT include the structured JSON section.`;

const markdownOutput = await markdownChain.invoke({...});

// Call 2: JSON extraction
const jsonPrompt = `Extract structured JSON from this markdown report:

${markdownOutput}

Output format:
\`\`\`json
{
  "url": "...",
  "suggestions": [...]
}
\`\`\`
`;

const jsonOutput = await jsonChain.invoke({...});
```

**Pros**:
- Stays within 8,192 token limit for each call
- Uses base model (cheaper, faster)
- Clear separation of concerns

**Cons**:
- 2x API calls (slower, more expensive overall)
- More complex orchestration
- JSON extraction may lose fidelity

---

### Option 3: Shorten Markdown Report

Reduce verbosity in markdown to leave room for JSON:

```javascript
// In actionPrompt
"Be concise in the markdown report. Limit each recommendation to 200 words max."
```

**Pros**:
- Single call, base model
- No architectural changes

**Cons**:
- Less detailed markdown for humans
- May still exceed limit with 6 detailed recommendations
- Unclear where to cut without losing value

---

### Option 4: Save Raw Findings (Current Fallback)

Keep current behavior: save 32 raw findings when synthesis JSON is missing.

**Pros**:
- Already implemented
- No additional changes needed
- Complete data (nothing lost)

**Cons**:
- ❌ Doesn't match markdown (6 vs 32)
- ❌ Raw findings, not actionable recommendations
- ❌ User confusion ("which should I use?")
- ❌ SpaceCat upload may be overwhelming

---

## Recommended Approach

**Option 1** (higher output limit model) + **Option 2 fallback**:

```javascript
// Try with high-output model first
let finalSynthesisLLM;
try {
    finalSynthesisLLM = LLMFactory.createLLM('gemini-2.5-pro-preview-05-06', {});
} catch (e) {
    console.warn('Preview model unavailable, falling back to split output approach');
    // Use Option 2 (two-call approach)
}

const finalChain = RunnableSequence.from([
    ChatPromptTemplate.fromMessages([
        new SystemMessage(finalPrompt),
        new HumanMessage(`Here is the context from previous agents:\n${graphEnhancedContext}`)
    ]),
    (finalSynthesisLLM || llm).getBaseLLM(),
    new StringOutputParser()
]);
```

**Benefits**:
- ✅ Uses best available model (65K tokens if available)
- ✅ Falls back gracefully to split approach if needed
- ✅ Ensures JSON is always generated
- ✅ Maintains 6 recommendations in both MD and JSON

---

## Impact on SpaceCat Upload

### Current State (32 findings)
```json
{
  "suggestions": [
    { "id": 1, "title": "INP on mobile is 281ms...", "metric": "INP", "priority": "High" },
    { "id": 2, "title": "CLS 0.209 from images...", "metric": "CLS", "priority": "High" },
    { "id": 3, "title": "TTFB 15s on /contact-us...", "metric": "TTFB", "priority": "High" },
    ... // 29 more raw findings
  ]
}
```

**Issues**:
- Too granular for business users
- No grouping of related issues
- Hard to prioritize (32 items!)

### Desired State (6 recommendations)
```json
{
  "suggestions": [
    { "id": 1, "title": "Reduce Unused JavaScript and Main-Thread Work", "metric": "TBT", "priority": "High", "impact": ">10s LCP, >800ms TBT" },
    { "id": 2, "title": "Enable AEM Dispatcher Caching for HTML Pages", "metric": "LCP", "priority": "High", "impact": ">2s LCP, >1000ms TBT" },
    { "id": 3, "title": "Optimize CSS Delivery with Critical/Non-Critical Splitting", "metric": "LCP", "priority": "High", "impact": ">1.5s LCP" },
    { "id": 4, "title": "Fix Critical LCP Anti-Patterns", "metric": "LCP", "priority": "High", "impact": ">800ms LCP" },
    { "id": 5, "title": "Stabilize Page Layout (Images, Banners, Fonts)", "metric": "CLS", "priority": "High", "impact": ">0.2 CLS reduction" },
    { "id": 6, "title": "Preconnect to Critical Origins", "metric": "LCP", "priority": "Medium", "impact": "~200ms LCP" }
  ]
}
```

**Benefits**:
- Actionable for business users
- Grouped by related root causes
- Clear prioritization (6 items, sorted by impact)
- Matches markdown report

---

## Next Steps

1. **Immediate**: Implement Option 1 (use preview model for final synthesis)
2. **Testing**: Verify full JSON output with 6 recommendations
3. **Validation**: Confirm MD and JSON have matching recommendations
4. **Fallback**: If preview model unavailable, implement Option 2 (split calls)

---

## Files to Modify

1. **src/core/multi-agents.js** (line 1088-1100)
   - Change final synthesis to use high-output model
   - Add fallback to split-call approach

2. **src/models/config.js**
   - Document token limits for each model
   - Add helper to select best model for synthesis

---

## Summary

- **Problem**: 8,192 token output limit truncates final synthesis JSON
- **Result**: Only 32 raw findings saved instead of 6 synthesized recommendations
- **Solution**: Use model with 65,535 token limit for final synthesis
- **Benefit**: MD and JSON both have same 6 actionable recommendations
