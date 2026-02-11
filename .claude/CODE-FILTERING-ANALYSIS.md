# Code Resource Filtering Analysis

**Date**: January 28, 2026
**Issue**: Collecting too many resources for performance analysis

---

## Current Filtering Logic (src/tools/code.js)

### 1. Denylist Regex (Line 5)
```javascript
const DENYLIST_REGEX = /(granite|foundation|cq|core\.|wcm|jquery|lodash|moment|minified|bootstrap|react\.|angular|vue\.|rxjs|three\.|videojs|chart|codemirror|ace|monaco|gtag|googletag|optimizely|segment|tealium|adobe-dtm|launch-|\.ico|\.svg)/i;
```

### 2. shouldIncludeResource() Function (Lines 13-37)

**Filters applied:**
1. ✅ **Third-party rejection**: `requestUrl.hostname !== baseUrl.hostname`
2. ✅ **Denylist regex**: Rejects common libraries and tools
3. ✅ **RUM library**: Rejects `@adobe/helix-rum-js`
4. ⚠️ **JS heuristic**: `pathname.startsWith('/etc.clientlibs/') || !pathname.endsWith('.min.js')`
5. ⚠️ **CSS heuristic**: `pathname.includes('/etc.clientlibs/') || !pathname.endsWith('.min.css')`
6. ✅ **Default**: Accepts everything else (images, fonts, etc.)

---

## Problems Identified

### Problem 1: Overly Permissive for Non-JS/CSS Resources
**Current behavior**: Returns `true` for ANY resource that isn't JS or CSS (line 36)

**Impact**: Fetches images, fonts, PDFs, videos, data files, etc.

**Example unwanted resources**:
- `/images/hero-banner.jpg` → ✅ INCLUDED (why?)
- `/fonts/custom-font.woff2` → ✅ INCLUDED (why?)
- `/data/config.json` → ✅ INCLUDED (why?)
- `/documents/whitepaper.pdf` → ✅ INCLUDED (why?)

**Why this is bad for performance analysis**:
- Code agent analyzes JavaScript/CSS for optimization opportunities
- Images, fonts, PDFs don't contain analyzable code
- Wastes bandwidth and time fetching irrelevant files
- Can cause 403 errors (like the landrover.co.uk footer image)

### Problem 2: Minified JS/CSS Exclusion Logic is Inconsistent

**Current JS logic** (line 31):
```javascript
return pathname.startsWith('/etc.clientlibs/') || !pathname.endsWith('.min.js');
```

**Meaning**: Include if:
- Starts with `/etc.clientlibs/` (AEM-specific) **OR**
- Does NOT end with `.min.js`

**Result**:
- ✅ `/etc.clientlibs/mysite/clientlibs/site.min.js` → INCLUDED (AEM clientlib)
- ✅ `/scripts/app.js` → INCLUDED (non-minified)
- ❌ `/scripts/app.min.js` → EXCLUDED (minified, not AEM)

**Current CSS logic** (line 34):
```javascript
return pathname.includes('/etc.clientlibs/') || !pathname.endsWith('.min.css');
```

**Meaning**: Include if:
- Contains `/etc.clientlibs/` anywhere **OR**
- Does NOT end with `.min.css`

**Result**:
- ✅ `/styles/etc.clientlibs/embedded.css` → INCLUDED (false positive!)
- ✅ `/etc.clientlibs/mysite/clientlibs/site.min.css` → INCLUDED (AEM clientlib)
- ✅ `/styles/app.css` → INCLUDED (non-minified)
- ❌ `/styles/app.min.css` → EXCLUDED (minified, not AEM)

**Inconsistency**: JS uses `startsWith`, CSS uses `includes` - different behavior!

### Problem 3: Denylist Gaps

**Current denylist**: Focuses on common libraries but misses many categories

**Missing categories**:
- **Maps**: `leaflet|mapbox|googlemaps`
- **Social**: `facebook|twitter|linkedin|instagram|pinterest`
- **Payment**: `stripe|paypal|braintree`
- **Analytics**: Missing newer tools (`amplitude|mixpanel|heap`)
- **Media**: `youtube|vimeo|brightcove`
- **AEM Commerce**: `magento|commercetools`
- **Polyfills**: `polyfill|shim`

