# CWV Agent: Usage & Troubleshooting Guide

## Quick Start

### Basic Usage

Analyze a single URL:
```bash
node index.js --action agent \
  --url https://www.example.com \
  --device mobile
```

### Common Options

```bash
# Desktop analysis
node index.js --action agent --url https://www.example.com --device desktop

# Skip cache (force fresh data collection)
node index.js --action agent --url https://www.example.com --device mobile --skip-cache

# Use specific model
node index.js --action agent --url https://www.example.com --device mobile --model gemini-2.5-flash

# Analyze multiple URLs
node index.js --action agent \
  --url https://www.example.com \
  --url https://www.example.com/about \
  --device mobile
```

---

## Understanding the Output

### Console Output

```
Running agent for 1 URL(s) on mobile...
Using model: gemini-2.5-pro
Processing: https://www.example.com/
  ✅ Processed CrUX data. Estimated token size: ~ 595
  ✅ Processed PSI data. Estimated token size: ~ 45120
  ✅ Processed HAR data. Estimated token size: ~ 0
  ...
  Starting multi-agent flow...
    - with → har: false, coverage: true, code: true
    - using 8 agent(s): CrUX, RUM, PSI, Perf Observer, HTML, Rules, Code Coverage, Code Review
    🔄 Executing batch 1/4 (2 agents)...
    ✅ CrUX Agent (25%, 51.4s)
    ...
    📊 Quality Metrics: 31 findings, avg confidence: 92.6%, 25 root causes
    - building causal graph...
    🕸️  Causal Graph: 26 root causes, 41 critical paths
    - validating findings...
    ✅ Validation: 15 approved, 16 adjusted, 0 blocked
    ...
  ✅ CWV report generated at: .cache/*.report.*.md
  ✅ Structured suggestions saved at: .cache/*.suggestions.*.json
```

**Key Indicators**:
- `har: false` - HAR agent didn't run (conditional gating)
- `31 findings, 92.6% confidence` - High quality findings
- `26 root causes` - Strategic focus
- `15 approved, 16 adjusted, 0 blocked` - Validation working

### Output Files

**Location**: `.cache/` directory

**Files**:
1. `*.report.*.summary.md` - Human-readable markdown report
2. `*.suggestions.*.json` - Machine-readable suggestions
3. `*.causal-graph.*.json` - Causal graph data
4. `*.validation.*.json` - Validation results
5. `*.validation-report.*.md` - Validation report
6. `*.quality-metrics.*.json` - Quality metrics (pre/post validation)

---

## Reading the Reports

### Markdown Report

```markdown
# Core Web Vitals Analysis Report

## Executive Summary

URL: https://www.example.com
Device: Mobile
Analysis Date: 2026-01-27

### Current Metrics
- LCP: 4.5s (target: ≤2.5s) ❌ POOR
- CLS: 0.08 (target: ≤0.1) ⚠️ NEEDS IMPROVEMENT
- INP: 450ms (target: ≤200ms) ❌ POOR

### Key Recommendations
1. Remove 1147KB unused code [HIGH PRIORITY]
   - Impact: 400ms TBT + 200ms INP (cascading)
   ...
```

**How to Read**:
- **Executive Summary**: Quick overview of pass/fail metrics
- **Key Recommendations**: Top 3-5 suggestions (root causes first)
- **Detailed Recommendations**: Full implementation details with code examples

### Structured JSON

```json
{
  "url": "https://www.example.com",
  "deviceType": "mobile",
  "timestamp": "2026-01-27T...",
  "suggestions": [
    {
      "id": 1,
      "title": "Remove 1147KB unused code",
      "description": "...",
      "metric": "TBT",
      "priority": "High",
      "effort": "Medium",
      "impact": "400ms TBT + 200ms INP (cascading)",
      "implementation": "Replace full library imports...",
      "codeExample": "File: /apps/myproject/...",
      "category": "javascript",
      "rootCause": true,
      "affectedFindings": ["psi-tbt-1", "perf-inp-1"],
      "causalChain": "Full imports → unused code → blocking → TBT → INP"
    }
  ]
}
```

**Key Fields**:
- `rootCause: true` - Strategic fix (prioritize these)
- `affectedFindings` - Traces back to agent findings
- `causalChain` - Shows dependency path
- `codeExample` - Copy-paste ready code

