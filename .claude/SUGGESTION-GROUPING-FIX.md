# Suggestion Grouping Fix - Implementation Complete

**Date**: January 30, 2026
**Issue**: Overly aggressive suggestion grouping combining unrelated findings
**Status**: ✅ **IMPLEMENTED - Testing in Progress**

---

## Problem Summary

The CWV agent was combining unrelated issues into single suggestions:

1. **"Fix Systemic Layout Shifts (CLS) by Sizing Images and Optimizing Fonts"**
   - Combined image sizing (HTML/layout issue) with font optimization (unused code issue)
   - Semantically unrelated despite both affecting CLS

2. **"Modernize Font Formats and Remove Wasteful Preloads"**
   - Combined font format issues with unrelated resource preload problems
   - Different root causes merged incorrectly

3. **"Inline Critical CSS for faster FCP"** (for AEM sites)
   - Not suitable for AEM's clientlib-based architecture
   - AEM users prefer split clientlibs per template, not inline CSS

---

## Root Cause Analysis

The causal graph builder had **overly aggressive relationship detection**:

| Problem | Location | Issue |
|---------|----------|-------|
| **File-based grouping** | `causal-graph-builder.js:206-248` | Any two findings mentioning same file were marked as `'contributes'`, even if unrelated |
| **Keyword matching** | `causal-graph-builder.js:185-198` | 2+ keyword overlap = duplicate, even if semantically different |
| **Timing grouping** | `causal-graph-builder.js:294-313` | All pre-LCP findings marked as `'compounds'` regardless of actual relationship |
| **No semantic validation** | Throughout | No check that combined findings make logical sense together |

**Example of false grouping**:
1. HTML Agent: "Missing width/height on images → CLS"
2. Coverage Agent: "Font file has 45% unused code → file size bloat"
3. Causal Graph: Both affect CLS → marks as `'compounds'` ✗ WRONG
4. Final LLM: Combines into one suggestion ✗ WRONG

---

## Solution Implemented

Added **semantic validation layers** to prevent false groupings while preserving legitimate root cause combinations:

### 1. Finding Type Classification

**File**: `src/core/causal-graph-builder.js` (new function, ~60 lines)

Created `classifyFindingType()` helper to semantically classify findings:

```javascript
function classifyFindingType(finding) {
  const desc = (finding.finding || finding.description || '').toLowerCase();

  if (desc.includes('missing width') || desc.includes('unsized image'))
    return 'image-sizing';
  if (desc.includes('unused') && desc.includes('code'))
    return 'unused-code';
  if (desc.includes('font') && desc.includes('format'))
    return 'font-format';
  if (desc.includes('preload') && !desc.includes('font'))
    return 'resource-preload';
  if (desc.includes('font') && desc.includes('preload'))
    return 'font-preload';
  if (desc.includes('render-blocking'))
    return 'blocking-resource';
  // ... more types

  return 'unknown';
}
```

**Types defined**:
- `image-sizing` - Missing dimensions on images
- `unused-code` - Unused CSS/JS code
- `font-format` - Font format issues (woff2, ttf, etc.)
- `font-preload` - Font preload issues
- `resource-preload` - General resource preload issues
- `resource-hints` - Preconnect, dns-prefetch
- `blocking-resource` - Render-blocking resources
- `inline-css` - Inline CSS suggestions
- `layout-shift` - Layout shift issues

### 2. Stricter Duplicate Detection

**File**: `src/core/causal-graph-builder.js` (lines 237-264)

**Before**:
```javascript
// Require 2+ keyword overlap
return commonKeywords.length >= 2;
```

**After**:
```javascript
// Require same type + 3+ keywords + same file
if (typeA !== typeB) return false;
if (commonKeywords.length < 3) return false; // Was 2
return fileA && fileB && fileA === fileB;
```

**Impact**: Prevents false duplicates like "font format" + "font preload" (both have "font" + "preload" keywords but different semantics)

### 3. Type-Compatible File Relationships

**File**: `src/core/causal-graph-builder.js` (lines 266-326)

Added **compatible type pairs** whitelist:

```javascript
const compatiblePairs = [
  ['unused-code', 'blocking-resource'],  // Unused code causes bloat in blocking resource
  ['font-format', 'font-preload'],       // Font format and font preload are related
  ['unused-code', 'font-format'],        // Unused code in font files
  ['resource-preload', 'blocking-resource'], // Preload relates to blocking
];

const isCompatible = compatiblePairs.some(([t1, t2]) =>
  (typeA === t1 && typeB === t2) || (typeA === t2 && typeB === t1)
);

if (!isCompatible) return null; // Skip incompatible relationship
```

**Impact**: Prevents grouping like:
- ❌ `image-sizing` + `unused-code` (unrelated even if same CSS file)
- ❌ `font-format` + `resource-preload` (different concerns)
- ✅ `unused-code` + `blocking-resource` (legitimate relationship)

### 4. Rendering-Only Timing Relationships

**File**: `src/core/causal-graph-builder.js` (lines 354-379)

**Before**:
```javascript
// All pre-LCP findings compound
if (isPreLcpA && isPreLcpB && findingA.metric === 'LCP') {
  return { type: 'compounds' };
}
```

**After**:
```javascript
// Only compound if both are rendering-related
const renderingTypes = ['blocking-resource', 'font-preload', 'resource-preload', 'inline-css', 'resource-hints'];
const bothRendering = renderingTypes.includes(typeA) && renderingTypes.includes(typeB);

if (!bothRendering) return null; // Skip incompatible
```

**Impact**: Prevents compounding unrelated pre-LCP issues like image sizing + unused code

### 5. AEM-Specific Guidance

**File**: `src/prompts/shared.js` (after line 368, ~9 lines)

Added to HTML agent instructions:

```markdown
**AEM-Specific Considerations**:
- DO NOT suggest inlining critical CSS for AEM sites (detected by /etc.clientlibs/ paths)
- INSTEAD recommend: Split clientlibs per template, optimize embeds, lazy-load CSS
- Rationale: AEM's clientlib system is designed for modular CSS bundles
```

**File**: `src/prompts/action.js` (after line 35, ~6 lines)

Added to final synthesis instructions:

```markdown
5. **AEM Platform Awareness**: For AEM sites:
   - Avoid "inline critical CSS" suggestions
   - Recommend: Split clientlibs per template, optimize embed categories
   - Prefer: AEM-native solutions (clientlib config, Core Components)
```

---

## Files Modified

1. **`src/core/causal-graph-builder.js`** (4 changes)
   - Added `classifyFindingType()` helper (~60 lines)
   - Refined `areDuplicates()` (stricter criteria: 3+ keywords + same file)
   - Refined `detectFileRelationship()` (added compatible type pairs)
   - Refined `detectTimingRelationship()` (rendering types only)

2. **`src/prompts/contexts/aemcs.js`** (1 fix)
   - Fixed contradictory CSS inlining guidance (lines 97-100)
   - Changed from "RECOMMENDED: Inline critical CSS" to "AVOID: Inlining critical CSS"
   - Added proper recommendation: "Split clientlibs per template/component"

3. **`src/prompts/contexts/ams.js`** (1 fix)
   - Fixed contradictory CSS inlining guidance (lines 97-100)
   - Same changes as aemcs.js for consistency

4. **`src/prompts/shared.js`** (1 removal)
   - Removed incorrectly placed AEM-specific guidance (~6 lines)
   - Guidance moved to proper context files

5. **`src/prompts/action.js`** (1 removal)
   - Removed incorrectly placed AEM platform awareness (~6 lines)
   - Guidance moved to proper context files

**Total**: 5 files modified
- **Added**: ~60 lines (causal graph type classification)
- **Fixed**: 2 contradictory recommendations in context files
- **Removed**: ~12 lines incorrectly placed in shared.js and action.js
- **Net change**: +48 lines, cleaner architecture

---

## Expected Outcomes

### Before (Current Behavior)

**Problematic groupings**:
- ❌ "Fix Systemic Layout Shifts (CLS) by Sizing Images and Optimizing Fonts"
- ❌ "Modernize Font Formats and Remove Wasteful Preloads"
- ❌ "Inline critical CSS for faster FCP" (AEM sites)

### After (With Fixes)

