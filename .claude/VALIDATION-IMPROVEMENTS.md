# Validation Improvements - Reducing Blocked Findings

**Date**: January 29, 2026
**Context**: User found 2 findings blocked by validation that seemed like "obvious fixes"
**Goal**: Improve prompts and validation rules to reduce false blocks

---

## Blocked Findings Analysis

### Finding 1: `crux-cls-1` - CLS Field Data
**Error**: "Evidence reference too vague (must be >10 chars with specifics)"

**Evidence Provided**:
```json
"evidence": {
  "source": "crux",
  "reference": "CLS: 1.81",  // 9 characters
  "confidence": 1
}
```

**Why It Was Blocked**:
- Validation rule requires `minReferenceLength: 10` characters
- Reference is 9 characters (just 1 char short)

**Root Cause**:
- Validation rule was designed for **lab data** (PSI audits, HAR entries, code files)
- Lab data naturally has longer references: "PSI render-blocking-resources audit: 3 scripts, 850ms savings"
- **Field data (CrUX/RUM) is inherently aggregate** - there are NO specific files, line numbers, or audit names
- "CLS: 1.81" is actually the most specific reference possible for CrUX field data

**Is This a Real Problem?**
- ❌ **NO** - The evidence IS sufficiently specific for field data
- The finding has excellent reasoning with concrete improvement plan (font-display: swap, size-adjust)
- Blocking this finding reduces report quality

---

### Finding 2: `code-js-cloudflare-1` - Cloudflare Scripts
**Error**: "Root cause depth too shallow: null (should be >1)"

**Graph State**:
```json
{
  "id": "code-js-cloudflare-1",
  "depth": null,  // ❌ Should be >= 1
  "isRootCause": true,
  "causes": ["perf-inp-1"],  // Has outgoing edge
  "causedBy": []  // No incoming edges
}
```

**Why Depth is Null**:
- The `calculateDepths()` BFS algorithm starts from metric nodes (depth 0)
- Traverses backwards via `node.causes` array to assign depths
- `code-js-cloudflare-1` was never reached by BFS

**Root Cause**:
- **Edge direction error** in causal graph builder
- Edge created: `perf-inp-1` → `code-js-cloudflare-1` (WRONG)
- Should be: `code-js-cloudflare-1` → `perf-inp-1` (code causes the long task)

**Graph Builder Mistake**:
```json
{
  "from": "perf-inp-1",  // ❌ Observation (effect)
  "to": "code-js-cloudflare-1",  // ❌ Code pattern (cause)
  "relationship": "contributes",
  "mechanism": "Both findings relate to main.js"  // Weak reasoning
}
```

**Correct Direction**:
```
code-js-cloudflare-1 (depth 2: code pattern - CPU-intensive scripts)
  ↓ causes
perf-inp-1 (depth 1: observed long task - 1.5s blocking)
  ↓ causes
metric-inp (depth 0: poor INP metric)
```

**Why This Happened**:
- Code Agent output: "scripts are **likely** blocking" (hypothesis)
- Perf Observer Agent output: "1.5s long task **observed**" (fact)
- Graph builder treated observation as "contributing to" hypothesis instead of hypothesis explaining observation
- Weak mechanism text ("Both findings relate to main.js") suggests graph builder wasn't confident about direction

---

## Implemented Fixes

### Fix 1: Exempt Field Data from Length Requirement ✅

**File**: `src/models/validation-rules.js`
**Lines**: 183-189

**Before**:
```javascript
// Check reference quality
const ref = evidence.reference || '';
if (ref.length < ValidationRules.EVIDENCE.minReferenceLength) {
  errors.push('Evidence reference too vague (must be >10 chars with specifics)');
}
```

**After**:
```javascript
// Check reference quality
const ref = evidence.reference || '';
const isFieldData = evidence.source === 'crux' || evidence.source === 'rum';

// Field data (CrUX/RUM) is aggregate - no file-level specificity exists
// Allow shorter references for field data (e.g., "CLS: 1.81" is specific enough)
if (!isFieldData && ref.length < ValidationRules.EVIDENCE.minReferenceLength) {
  errors.push('Evidence reference too vague (must be >10 chars with specifics)');
}
```

**Impact**:
- ✅ `crux-cls-1` will now pass validation
- ✅ Future CrUX/RUM findings won't be blocked by length requirement
- ✅ Lab data still requires 10+ character references (unchanged)

---

### Fix 2: Improve CrUX Agent Evidence Guidance ✅

**File**: `src/prompts/shared.js`
**Lines**: 282-295