### Causal Graph

```json
{
  "nodes": {
    "psi-lcp-1": {
      "type": "bottleneck",
      "description": "Render-blocking scripts delay LCP",
      "depth": 1,
      "isRootCause": false
    },
    "coverage-unused-1": {
      "type": "waste",
      "description": "1147KB unused code",
      "depth": 2,
      "isRootCause": true
    }
  },
  "edges": [
    {
      "from": "coverage-unused-1",
      "to": "psi-lcp-1",
      "relationship": "causes",
      "strength": 0.8
    }
  ],
  "rootCauses": ["coverage-unused-1"],
  "criticalPaths": [
    ["coverage-unused-1", "psi-lcp-1", "metric-lcp"]
  ]
}
```

**How to Use**:
- Identify root causes: `isRootCause: true` or in `rootCauses` array
- Follow critical paths: shows full dependency chains
- Visualize: Export to Graphviz DOT format

---

## Troubleshooting

### Issue: HAR Collection Not Triggering

**Symptom**:
```
✅ Processed HAR data. Estimated token size: ~ 0
Starting multi-agent flow...
  - with → har: false, coverage: true, code: true
```

**Cause**: Conditional gating requires 2+ signals:
- High request count (>150 mobile, >180 desktop)
- High transfer bytes (>3MB mobile, >3.5MB desktop)
- Redirects detected
- Slow server response (TTFB)
- Render-blocking scripts

**Solutions**:
1. **Check PSI metrics**: If site passes thresholds, HAR may not be needed
2. **Force collection** (temporary): Modify `src/core/multi-agents.js` line 646:
   ```javascript
   // Before
   const shouldRunHar = harSignals.filter(Boolean).length >= 2;

   // After (force always)
   const shouldRunHar = true;
   ```
3. **Lower thresholds**: Adjust `DEFAULT_THRESHOLDS` in `src/core/multi-agents.js`

**Note**: This is working as designed - HAR is expensive and only runs when needed.

### Issue: No RUM Data

**Symptom**:
```
Processing: https://www.example.com/
  ✅ Processed CrUX data. Estimated token size: ~ 595
  (no RUM line)
```

**Cause**: RUM requires `RUM_DOMAIN_KEY` environment variable

**Solutions**:
1. **Set RUM domain key**:
   ```bash
   export RUM_DOMAIN_KEY=<your-helix-rum-key>
   ```
2. **Alternative**: Use CrUX INP data (less granular but available for all sites)

**Note**: RUM provides better INP insights but requires Helix setup.

### Issue: High Token Usage / Context Limits

**Symptom**:
```
✅ Processed coverage data. Estimated token size: ~ 393971
Error: Context length exceeded
```

**Cause**: Very large site with extensive coverage data

**Solutions**:
1. **Use faster model** with larger limits:
   ```bash
   node index.js --action agent --url ... --model gemini-2.5-pro
   ```
2. **Skip coverage** (temporary): Set environment variable:
   ```bash
   SKIP_COVERAGE=true node index.js --action agent --url ...
   ```
3. **Reduce scope**: Analyze specific pages instead of entire site

### Issue: Low Confidence Scores

**Symptom**:
```
📊 Quality Metrics: 31 findings, avg confidence: 45.2%, 5 root causes
```

**Cause**: Weak evidence or insufficient data

**Solutions**:
1. **Check data collection**: Ensure all collectors ran successfully
2. **Verify metrics**: Run with `--skip-cache` to get fresh data
3. **Review validation report**: Check `.cache/*.validation-report.*.md` for specific issues
4. **Expected for field data**: CrUX/RUM have inherent limitations (no file-level data)

**Confidence Guidance**:
- >80%: High confidence, implement immediately
- 60-80%: Medium confidence, validate before implementing
- <60%: Low confidence, investigate further or skip

### Issue: Validation Blocking Too Many Findings

**Symptom**:
```
✅ Validation: 5 approved, 10 adjusted, 16 blocked
```

**Cause**: Strict validation rules blocking low-quality findings