**Why add more**: Reduces noise from third-party integrations already in denylist

### Problem 4: Performance Analysis Scope Unclear

**Question**: What does "code analysis" mean for performance?

**Current assumption**: Fetch all first-party JS/CSS for review

**Reality**: Code agent looks for:
- Unused imports
- Large bundles
- Blocking patterns
- Optimization opportunities

**What's actually needed**:
- **Critical path JS/CSS**: Scripts/styles that block rendering
- **First-party application code**: Not vendor libraries
- **Large bundles**: Files >50KB that might have dead code
- **Render-blocking resources**: As identified by PSI

**What's NOT needed**:
- Tiny utility scripts (<5KB)
- Vendor libraries (jQuery, React, etc. - already optimized)
- Non-code resources (images, fonts, videos)
- Third-party scripts (already handled by HAR agent)

---

## Recommended Improvements

### Improvement 1: Strict Resource Type Filtering

**Change**: Only include JS and CSS, reject everything else

```javascript
function shouldIncludeResource(requestUrl, baseUrl) {
  // Only analyze code resources (JS/CSS)
  const pathname = requestUrl.pathname || '';
  const isJs = pathname.endsWith('.js');
  const isCss = pathname.endsWith('.css');

  // Reject non-code resources immediately
  if (!isJs && !isCss) {
    return false;  // Don't fetch images, fonts, PDFs, etc.
  }

  // ... rest of filtering
}
```

**Impact**: Eliminates 50-70% of irrelevant resource fetches

### Improvement 2: Size-Based Filtering

**Add**: Minimum size threshold to skip tiny utility scripts

```javascript
function shouldIncludeResource(requestUrl, baseUrl, harEntry = null) {
  // ... existing checks ...

  // Skip very small resources (likely utilities, not meaningful for analysis)
  if (harEntry?.response?.content?.size) {
    const sizeKB = harEntry.response.content.size / 1024;
    if (sizeKB < 5) {
      return false;  // Skip files <5KB
    }
  }

  return true;
}
```

**Impact**: Reduces fetching of tiny helper scripts that won't have optimization opportunities

### Improvement 3: Consistent AEM Clientlib Handling

**Fix inconsistency** between JS and CSS:

```javascript
function shouldIncludeResource(requestUrl, baseUrl) {
  // ... existing checks ...

  const pathname = requestUrl.pathname || '';
  const isJs = pathname.endsWith('.js');
  const isCss = pathname.endsWith('.css');

  // Reject non-code resources
  if (!isJs && !isCss) return false;

  // Reject third-party resources
  if (requestUrl.hostname !== baseUrl.hostname) return false;

  // Reject denylist matches
  if (DENYLIST_REGEX.test(pathname)) return false;

  // Reject RUM library
  if (isJs && pathname.includes('.rum/@adobe/helix-rum-js')) return false;

  // AEM Clientlibs: Always include (even if minified)
  const isAEMClientlib = pathname.startsWith('/etc.clientlibs/') || pathname.startsWith('/apps/');
  if (isAEMClientlib) {
    return true;
  }

  // Non-AEM resources: Prefer non-minified (source code)
  if (isJs && pathname.endsWith('.min.js')) return false;
  if (isCss && pathname.endsWith('.min.css')) return false;

  // Include all other first-party JS/CSS
  return true;
}
```

**Changes**:
- ✅ Consistent `startsWith` for AEM paths
- ✅ Clear logic: AEM clientlibs always included, non-AEM minified excluded
- ✅ Explicit rejection of non-code resources

### Improvement 4: Enhanced Denylist

**Add missing patterns**:

```javascript
const DENYLIST_REGEX = /(
  # AEM/CQ patterns
  granite|foundation|cq|core\.|wcm|

  # Common libraries
  jquery|lodash|moment|bootstrap|

  # Frameworks
  react\.|angular|vue\.|rxjs|

  # Media libraries
  three\.|videojs|chart|brightcove|youtube|vimeo|

  # Editors
  codemirror|ace|monaco|tinymce|ckeditor|

  # Analytics
  gtag|googletag|google-analytics|analytics\.js|
  optimizely|segment|tealium|adobe-dtm|launch-|
  amplitude|mixpanel|heap|hotjar|

  # Maps
  leaflet|mapbox|googlemaps|mapkit|

  # Social
  facebook|twitter|linkedin|instagram|pinterest|

  # Payment
  stripe|paypal|braintree|

  # Polyfills
  polyfill|shim|

  # File types (should already be filtered, but backup)
  \.ico|\.svg|\.png|\.jpg|\.jpeg|\.gif|\.woff|\.woff2|\.ttf|\.eot
)/ix;
```

**Note**: Added `x` flag for readability, added grouping

### Improvement 5: Render-Blocking Priority

**Add**: Prioritize resources identified as render-blocking by PSI

```javascript
export async function collect(pageUrl, deviceType, resources, { skipCache, skipTlsCheck, psiData }) {
  // Extract render-blocking resources from PSI
  const renderBlockingUrls = new Set(
    psiData?.lighthouseResult?.audits?.['render-blocking-resources']?.details?.items?.map(item => item.url) || []
  );

  // Prioritize render-blocking resources
  const urlsToProcess = resources
    .filter(url => {
      try {
        const requestUrl = new URL(url);
        return shouldIncludeResource(requestUrl, baseUrl);
      } catch (error) {
        return false;
      }
    })
    .sort((a, b) => {
      // Render-blocking resources first
      const aBlocking = renderBlockingUrls.has(a) ? 0 : 1;
      const bBlocking = renderBlockingUrls.has(b) ? 0 : 1;
      return aBlocking - bBlocking;
    });

  // ... continue with fetching
}
```

**Impact**: Fetches most important resources first, can timeout and still have critical files

---

## Recommended Implementation

### Option A: Minimal Fix (Quick, Low Risk)

**Changes**:
1. Add line 19: `if (!isJs && !isCss) return false;`
2. Fix line 34: Change `includes` to `startsWith`

**Impact**: Eliminates non-code resources, fixes CSS inconsistency

**Effort**: 5 minutes

**Risk**: Very low

---

### Option B: Comprehensive Fix (Recommended)

**Changes**:
1. Strict resource type filtering (reject non-code)
2. Consistent AEM clientlib handling (`startsWith` for both)
3. Enhanced denylist (add missing patterns)
4. Optional: Size-based filtering (skip <5KB)

**Impact**: Reduces irrelevant fetches by 60-80%, faster collection, fewer errors

**Effort**: 30 minutes

**Risk**: Low - backward compatible, purely subtractive

---

### Option C: Full Optimization (Advanced)

**Changes**: All of Option B plus:
- Render-blocking resource prioritization
- HAR entry size checking
- Parallel fetching for critical resources
- Better error handling (don't hang on 403)

**Impact**: Maximum efficiency, best performance

**Effort**: 2 hours

**Risk**: Medium - more complex, needs testing

---

## Testing After Changes

**Test URLs**:
1. `https://www.landrover.co.uk/contact-us.html` (caused 403 error)
2. `https://www.qualcomm.com` (typical site)
3. `https://www.adobe.com` (AEM site with clientlibs)

**Verify**:
- [ ] No 403 errors from fetching images/fonts
- [ ] Code collection completes quickly (<30s)
- [ ] Only JS/CSS resources collected
- [ ] AEM clientlibs still included
- [ ] Minified non-AEM files excluded

**Measure**:
- Resources before: ~150-200
- Resources after: ~20-40 (80-85% reduction expected)
- Time before: 60-90s
- Time after: 10-20s (70-80% faster)

---

## Recommendation

**Implement Option B (Comprehensive Fix)**

**Rationale**:
- Addresses all identified problems
- Low risk, backward compatible
- Significant performance improvement
- Clear, maintainable logic

**Priority**: High - Directly impacts the hang issue and code collection performance