**Added Section**:
```javascript
**Evidence Requirements for Field Data**:
- CrUX evidence references must include BOTH metric name AND value with percentile
- ✅ GOOD: "CLS p75: 1.81 (poor, 18x threshold)" or "LCP p75: 3500ms, FCP p75: 1800ms"
- ❌ BAD: "CLS: 1.81" (too short, missing context)
- Include distribution data when relevant: "75% of users experience CLS > 0.25"
- Reference histogram bins for severity context: "good: 15%, needs-improvement: 20%, poor: 65%"
```

**Impact**:
- Future CrUX findings will include richer context (percentile, threshold comparison, distribution)
- Makes evidence more actionable even though it's still field data
- Example: "CLS p75: 1.81 (poor, 18x threshold of 0.1)" is 44 characters, well above 10-char minimum

---

### Fix 3: Add Edge Direction Rules to Graph Builder Prompt ✅

**File**: `src/prompts/analysis.js`
**Lines**: 715-747 (new section)

**Added Section**:
```markdown
## Critical: Edge Direction Rules ⚠️

**Always create edges in this direction**: **Fundamental Cause → Observed Effect**

Common patterns to follow:

1. **Code patterns → Performance observations**
   - ✅ CORRECT: code-pattern-id → perf-observation-id
   - ❌ WRONG: perf-observation-id → code-pattern-id
   - Example: "Code review finds render-blocking script" → "Perf Observer sees 420ms delay"

2. **Configuration issues → Metric failures**
   - ✅ CORRECT: html-missing-preload → har-slow-fetch → metric-lcp
   - ❌ WRONG: metric-lcp → html-missing-preload

3. **Hypotheses (Code Agent) → Facts (Perf/HAR Agent)**
   - ✅ CORRECT: code-js-cloudflare-1 (hypothesis: "scripts likely block") → perf-inp-1 (fact: "1.5s long task observed")
   - ❌ WRONG: perf-inp-1 (observation) → code-js-cloudflare-1 (explanation)
   - **Rule**: When Code Agent hypothesizes about a pattern and Perf/HAR Agent observes the actual impact, the code pattern is the cause, the observation is the effect

4. **Root cause checking**:
   - If finding A describes "why" something happens → A is likely a cause
   - If finding B describes "what" happens → B is likely an effect
   - Example: "Missing dimensions" (why) → "Layout shift" (what)

**When in doubt**: Ask "Which happened first in the causal chain?" - that's the 'from' node.
```

**Impact**:
- Explicitly guides graph builder on edge direction for common confusions
- Specifically addresses Code Agent (hypothesis) → Perf Agent (observation) pattern
- Provides the exact example of the mistake made: `code-js-cloudflare-1` → `perf-inp-1`
- Future graphs should have correct edge directions → all nodes reachable → depths calculated correctly

---

### Fix 4: Add Code Review Evidence Guidance ✅

**File**: `src/prompts/shared.js`
**Lines**: 375-389 (new section)

**Added Section**:
```javascript
**Evidence Requirements for Code Review**:
- Code evidence must reference specific files with context (>10 chars)
- ✅ GOOD: "Files: main.js and /d251aa49a8a3/main.js from cdn-cgi/challenge-platform" or "clientlib-site.js:L45 uses blocking fetch()"
- ❌ BAD: "main.js" (too short, no context)
- Include line numbers when possible for specific patterns
- Reference multiple related files together for pattern-based findings
- When hypothesizing about performance impact, note that you're predicting (use "likely", "may", "could") since Code Agent doesn't see actual execution data
```

**Impact**:
- Code Agent will provide longer, more contextual evidence references
- Example shows EXACTLY the pattern needed: "Files: main.js and /d251aa49a8a3/main.js from cdn-cgi/challenge-platform" (81 characters)
- Reminds Code Agent it's making predictions, which should be validated by Perf/HAR observations

---

## Expected Results After Fixes

### For `crux-cls-1`:
**Before Fix**:
- Evidence: "CLS: 1.81" (9 chars)
- Result: ❌ BLOCKED

**After Fix 1 (Validation)**:
- Evidence: "CLS: 1.81" (9 chars)
- Result: ✅ APPROVED (field data exempted from 10-char min)

**After Fix 2 (Prompt)**:
- Evidence: "CLS p75: 1.81 (poor, 18x threshold of 0.1)" (44 chars)
- Result: ✅ APPROVED with richer context

---

### For `code-js-cloudflare-1`:
**Before Fix**:
- Edge: `perf-inp-1` → `code-js-cloudflare-1` (WRONG direction)
- Depth: null (not reachable via BFS)
- Result: ❌ BLOCKED

**After Fix 3 (Graph Builder Prompt)**:
- Edge: `code-js-cloudflare-1` → `perf-inp-1` (CORRECT direction)
- Depth: 2 (code → observation → metric)
- Result: ✅ APPROVED