**Solutions**:
1. **Check blocked reasons**: Review `.cache/*.validation-report.*.md`
2. **Adjust validation config**: Modify `src/core/multi-agents.js` line 807:
   ```javascript
   const validationResults = validateFindings(allFindings, causalGraph, {
       blockingMode: true,   // Set to false to disable blocking
       adjustMode: true,
       strictMode: false,    // Set to true to also block warnings
   });
   ```
3. **Adjust thresholds**: Modify `ValidationRules` in `src/models/validation-rules.js`

**Note**: Blocking is intentional - ensures only high-quality suggestions reach users.

### Issue: Agents Not Using Chain-of-Thought

**Symptom**: Findings lack `reasoning` field in JSON output

**Cause**: Phase 2 not active or prompt issue

**Solutions**:
1. **Verify Phase 2**: Check `src/prompts/analysis.js` includes `getChainOfThoughtGuidance()`
2. **Check model**: Some models may ignore reasoning instructions (use Gemini 2.5 Pro)
3. **Review agent outputs**: Check `.cache/*.suggestions.*.json` for `reasoning` field

### Issue: No Root Causes Identified

**Symptom**:
```
🕸️  Causal Graph: 0 root causes, 5 critical paths
```

**Cause**: Causal graph couldn't identify root causes (all findings have incoming edges)

**Solutions**:
1. **Check findings**: Ensure agents marked some findings as `rootCause: true`
2. **Review graph**: Check `.cache/*.causal-graph.*.json` for node depths
3. **Expected behavior**: Some sites have only symptoms (e.g., all issues are direct causes)

**Note**: Root causes require depth > 0 and no incoming causal edges.

---

## Best Practices

### 1. Always Test with --skip-cache First

When testing changes to data collection or agents:
```bash
node index.js --action agent --url https://www.example.com --device mobile --skip-cache
```

Cache can hide changes to collection logic.

### 2. Review Validation Reports

Before implementing suggestions, check:
```bash
cat .cache/*.validation-report.*.md
```

Understand why findings were blocked/adjusted.

### 3. Verify Code Examples

All suggestions should have concrete code examples:
```bash
cat .cache/*.suggestions.*.json | jq '.suggestions[] | select(.codeExample | length < 10)'
```

Should return empty (all have code examples).

### 4. Check Root Cause Attribution

Prioritize root causes:
```bash
cat .cache/*.suggestions.*.json | jq '.suggestions[] | select(.rootCause == true)'
```

These are strategic fixes with cascading impact.

### 5. Validate Impact Estimates

Check if estimates are realistic:
```bash
cat .cache/*.validation.*.json | jq '.adjustedFindings[] | {finding: .finding.id, reason: .warnings}'
```

Validation may have adjusted unrealistic estimates.

### 6. Use Quality Metrics for Comparison

Compare pre/post validation:
```bash
# Pre-validation
cat .cache/*.quality-metrics.*.json | jq -s 'first | {total: .totalFindings, confidence: .averageConfidence}'

# Post-validation
cat .cache/*.quality-metrics.*.json | jq -s 'last | {total: .totalFindings, confidence: .averageConfidence}'
```

### 7. Test on Multiple Sites

Establish patterns:
- Good site (passes thresholds): web.dev
- Poor site (fails thresholds): qualcomm.com
- Mixed site (some metrics fail): adobe.com

---

## Advanced Usage

### Custom Validation Rules

Edit `src/models/validation-rules.js`:
```javascript
export const ValidationRules = {
  MIN_CONFIDENCE: {
    evidence: 0.5,  // Increase to 0.7 for stricter validation
    impact: 0.5,
    overall: 0.6,
  },
  IMPACT: {
    maxRealisticImpact: {
      LCP: 2000,  // Adjust based on your experience
      INP: 500,
    },
  },
};
```

### Visualize Causal Graph

Export to Graphviz DOT:
```bash
cat .cache/*.causal-graph.*.json | jq -r '.dot' > graph.dot
dot -Tpng graph.dot -o graph.png
open graph.png
```

### Extract Specific Findings

Get all LCP findings:
```bash
cat .cache/*.suggestions.*.json | jq '.suggestions[] | select(.metric == "LCP")'
```

Get root causes only:
```bash
cat .cache/*.suggestions.*.json | jq '.suggestions[] | select(.rootCause == true)'
```

Get high-priority, low-effort (quick wins):
```bash
cat .cache/*.suggestions.*.json | jq '.suggestions[] | select(.priority == "High" and .effort == "Easy")'
```

