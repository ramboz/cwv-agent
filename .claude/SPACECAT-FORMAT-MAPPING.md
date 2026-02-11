# SpaceCat Upload Format Mapping - Implementation Complete

**Date**: January 28, 2026
**Issue**: New causal graph format has empty `suggestions` array, breaks SpaceCat upload
**Status**: ✅ FIXED

---

## Problem

The new Phase 1 causal graph format saves agent outputs with:
- `findings` array - New structured format with evidence, reasoning, estimatedImpact
- `suggestions` array - Empty `[]`

The CWVSuggestionManager (used for SpaceCat upload) expects:
- `suggestions` array populated with: id, title, description, metric, priority, effort, impact, implementation, codeExample, category

**Result**: SpaceCat upload fails with "Invalid suggestions file format" error (line 130-132 in suggestion-manager.js)

---

## Solution Implemented

Added automatic transformation of `findings` → `suggestions` format in `src/core/multi-agents.js`.

### Changes Made

**File**: `src/core/multi-agents.js`

1. **Added transformation function** (before line 354):
```javascript
/**
 * Transform new causal graph findings format to legacy suggestions format
 * @param {Array} findings - Array of findings from causal graph agents
 * @returns {Array} Array of suggestions in legacy format
 */
function transformFindingsToSuggestions(findings) {
    if (!Array.isArray(findings)) return [];

    return findings.map((finding, index) => {
        // Determine priority from confidence and root cause status
        let priority = 'Medium';
        if (finding.rootCause && finding.evidence?.confidence > 0.8) {
            priority = 'High';
        } else if (!finding.rootCause || finding.evidence?.confidence < 0.6) {
            priority = 'Low';
        }

        // Determine effort from type and estimated impact
        let effort = 'Medium';
        if (finding.type === 'opportunity' || finding.estimatedImpact?.reduction < 100) {
            effort = 'Easy';
        } else if (finding.rootCause && finding.estimatedImpact?.reduction > 500) {
            effort = 'Hard';
        }

        // Extract implementation from reasoning.solution
        let implementation = '';
        if (finding.reasoning?.solution) {
            implementation = finding.reasoning.solution;
        } else if (finding.description) {
            implementation = finding.description;
        }

        // Generate code example from implementation text
        let codeExample = null;
        if (implementation) {
            const codeMatch = implementation.match(/```(?:javascript|css|html)?\s*([\s\S]*?)```/);
            if (codeMatch) {
                codeExample = codeMatch[1].trim();
            }
        }

        // Format impact as a string
        let impact = 'Not estimated';
        if (finding.estimatedImpact) {
            const { metric, reduction, confidence } = finding.estimatedImpact;
            if (metric && reduction) {
                // CLS is unitless, others use ms
                const unit = metric === 'CLS' ? '' : 'ms';
                impact = `~${reduction}${unit} ${metric} improvement (${Math.round(confidence * 100)}% confidence)`;
            }
        }

        const category = finding.metric?.toLowerCase() || 'general';

        return {
            id: index + 1,
            title: finding.description || `${finding.metric} Optimization`,
            description: finding.reasoning?.observation || finding.description,
            metric: finding.metric,
            priority,
            effort,
            impact,
            implementation,
            codeExample,
            category
        };
    });
}
```

2. **Updated extractStructuredSuggestions()** (line 354-460):
- Added check for `findings` array when `suggestions` is missing
- Calls `transformFindingsToSuggestions()` to convert format
- Logs transformation for visibility

3. **Added auto-population on save** (after line 1184):
```javascript
// If suggestions array is still empty but we have findings, transform and add
if ((!structuredData.suggestions || structuredData.suggestions.length === 0) &&
    Array.isArray(structuredData.findings) && structuredData.findings.length > 0) {
  console.log('📊 Populating legacy suggestions array from findings for SpaceCat compatibility');
  structuredData.suggestions = transformFindingsToSuggestions(structuredData.findings);

  // Re-save with populated suggestions array
  const updatedPath = cacheResults(pageUrl, deviceType, 'suggestions', structuredData, '', options.model);
  console.log(`✅ Updated suggestions file with ${structuredData.suggestions.length} transformed suggestions`);
}
```

---

## Transformation Logic

### Priority Mapping

| Condition | Priority |
|-----------|----------|
| Root cause + confidence > 0.8 | High |
| Not root cause OR confidence < 0.6 | Low |
| Default | Medium |

### Effort Mapping

| Condition | Effort |
|-----------|--------|
| Type = "opportunity" OR impact < 100 | Easy |
| Root cause AND impact > 500 | Hard |
| Default | Medium |

### Field Mapping

| New Format (findings) | Old Format (suggestions) | Transformation |
|-----------------------|--------------------------|----------------|
| `description` | `title` | Direct copy |
| `reasoning.observation` | `description` | Extract observation, fallback to description |
| `metric` | `metric` | Direct copy |
| — | `priority` | Derived from rootCause + confidence |
| — | `effort` | Derived from type + estimatedImpact |
| `estimatedImpact` | `impact` | Formatted: "~100ms LCP improvement (80% confidence)" |
| `reasoning.solution` | `implementation` | Direct copy |
| Code blocks in implementation | `codeExample` | Extracted via regex |
| `metric.toLowerCase()` | `category` | Lowercase conversion |

### Impact Formatting

```javascript
// CLS is unitless, others use ms
const unit = metric === 'CLS' ? '' : 'ms';
impact = `~${reduction}${unit} ${metric} improvement (${Math.round(confidence * 100)}% confidence)`;
```