**After Fix 4 (Code Agent Prompt)**:
- Evidence: "Files: main.js and /d251aa49a8a3/main.js from cdn-cgi/challenge-platform" (already good, 81 chars)
- Result: ✅ Maintains current quality

---

## Testing Plan

### Test Case 1: Re-run Qualcomm Analysis
```bash
node index.js --action agent --url https://www.qualcomm.com --device mobile --skip-cache
```

**Expected Results**:
1. ✅ `crux-cls-1` should pass validation (field data exemption)
2. ✅ `code-js-cloudflare-1` should have `depth: 2` (correct edge direction)
3. ✅ Both findings should appear in final suggestions (not blocked)
4. ✅ Root Cause Analysis section should show proper data (already fixed via rootCauseImpacts scope fix)

**Validation Summary Should Show**:
```
✅ Findings Validation: 24 approved, 9 adjusted, 0 blocked
   No blocked findings!
```

---

### Test Case 2: Verify Field Data Handling
Run on site with poor CrUX metrics but good lab metrics:
```bash
node index.js --action agent --url https://example-site-with-bad-crux.com --device mobile --skip-cache
```

**Expected**:
- CrUX findings should pass validation even with short references like "INP: 450ms"
- Evidence should now include richer context: "INP p75: 450ms (poor, 2.25x threshold)"

---

### Test Case 3: Verify Code→Perf Edge Direction
Manually inspect `.cache/*.causal-graph.*.json` for:
```bash
cat .cache/www-qualcomm-com.mobile.causal-graph.gemini25pro.json | jq '.edges[] | select(.from | startswith("code-")) | {from, to, relationship}'
```

**Expected**:
- All `code-*` findings should have edges going TO `perf-*` or `har-*` findings
- No edges FROM `perf-*` TO `code-*` (observations don't cause code patterns)

---

## Files Modified

1. **`src/models/validation-rules.js`**
   - Lines 183-189: Added field data exemption for reference length check
   - Impact: Prevents blocking CrUX/RUM findings with short but valid references

2. **`src/prompts/shared.js`**
   - Lines 282-295: Added evidence requirements for CrUX agent
   - Lines 375-389: Added evidence requirements for Code Review agent
   - Impact: Guides agents to provide richer, more specific evidence

3. **`src/prompts/analysis.js`**
   - Lines 715-747: Added "Critical: Edge Direction Rules" section to causal graph builder prompt
   - Impact: Prevents backwards edges that break depth calculation

---

## Why These Were "Obvious Fixes" That Failed

### Issue 1: crux-cls-1 (CLS: 1.81)
**Why it seemed obvious**:
- CLS score of 1.81 is catastrophically bad (18x the threshold)
- Finding has excellent reasoning with concrete solution (font-display: swap, size-adjust)
- All other evidence fields are perfect (confidence: 1.0, clear mechanism)

**Why it failed**:
- Arbitrary 10-character threshold applied universally without considering data source type
- Field data fundamentally cannot have file-level references
- The validation rule didn't account for the nature of CrUX data

**Lesson**: Validation rules must consider **data source characteristics**, not just apply universal thresholds

---

### Issue 2: code-js-cloudflare-1 (Cloudflare scripts)
**Why it seemed obvious**:
- Code Agent correctly identified Cloudflare bot detection scripts
- Perf Agent observed the exact 1.5s long task those scripts caused
- The causal connection is clear and well-reasoned

**Why it failed**:
- Causal graph builder created edge in backwards direction
- Without correct edge direction, depth calculation fails
- Without depth, root cause validation fails

**Lesson**: LLMs can make directional errors when connecting hypotheses to observations. Need explicit guidance on **cause (hypothesis/pattern) → effect (observation/fact)** direction.

---

## Summary

**Root Issues**:
1. **Overly strict validation** - 10-char minimum doesn't fit field data
2. **Missing edge direction rules** - Graph builder confused cause vs effect

**Fixes Implemented**:
1. ✅ Exempt field data from length requirement (validation-rules.js)
2. ✅ Guide CrUX agent to provide richer references (shared.js)
3. ✅ Add explicit edge direction rules to graph builder (analysis.js)
4. ✅ Guide Code agent on evidence quality (shared.js)

**Expected Impact**:
- **Before**: 2/33 findings blocked (6% block rate)
- **After**: 0/33 findings blocked (0% block rate) - assuming no other validation errors
- Both findings are legitimate and should appear in final suggestions
- Future runs will have better edge directions and richer field data evidence

**Next Step**: Re-run Qualcomm analysis with `--skip-cache` to verify fixes work
