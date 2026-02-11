# CSS Loading Best Practices & Anti-Patterns

## Overview

This document defines best practices for CSS loading recommendations in CWV Agent suggestions. Follow these patterns to ensure spec-compliant, maintainable, and performant CSS loading strategies.

**Last Updated**: January 2026

---

## ✅ Recommended Patterns

### 1. Critical CSS Inlining (Preferred)

**When to Use**: For small, above-the-fold critical CSS (<14KB)

**Pattern**:
```html
<!-- Option A: Inline critical CSS directly -->
<style>
  /* Critical above-the-fold CSS */
  .header { /* ... */ }
  .hero { /* ... */ }
</style>

<!-- Load remaining CSS normally -->
<link rel="stylesheet" href="/css/non-critical.css">
```

**Benefits**:
- ✅ No additional request for critical CSS
- ✅ Eliminates render-blocking for above-the-fold content
- ✅ Spec-compliant and universally supported

**Implementation Notes**:
- Keep inline CSS under 14KB (one TCP packet)
- Automate extraction with tools (Critical, Critters, PurgeCSS)
- Include in AEM build process

---

### 2. Async CSS Loading with JavaScript (Modern Approach)

**When to Use**: For non-critical CSS that can load after page render

**Pattern**:
```html
<!-- Option A: Simple async loading -->
<script>
  // Load CSS asynchronously after page load
  if (document.readyState === 'complete') {
    loadCSS('/css/non-critical.css');
  } else {
    window.addEventListener('load', () => {
      loadCSS('/css/non-critical.css');
    });
  }

  function loadCSS(href) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
</script>
```

**Pattern (Advanced with requestIdleCallback)**:
```html
<script>
  // Load CSS during browser idle time
  function loadNonCriticalCSS() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/css/non-critical.css';
    document.head.appendChild(link);
  }

  if ('requestIdleCallback' in window) {
    requestIdleCallback(loadNonCriticalCSS);
  } else {
    // Fallback for browsers without requestIdleCallback
    setTimeout(loadNonCriticalCSS, 1);
  }
</script>
```

**Benefits**:
- ✅ Spec-compliant (proper use of DOM APIs)
- ✅ Doesn't block rendering
- ✅ Can be prioritized with requestIdleCallback
- ✅ Easy to understand and maintain

**Implementation Notes**:
- Place script inline in `<head>` before `</head>`
- Use for below-the-fold content (footer, modals, etc.)
- Consider Content-Security-Policy (CSP) implications

---

### 3. CSS Splitting by Page/Component (Build-Time)

**When to Use**: For AEM multi-page applications with varied content

**Pattern**:
```
AEM Clientlib Structure:
/apps/mysite/clientlibs/
  ├── clientlib-critical/       # <14KB, loaded synchronously
  │   ├── css.txt
  │   └── critical.css
  ├── clientlib-page-home/      # Loaded async, only on homepage
  │   ├── css.txt
  │   └── home.css
  ├── clientlib-page-product/   # Loaded async, only on product pages
  │   ├── css.txt
  │   └── product.css
  └── clientlib-base/           # Common styles, loaded async
      ├── css.txt
      └── base.css
```

**HTL Template**:
```html
<!-- customheaderlibs.html -->

<!-- 1. Critical CSS (synchronous) -->
<sly data-sly-use.clientlib="/libs/granite/sightly/templates/clientlib.html">
  <sly data-sly-call="${clientlib.css @ categories='mysite.critical'}" />
</sly>

<!-- 2. Page-specific CSS (async) -->
<script>
  window.addEventListener('load', () => {
    loadClientlib('mysite.page.${currentPage.template.name}');
    loadClientlib('mysite.base');
  });

  function loadClientlib(category) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/etc.clientlibs/mysite/clientlibs/' + category + '.min.css';
    document.head.appendChild(link);
  }
</script>
```

**Benefits**:
- ✅ Reduces CSS bloat per page
- ✅ Leverages HTTP/2 multiplexing
- ✅ Maintainable in AEM context
- ✅ Can be cached per page type

---

### 4. Preload + Async Loading

**When to Use**: For important but non-critical CSS (e.g., fonts)

**Pattern**:
```html
<!-- Preload to start fetching early, but don't block rendering -->
<link rel="preload" href="/css/fonts.css" as="style" onload="this.onload=null;this.rel='stylesheet'">
<noscript><link rel="stylesheet" href="/css/fonts.css"></noscript>
```

