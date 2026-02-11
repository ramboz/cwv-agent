# Testing Guide for Prompt Deduplication (Week 2-3)

## Overview

The prompt deduplication refactoring is complete. This guide explains how to test that the changes don't negatively impact output quality.

## What Changed

### Code Changes
- **Moved** `getChainOfThoughtGuidance()` to `shared.js` (47 lines)
- **Created** `src/prompts/templates/base-agent-template.js` (77 lines)
- **Refactored** all 9 agent prompt functions to use `createAgentPrompt()` template
- **Reduced** `analysis.js` from 2,500+ lines to 643 lines (74% reduction)

### What Should Stay the Same
✅ **Prompt content** - Identical agent prompts (just reorganized)
✅ **Agent findings** - Same analysis quality
✅ **Synthesis quality** - Same final suggestions
✅ **Token usage** - Should be lower (68% reduction expected)

### What Might Change (Expected)
📊 **Token count** - Should decrease by ~30,600 tokens per analysis
📊 **Synthesis context size** - Should be smaller due to fewer tokens

## Testing Plan

### Test Sites (From Plan)
1. **www.qualcomm.com** (mobile + desktop)
2. **www.adobe.com** (mobile + desktop)
3. **www.ups.com** (mobile + desktop)

### Test Commands

```bash
# Test 1: Qualcomm Mobile
node index.js --url https://www.qualcomm.com --device mobile

# Test 2: Adobe Mobile
node index.js --url https://www.adobe.com --device mobile

# Test 3: UPS Mobile
node index.js --url https://www.ups.com --device mobile

# Optional: Desktop tests
node index.js --url https://www.qualcomm.com --device desktop
node index.js --url https://www.adobe.com --device desktop
node index.js --url https://www.ups.com --device desktop
```

## What to Verify

### 1. Agent Execution
Check that all agents run without errors:
```bash
# Look for these in output:
✅ "CrUX Agent" findings
✅ "PSI Agent" findings
✅ "RUM Agent" findings (if RUM data available)
✅ "Performance Observer Agent" findings
✅ "HAR Agent" findings
✅ "HTML Agent" findings
✅ "Coverage Agent" findings
✅ "Code Review Agent" findings
✅ "Rules Agent" findings

# Should NOT see:
❌ Template rendering errors
❌ Missing sections in prompts
❌ Schema validation failures
```

### 2. Prompt Structure Validation
Manually inspect one agent's prompt by adding debug logging:

```javascript
// In src/prompts/analysis.js, temporarily add:
export function psiAgentPrompt(cms = 'eds') {
  const examples = `...`;
  const prompt = createAgentPrompt({...});
  console.log('=== PSI AGENT PROMPT ===');
  console.log(prompt);
  console.log('=== END PROMPT ===');
  return prompt;
}
```

Verify the prompt includes:
- ✅ "You are analyzing PageSpeed Insights/Lighthouse results..."
- ✅ Data priority guidance section
- ✅ Chain-of-thought reasoning section
- ✅ "## Few-Shot Examples" header
- ✅ Examples content
- ✅ "## Your Analysis Focus"
- ✅ PHASE_FOCUS content
- ✅ Structured output format section

### 3. Output Quality Comparison

#### Finding Quality
Compare agent findings before/after refactoring:
- **Finding count**: Should be similar (±2 findings acceptable)
- **Evidence quality**: Should reference same sources
- **Confidence scores**: Should be comparable
- **Impact estimates**: Should be similar magnitude

#### Synthesis Quality
Compare final suggestions:
- **Suggestion count**: Should be similar (±1 suggestion)
- **Root cause identification**: Should find same root causes
- **Code changes**: Should provide similar code examples
- **Practical recommendations**: Should be actionable

### 4. Token Usage Measurement

Check synthesis context size in logs:
```bash
# Look for lines like:
"Synthesis context: X tokens"

# Expected reduction:
Before: ~45,000 tokens (9 agents × 5,000)
After:  ~14,400 tokens (9 agents × 1,600)
Reduction: ~30,600 tokens (68%)
```

### 5. Performance Check

Time the analysis run:
```bash
time node index.js --url https://www.qualcomm.com --device mobile
```

Expected timing should be similar or slightly faster:
- **Data collection**: No change expected
- **Agent analysis**: May be slightly faster (fewer tokens to process)
- **Synthesis**: May be slightly faster (smaller context)

## Success Criteria

### Must Pass ✅
- [ ] All 9 agents execute without errors
- [ ] Prompts include all required sections
- [ ] Finding count within ±20% of baseline
- [ ] Synthesis produces actionable suggestions
- [ ] No schema validation errors