---

## Performance Optimization

### Reduce Latency

1. **Use faster model**:
   ```bash
   --model gemini-2.5-flash
   ```
   Trade-off: Slightly lower quality

2. **Skip expensive collectors**: Set environment variables:
   ```bash
   SKIP_COVERAGE=true SKIP_CODE_REVIEW=true node index.js --action agent --url ...
   ```

3. **Reduce agent count**: Modify `src/core/multi-agents.js` to skip non-essential agents

### Reduce Cost

1. **Use cache**: Don't use `--skip-cache` unless necessary

2. **Use cheaper model**:
   ```bash
   --model gemini-2.5-flash
   ```

3. **Conditional gating**: Let the system decide when to run expensive collectors (default behavior)

---

## Common Questions

### Q: Why are some findings adjusted/blocked?

**A**: Validation (Phase 4) checks evidence quality, impact realism, and reasoning. Adjusted findings had:
- Overestimated impacts (capped at realistic bounds)
- Missing file references (for non-field data)
- Low confidence scores

See `.cache/*.validation-report.*.md` for details.

### Q: Why do I see duplicate findings?

**A**: Causal graph (Phase 3) should detect and merge duplicates. If you still see duplicates:
1. Check `.cache/*.causal-graph.*.json` for `duplicates` relationships
2. Verify Phase 5 synthesis is combining related findings
3. May be legitimate separate issues affecting same metric

### Q: How do I interpret "cascading impact"?

**A**: Fixing one issue improves multiple metrics due to dependencies.

Example: "400ms TBT + 200ms INP (cascading)" means:
- Direct: TBT reduced by 400ms
- Indirect: INP improved by 200ms (because TBT affects INP)
- Total: ~600ms benefit

### Q: What's the difference between "root cause" and "symptom"?

**A**:
- **Root Cause**: Fundamental issue (depth 2+, no incoming edges)
  - Example: "Full library imports"
- **Symptom**: Observable effect (depth 0-1, has incoming edges)
  - Example: "High TBT of 850ms"

Prioritize root causes - they resolve multiple symptoms at once.

### Q: Why is HAR not collected?

**A**: Conditional gating saves cost. HAR only runs if 2+ signals detected:
- High request count, high transfer, redirects, slow TTFB, or render blocking

If site passes thresholds, HAR isn't needed. See "Troubleshooting: HAR Collection Not Triggering".

### Q: Can I disable validation?

**A**: Yes, but not recommended. Edit `src/core/multi-agents.js` line 807:
```javascript
blockingMode: false,  // Disable blocking
```

Validation prevents false positives from reaching users.

---

## Getting Help

### Check Logs

Enable verbose logging:
```bash
DEBUG=* node index.js --action agent --url ...
```

### Review Documentation

- `.claude/SYSTEM-OVERVIEW.md` - Architecture overview
- `.claude/PHASES-COMPLETE-SUMMARY.md` - Implementation summary
- `.claude/PHASE-*-SUMMARY.md` - Individual phase details

### Common Issues Repository

- HAR not triggering: Known limitation, working as designed
- Low confidence: Check validation report for specific issues
- High token usage: Use faster model or reduce scope
- No root causes: Expected if all issues are direct causes

---

## Maintenance

### Updating Validation Rules

As you collect more data, calibrate validation rules:

1. **Track false positives**: When suggestions are wrong, adjust rules
2. **Update thresholds**: Based on your experience with real implementations
3. **Add new rules**: For CMS-specific anti-patterns

### Updating CMS Contexts

Add new best practices to `src/prompts/contexts/*.js`:
- Discovered anti-patterns
- New optimization techniques
- CMS-specific constraints

### Cache Management

Clean old cache files:
```bash
# Remove cache older than 7 days
find .cache -type f -mtime +7 -delete
```

---

## Success Metrics

Track these over time:
- Average confidence: Should be >70%
- Root cause ratio: Should be >50%
- False positive rate: Should be <30%
- Blocked findings: Should be <20%
- User acceptance rate: Track in MCP reviewer

Good targets:
- 📊 Quality Metrics: >20 findings, >80% confidence, >50% root causes
- ✅ Validation: >50% approved, <30% adjusted, <20% blocked