**Benefits**:
- ✅ Starts download early (high priority)
- ✅ Doesn't block rendering
- ✅ Graceful degradation with noscript

**Caveat**:
- ⚠️ `onload` attribute modifies the link, which is a bit hacky but widely supported
- ⚠️ Consider JavaScript-based approach above for cleaner code

---

## ❌ Anti-Patterns to Avoid

### 1. Media Print Hack (DEPRECATED)

**Pattern (DO NOT USE)**:
```html
<!-- ❌ ANTI-PATTERN: Abuses media attribute -->
<link rel="stylesheet" href="/css/non-critical.css" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="/css/non-critical.css"></noscript>
```

**Why It's Bad**:
- ❌ Semantically incorrect (abuses `media="print"`)
- ❌ Violates HTML spec intent
- ❌ May cause accessibility issues (screen readers, print preview)
- ❌ Fragile (browsers could optimize away print-media stylesheets)
- ❌ Harder to understand and maintain
- ❌ May fail CSP policies

**What to Use Instead**: JavaScript-based async loading (Pattern #2 above)

---

### 2. Excessive Synchronous CSS Files

**Pattern (DO NOT USE)**:
```html
<!-- ❌ ANTI-PATTERN: 16+ render-blocking CSS files -->
<link rel="stylesheet" href="/css/reset.css">
<link rel="stylesheet" href="/css/grid.css">
<link rel="stylesheet" href="/css/typography.css">
<link rel="stylesheet" href="/css/buttons.css">
<link rel="stylesheet" href="/css/forms.css">
<link rel="stylesheet" href="/css/header.css">
<link rel="stylesheet" href="/css/footer.css">
<link rel="stylesheet" href="/css/modals.css">
<!-- ... 8 more files ... -->
```

**Why It's Bad**:
- ❌ Blocks rendering for all files (even HTTP/2)
- ❌ CSSOM construction waits for all files
- ❌ High LCP due to render blocking
- ❌ Waterfall effect in connection-limited scenarios

**What to Use Instead**:
- Bundle critical CSS into one file
- Async load non-critical CSS (Pattern #2)
- Split by page type (Pattern #3)

---

### 3. Cross-Origin Render-Blocking CSS

**Pattern (DO NOT USE)**:
```html
<!-- ❌ ANTI-PATTERN: Cross-origin CSS without preconnect -->
<link rel="stylesheet" href="https://external-cdn.com/base.css">
```

**Why It's Bad**:
- ❌ Adds DNS lookup + TCP handshake + TLS negotiation time
- ❌ Can add 1-2 seconds to LCP
- ❌ CORS issues if server misconfigured

**What to Use Instead**:
```html
<!-- ✅ Option A: Self-host critical CSS -->
<link rel="stylesheet" href="/css/base.css">

<!-- ✅ Option B: Preconnect + async load -->
<link rel="preconnect" href="https://external-cdn.com" crossorigin>
<script>
  requestIdleCallback(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://external-cdn.com/base.css';
    document.head.appendChild(link);
  });
</script>
```

---

### 4. 100% Unused CSS Clientlibs

**Pattern (DO NOT USE)**:
```xml
<!-- ❌ ANTI-PATTERN: Including unused clientlibs -->
<sly data-sly-call="${clientlib.css @ categories='[clientlib-grid,clientlib-libs,clientlib-landrover]'}" />
```

**Why It's Bad**:
- ❌ Wastes bandwidth (could be 500KB+ unused code)
- ❌ Slows CSSOM construction
- ❌ Unnecessary render blocking

**What to Use Instead**:
```html
<!-- ✅ Remove unused clientlib categories from page component -->
<sly data-sly-call="${clientlib.css @ categories='mysite.critical'}" />
```

**Action**: Audit with Coverage DevTools, remove unused categories from HTL

---

## 🎯 AEM-Specific Recommendations

### Recommended AEM Clientlib Structure

```
/apps/jlr/clientlibs/
  ├── jlr.critical/          # <14KB critical CSS
  │   ├── .content.xml       # categories="jlr.critical"
  │   ├── css.txt
  │   └── css/
  │       └── critical.css
  │
  ├── jlr.base/              # Common async CSS
  │   ├── .content.xml       # categories="jlr.base"
  │   ├── css.txt
  │   └── css/
  │       ├── layout.css
  │       ├── typography.css
  │       └── utilities.css
  │
  └── jlr.components/        # Component-specific async CSS
      ├── .content.xml       # categories="jlr.components"
      ├── css.txt
      └── css/
          ├── header.css
          ├── footer.css
          └── hero.css
```

### HTL Loading Template

```html
<!-- File: /apps/jlr/components/page/customheaderlibs.html -->

<!-- 1. Load critical CSS synchronously -->
<sly data-sly-use.clientlib="/libs/granite/sightly/templates/clientlib.html">
  <sly data-sly-call="${clientlib.css @ categories='jlr.critical'}" />
</sly>

<!-- 2. Load non-critical CSS asynchronously -->
<script>
  (function() {
    function loadCSS(category) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/etc.clientlibs/jlr/clientlibs/' + category + '.min.css';
      document.head.appendChild(link);
    }

    if ('requestIdleCallback' in window) {
      requestIdleCallback(function() {
        loadCSS('jlr.base');
        loadCSS('jlr.components');
      });
    } else {
      setTimeout(function() {
        loadCSS('jlr.base');
        loadCSS('jlr.components');
      }, 1);
    }
  })();
</script>
```

---

## 📋 Recommendation Template for Agents

When generating CSS loading recommendations, use this template:

```markdown
### [N]. Split and Defer Non-Critical CSS

**Description**: The page loads [X] render-blocking CSS files ([Y]KB total), including [Z]KB of unused code. This blocks rendering and delays LCP by [estimated time].

**Implementation**:
1. **Identify Critical CSS**: Extract above-the-fold CSS (<14KB) using Critical or similar tools
2. **Inline Critical CSS**: Place extracted CSS in `<style>` tag in `<head>`
3. **Self-Host External CSS**: Move cross-origin CSS files into AEM clientlibs to eliminate connection delays
4. **Create Async Loader**: Use JavaScript to load non-critical CSS after page load
5. **Remove Unused Clientlibs**: Audit with Coverage DevTools, remove unused categories

**Code Example**:
\```html
<!-- File: /apps/jlr/components/page/customheaderlibs.html -->

<!-- 1. Inline critical CSS -->
<style>
  /* Critical above-the-fold CSS extracted from build process */
  .header { /* ... */ }
  .hero { /* ... */ }
</style>

<!-- 2. Async load non-critical CSS -->
<script>
  (function() {
    function loadCSS(href) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      document.head.appendChild(link);
    }

    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => {
        loadCSS('/etc.clientlibs/jlr/clientlibs/jlr.base.min.css');
        loadCSS('/etc.clientlibs/jlr/clientlibs/jlr.components.min.css');
      });
    } else {
      setTimeout(() => {
        loadCSS('/etc.clientlibs/jlr/clientlibs/jlr.base.min.css');
        loadCSS('/etc.clientlibs/jlr/clientlibs/jlr.components.min.css');
      }, 1);
    }
  })();
</script>
\```

**Expected Impact**: LCP reduction of [X]s - [Y]s
**Priority**: High
**Effort**: Medium
\```
```

---

## 🔍 Validation Checklist

Before approving CSS loading recommendations:

- [ ] ✅ No `media="print"` hacks used
- [ ] ✅ JavaScript async loading uses requestIdleCallback or setTimeout
- [ ] ✅ Critical CSS is inlined (not loaded via link)
- [ ] ✅ Cross-origin CSS is self-hosted or preconnected
- [ ] ✅ Unused clientlibs are removed (not just deferred)
- [ ] ✅ Code examples are spec-compliant
- [ ] ✅ Noscript fallback provided for async CSS
- [ ] ✅ CSP implications considered (inline scripts may need `'unsafe-inline'`)

---

## 🔗 References

- [Web.dev: Extract Critical CSS](https://web.dev/extract-critical-css/)
- [MDN: CSS Performance Optimization](https://developer.mozilla.org/en-US/docs/Learn/Performance/CSS)
- [FilamentGroup loadCSS (archived reference)](https://github.com/filamentgroup/loadCSS)
- [Chrome DevTools: Coverage](https://developer.chrome.com/docs/devtools/coverage/)

---

## Changelog

- **2026-01**: Initial document created
  - Defined recommended patterns for CSS async loading
  - Documented media print hack as anti-pattern
  - Added AEM-specific guidance
  - Created recommendation template