### Should Verify ✅
- [ ] Token usage reduced by ~60-70%
- [ ] Similar finding quality (evidence, confidence, impact)
- [ ] Similar synthesis quality (root causes, code changes)
- [ ] No significant performance regression

### Nice to Have 🎯
- [ ] Faster synthesis due to smaller context
- [ ] Clearer agent outputs
- [ ] More consistent finding formats

## Baseline Comparison (If Available)

If you have previous analysis results, compare:

### Quantitative Metrics
```bash
# Count findings per agent
cat .cache/*.suggestions.json | jq '.findings | group_by(.evidence.source) | map({source: .[0].evidence.source, count: length})'

# Count final suggestions
cat .cache/*.suggestions.json | jq '.suggestions | length'

# Measure token usage
grep "Synthesis context" logs/*.log
```

### Qualitative Review
1. Read 2-3 agent findings - are they specific and actionable?
2. Read final synthesis - does it identify root causes?
3. Check code changes - are they concrete and helpful?

## Common Issues & Fixes

### Issue: Missing Examples Section
**Symptom**: Prompt has no "## Few-Shot Examples" section
**Cause**: Examples passed as empty string
**Fix**: Check that Rules and Code agents explicitly pass `examples: ''`

### Issue: Duplicate PHASE_FOCUS
**Symptom**: "## Your Analysis Focus" appears twice in prompt
**Cause**: additionalContext includes PHASE_FOCUS when it shouldn't
**Fix**: Only use additionalContext for truly unique content (e.g., lightMode)

### Issue: Template Rendering Error
**Symptom**: `${PHASE_FOCUS[focusKey]} is not defined`
**Cause**: focusKey doesn't match PHASE_FOCUS object key
**Fix**: Verify focusKey in createAgentPrompt() call matches shared.js PHASE_FOCUS

### Issue: Schema Validation Failure
**Symptom**: "Invalid agent finding" errors
**Cause**: Prompt changes affect agent output structure
**Fix**: Review agent output, ensure structured format section is correct

## Rollback Plan (If Needed)

If testing reveals issues:

```bash
# View recent commits
git log --oneline -5

# Rollback to before deduplication
git revert HEAD~2..HEAD

# Or reset to before Week 2-3 work
git reset --hard <commit-before-deduplication>
```

Then file an issue with:
- Which test failed
- Error messages
- Example of incorrect output
- Comparison to expected output

## Expected Test Results

### Qualcomm Mobile
- **Agents**: Should run 6-8 agents (depends on PSI gating)
- **Findings**: ~15-25 findings across all agents
- **Suggestions**: ~4-6 final suggestions
- **Common issues**: LCP (large images), TBT (JavaScript), TTFB

### Adobe Mobile
- **Agents**: Should run 7-9 agents
- **Findings**: ~20-30 findings (complex site)
- **Suggestions**: ~5-7 final suggestions
- **Common issues**: LCP, INP, third-party scripts

### UPS Mobile
- **Agents**: Should run 6-8 agents
- **Findings**: ~15-25 findings
- **Suggestions**: ~4-6 final suggestions
- **Common issues**: LCP, CLS, render-blocking resources

## Next Steps After Testing

### If Tests Pass ✅
1. Update plan with "Week 2-3: COMPLETE ✅"
2. Proceed to Week 4: Signal Extraction Service
3. Consider adding examples to Rules/Code agents (optional)

### If Tests Fail ❌
1. Document failing test case
2. Identify root cause (template issue vs agent-specific)
3. Fix issue
4. Re-test on failing site
5. Test on other 2 sites to verify fix

## Manual Testing Checklist

For each site:
- [ ] Run analysis command
- [ ] Check for errors in output
- [ ] Verify all expected agents ran
- [ ] Review 2-3 agent findings for quality
- [ ] Review final synthesis for root causes
- [ ] Check token usage in logs
- [ ] Note timing (optional)

## Automated Testing (Future)

Consider adding to test suite:
```javascript
describe('Prompt Template System', () => {
  it('should generate valid prompts for all agents', () => {
    const agents = [
      'crux', 'psi', 'rum', 'perfObserver',
      'har', 'html', 'coverage', 'code', 'rules'
    ];
    agents.forEach(agent => {
      const prompt = generatePrompt(agent);
      expect(prompt).toContain('You are');
      expect(prompt).toContain('Chain-of-Thought');
      expect(prompt).toContain('Your Analysis Focus');
    });
  });
});
```

## Conclusion

This testing phase validates that the 74% code reduction and 68% token reduction from prompt deduplication **does not** negatively impact the quality of CWV analysis or suggestions.

**Estimated testing time**: 30-60 minutes for all 3 sites (mobile only)
**Estimated testing time**: 1-2 hours for all 6 tests (mobile + desktop)