**Examples**:
- INP: "~100ms INP improvement (70% confidence)"
- CLS: "~0.07 CLS improvement (75% confidence)"
- LCP: "~1200ms LCP improvement (80% confidence)"

---

## Testing

### Test Case: landrover.co.uk

**Before transformation** (findings format):
```json
{
  "agentName": "CrUX Agent",
  "findings": [
    {
      "id": "crux-inp-1",
      "type": "bottleneck",
      "metric": "INP",
      "description": "User interactions on mobile devices are sluggish...",
      "evidence": { "source": "crux", "confidence": 1 },
      "estimatedImpact": { "metric": "INP", "reduction": 100, "confidence": 0.7 },
      "reasoning": {
        "observation": "CrUX shows 75th percentile INP is 281ms...",
        "solution": "Use Performance Profiler to find long tasks..."
      },
      "rootCause": true
    }
  ],
  "suggestions": []  // EMPTY!
}
```

**After transformation** (suggestions format):
```json
{
  "agentName": "CrUX Agent",
  "findings": [...],  // Preserved
  "suggestions": [
    {
      "id": 1,
      "title": "User interactions on mobile devices are sluggish...",
      "description": "CrUX shows 75th percentile INP is 281ms...",
      "metric": "INP",
      "priority": "High",
      "effort": "Medium",
      "impact": "~100ms INP improvement (70% confidence)",
      "implementation": "Use Performance Profiler to find long tasks...",
      "codeExample": null,
      "category": "inp"
    }
  ]
}
```

### Validation Results

✅ **File format validation**: Passes CWVSuggestionManager checks (line 130-132)
✅ **Priority derivation**: High (rootCause=true, confidence=1.0)
✅ **Effort derivation**: Medium (impact=100ms, not <100 or >500)
✅ **Impact formatting**: "~100ms INP improvement (70% confidence)" ✓
✅ **CLS unit handling**: "~0.07 CLS improvement" (no 'ms') ✓
✅ **Implementation extraction**: Correctly uses reasoning.solution ✓
✅ **Category mapping**: "inp" (lowercase) ✓

---

## Backward Compatibility

### Legacy Format (Pre-Phase 1)
If a file already has a populated `suggestions` array in the old format:
- ✅ Transformation is skipped (check: `structuredData.suggestions.length > 0`)
- ✅ Existing logic continues to work

### New Format (Phase 1+)
If a file has `findings` but empty `suggestions`:
- ✅ Transformation automatically runs
- ✅ Both formats coexist in the file (findings + suggestions)
- ✅ SpaceCat upload uses the transformed suggestions array

---

## SpaceCat Upload Flow (Unchanged)

1. **Load suggestions file**: `CWVSuggestionManager.loadSuggestionsByUrl(url)`
   - Now reads from `data.suggestions` array (populated by transformation)

2. **Merge mobile/desktop**: `mergeSuggestionsByCategory()`
   - Groups by metric (LCP, CLS, INP, TTFB)
   - Merges matching titles across devices

3. **Approve categories**: `approveCategory('LCP')`
   - User approves categories via MCP reviewer

4. **Upload to SpaceCat**: `batchUploadToSpaceCat()`
   - Formats approved suggestions as markdown
   - Groups by metric type
   - Creates issues payload
   - Uploads via SpaceCat API

**No changes needed** - transformation makes new format compatible with existing flow.

---

## Console Output

When transformation occurs, you'll see:

```
📊 Transforming causal graph findings to legacy suggestions format
✅ Structured suggestions saved at: .cache/www-example-com.mobile.suggestions.gemini25pro.json
📊 Populating legacy suggestions array from findings for SpaceCat compatibility
✅ Updated suggestions file with 2 transformed suggestions
```

---

## Future Improvements (Optional)

1. **Code example extraction**: Currently extracts from backtick code blocks in implementation text. Could be enhanced to:
   - Parse code from reasoning.solution specifically
   - Add AEM-specific code generation (HTL templates, clientlib config)

2. **Summary object**: The old format example showed a `summary` object with current/target/status for metrics. Could add:
   ```javascript
   summary: {
     lcp: { current: "2.6s", target: "2.5s", status: "poor" },
     cls: { current: "0.12", target: "0.1", status: "poor" },
     inp: { current: "281ms", target: "200ms", status: "poor" }
   }
   ```
   - Extract from evidence.reference or reasoning.observation
   - Not required for SpaceCat upload but nice for human readability

3. **Metrics extraction**: Could extract actual metric values from CrUX data for summary object

---

## Verification Checklist

- [x] Transformation function created
- [x] Priority mapping implemented (rootCause + confidence)
- [x] Effort mapping implemented (type + estimatedImpact)
- [x] Impact formatting with correct units (CLS unitless, others ms)
- [x] Implementation extracted from reasoning.solution
- [x] Code example extraction from backticks
- [x] Category mapping (lowercase metric)
- [x] Auto-population on save
- [x] Backward compatibility (legacy format preserved)
- [x] Tested with real file (landrover.co.uk)
- [x] CWVSuggestionManager validation passes
- [x] Console logging added for visibility

---

## Summary

The new causal graph format (`findings` array) now automatically transforms to the legacy SpaceCat format (`suggestions` array) when files are saved. This maintains:
- ✅ New structured findings for quality tracking (Phase 1)
- ✅ Legacy suggestions for SpaceCat upload compatibility
- ✅ Backward compatibility with pre-Phase 1 files
- ✅ No changes required to CWVSuggestionManager or MCP reviewer

**SpaceCat upload is now fully functional with Phase 1 causal graph format.**