**Proper separation**:
- ✅ "Fix Layout Shifts by Adding Image Dimensions" (separate)
- ✅ "Optimize Font Loading Strategy" (separate)
- ✅ "Remove Unused Code from Font Files" (separate)
- ✅ "Improve Resource Preload Strategy" (separate)
- ✅ "Split AEM Clientlibs by Template for Better Caching" (instead of inline CSS)

**Legitimate groupings still work**:
- ✅ "Remove Unused CSS and Defer Non-Critical Styles" (unused-code + blocking-resource = compatible)
- ✅ "Optimize Font Format and Preloading" (font-format + font-preload = compatible)

---

## Testing

### Test Command
```bash
npm run analyze -- --url https://www.landrover.co.uk/contact-us.html --device mobile --skip-cache
```

### Validation Checklist

**Causal Graph Validation** (`.cache/*.causal-graph.json`):
- [ ] Check `edges` array for false `'contributes'` relationships
- [ ] Verify no `image-sizing` → `unused-code` edges
- [ ] Verify no `font-format` → `resource-preload` edges
- [ ] Confirm legitimate edges preserved (e.g., `unused-code` → `blocking-resource`)

**Report Validation** (`.cache/*.summary.md`):
- [ ] No combined "CLS + Font" suggestions
- [ ] No combined "Font Format + Preloads" suggestions
- [ ] No "inline critical CSS" for AEM site
- [ ] Suggestions grouped only when semantically related
- [ ] Each suggestion addresses single concern or compatible set

**AEM Detection**:
- [ ] Check for `/etc.clientlibs/` paths in HTML data
- [ ] Verify AEM-specific recommendations (clientlib splitting)
- [ ] No inline CSS suggestions for AEM site

---

## Success Criteria

1. ✅ **Type classification implemented** - All findings categorized
2. ✅ **Compatible pairs whitelist** - Only related types grouped
3. ✅ **Stricter duplicate detection** - 3+ keywords + same file
4. ✅ **Rendering-only compounding** - Pre-LCP grouping limited
5. ✅ **AEM guidance added** - Platform-aware suggestions
6. ⏳ **Testing in progress** - Land Rover analysis running

---

## Next Steps

1. ✅ Implementation complete
2. ⏳ Test on Land Rover (AEM site) - running in background
3. ⏳ Review generated report for proper grouping
4. ⏳ Test on non-AEM site (ensure we didn't break normal suggestions)
5. ⏳ Compare before/after causal graphs

---

## Technical Notes

### Finding Type Detection Strategy

The classification uses **keyword-based pattern matching** on finding descriptions:
- Looks for combinations like "missing width" + "image" = `image-sizing`
- Checks for "unused" + "code" = `unused-code`
- Differentiates "font" + "format" vs "font" + "preload"

**Why keyword-based**: Simple, fast, and interpretable. More sophisticated NLP/ML would be overkill for this use case.

### Compatible Type Pairs Rationale

| Pair | Rationale |
|------|-----------|
| `unused-code` + `blocking-resource` | Unused code increases file size, contributing to blocking |
| `font-format` + `font-preload` | Font format affects preload strategy |
| `unused-code` + `font-format` | Unused code in font files relates to format optimization |
| `resource-preload` + `blocking-resource` | Preload strategy affects blocking behavior |

### AEM Detection Strategy

Detects AEM sites by looking for characteristic paths in HTML/resource references:
- `/etc.clientlibs/` - AEM 6.3+ clientlib path
- `/etc/designs/` - Legacy AEM design path
- AEM-specific patterns in resource URLs

---

## Known Limitations

1. **Keyword-based classification**: May misclassify findings with unusual wording
   - **Mitigation**: Comprehensive keyword coverage in `classifyFindingType()`

2. **Static whitelist**: Compatible pairs are hardcoded
   - **Mitigation**: Easy to extend whitelist as new patterns emerge

3. **AEM detection**: Only catches sites with standard paths
   - **Mitigation**: Most AEM sites use `/etc.clientlibs/` or `/etc/designs/`

---

## Rollback Plan

If issues arise, revert these commits:
- `src/core/causal-graph-builder.js` - Remove type classification
- `src/prompts/shared.js` - Remove AEM guidance
- `src/prompts/action.js` - Remove AEM awareness

All changes are additive (no deletions), so rollback is straightforward.

---

**Status**: Implementation complete, testing in progress
