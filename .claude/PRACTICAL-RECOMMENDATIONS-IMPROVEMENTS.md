# Practical Recommendations Improvements

## Problem Statement

Based on real-world usage feedback, the CWV Agent was producing recommendations that were:

1. **Too generic**: Lacking concrete, copy-paste code examples
2. **Not maintainable**: Suggesting per-page solutions (like preloading specific images) that don't scale
3. **Missing CMS constraints**: Not considering AEM template limitations, Core Components, clientlib structure
4. **Following outdated best practices**: Preloading fonts, preloading content images, missing modern techniques (font-display:swap, size-adjust)

## Example Issues

### Issue 1: Generic Image Preload Suggestion
**Bad Output**:
```json
{
  "title": "Preload Critical Rendering Assets",
  "description": "Preload hero images to improve LCP",
  "codeExample": "<link rel=\"preload\" as=\"image\" href=\"hero.jpg\">"
}
```

**Problems**:
- Requires modifying every page individually (not maintainable)
- Doesn't work with AEM templates and dynamic content
- Wastes bandwidth on pages without that specific image

**Better Approach**:
```json
{
  "title": "Set fetchpriority=high on hero image",
  "description": "The hero image is discovered late and loads with default priority, delaying LCP by 800ms.",
  "implementation": "Update the Image Core Component HTL template to add fetchpriority='high' for above-the-fold images.",
  "codeExample": "File: /apps/myproject/components/content/hero/hero.html\n\n<img src=\"${image.src}\"\n     alt=\"${image.alt}\"\n     loading=\"eager\"\n     fetchpriority=\"high\"\n     width=\"${image.width}\"\n     height=\"${image.height}\" />"
}
```

### Issue 2: Font Preload Instead of Proper Loading Strategy
**Bad Output**:
```json
{
  "title": "Preload fonts",
  "description": "Fonts load late",
  "codeExample": "<link rel=\"preload\" as=\"font\" href=\"font.woff2\">"
}
```

**Problems**:
- Preloading fonts can waste bandwidth (not all pages use all fonts)
- Doesn't address FOUT (Flash of Unstyled Text)
- Doesn't address CLS from font swapping
- Missing modern font-display strategy

**Better Approach**:
```json
{
  "title": "Use font-display:swap with size-adjusted fallback",
  "description": "Custom fonts load without fallback strategy, causing FOUT and CLS of 0.08",
  "implementation": "Configure @font-face with font-display:swap and size-adjust fallback font to minimize layout shift",
  "codeExample": "File: /apps/myproject/clientlibs/clientlib-base/css/fonts.css\n\n@font-face {\n  font-family: 'CustomFont';\n  src: url('/fonts/customfont.woff2') format('woff2');\n  font-display: swap;\n  font-weight: 400;\n}\n\n@font-face {\n  font-family: 'CustomFont-fallback';\n  src: local('Arial');\n  size-adjust: 105%;\n  ascent-override: 95%;\n  descent-override: 25%;\n}\n\nbody {\n  font-family: 'CustomFont', 'CustomFont-fallback', sans-serif;\n}"
}
```

## Solutions Implemented

### 1. Enhanced AEM CS Context (`src/prompts/contexts/aemcs.js`)

Added **Practical Implementation Constraints** section:

**Image Optimization Recommendations:**
- ❌ AVOID: Page-specific `<link rel="preload">` for hero images (not maintainable)
- ✅ PREFER: `loading="eager"` and `fetchpriority="high"` on hero images (works in templates)
- ✅ PREFER: Component-level image attribute configuration (scales across pages)

**Font Loading Recommendations:**
- ❌ AVOID: Preloading fonts (wasted bandwidth, CLS issues)
- ✅ PREFER: `font-display: swap` with size-adjusted fallback fonts (minimizes FOUT and CLS)
- ✅ PREFER: Preconnect to font origin (dns-prefetch + preconnect)

**Resource Hints:**
- Preconnect: ONLY for external origins in the critical path for LCP (e.g., CDN hosting hero image)
  - ❌ BAD: Preconnect for analytics, fonts, third-party scripts (not in LCP critical path)
  - ✅ GOOD: Preconnect to CDN if hero image loads from external origin
- Preload: Only for critical, discoverable-late resources in clientlibs (not content images)
- DNS-prefetch: Avoid - no practical use case
  - If blocking LCP: use preconnect instead (does DNS + TCP + TLS)
  - If not blocking LCP: load async later (no hint needed)
- Rule: If it affects LCP, use preconnect. Otherwise, load it async.

**Code Example Requirements:**
- Always provide AEM-specific implementation paths (HTL templates, clientlib categories, Dispatcher config)
- Show actual file locations: `/apps/myproject/components/content/hero/hero.html`
- Include Dispatcher configuration snippets when suggesting caching changes
- Reference Core Components version-specific APIs when applicable

### 2. Mandatory Code Examples (`src/prompts/shared.js`)

Changed `codeExample` from **optional** to **REQUIRED**:

```javascript
// Before
"codeExample": "string - code snippet or example (optional)"

// After
"codeExample": "string - REQUIRED concrete code example (see requirements below)"
```

Added **Code Example Requirements**:
- For AEM: Include HTL template paths, clientlib categories, or Dispatcher config
- For image optimizations: Show actual HTML attribute changes (loading, fetchpriority)
- For font loading: Show @font-face declarations with font-display and size-adjust
- For JavaScript: Show actual code snippets with file paths
- For CSS: Show actual selectors and properties
- AVOID: Generic "use X technique" without actual code
- EXAMPLE FORMAT: `"File: /apps/myproject/components/hero/hero.html\n<img src=\"${image.src}\" loading=\"eager\" fetchpriority=\"high\" />"`

### 3. Few-Shot Examples in Action Prompt (`src/prompts/action.js`)

Added **Code Example Quality Standards** with GOOD vs BAD examples:

**Example 1: Image Optimization**
- GOOD: Component-level `fetchpriority="high"` in HTL template
- BAD: Page-specific image preload

**Example 2: Font Loading**
- GOOD: `font-display:swap` with `size-adjust` fallback
- BAD: Font preload without addressing FOUT/CLS

These examples show agents exactly what quality level is expected and why certain approaches are better.

## Expected Impact

### Before These Changes:
```json
{
  "title": "Preload Critical Rendering Assets",
  "description": "The hero image and fonts should be preloaded to improve LCP",
  "implementation": "Add preload links for critical resources",
  "codeExample": "<link rel=\"preload\" as=\"image\" href=\"hero.jpg\">\n<link rel=\"preload\" as=\"font\" href=\"font.woff2\">"
}
```

### After These Changes:
```json
{
  "title": "Set fetchpriority=high on hero image in Core Component",
  "description": "The hero image is discovered late (1200ms) and loads with default priority, delaying LCP by 800ms. This affects all pages using the hero component.",
  "implementation": "Update the Image Core Component HTL template to add fetchpriority='high' and loading='eager' for above-the-fold images. This change will apply to all hero images across the site.",
  "codeExample": "File: /apps/myproject/components/content/hero/hero.html\n\n<!-- Before -->\n<img src=\"${image.src}\" alt=\"${image.alt}\" />\n\n<!-- After -->\n<img src=\"${image.src}\"\n     alt=\"${image.alt}\"\n     loading=\"eager\"\n     fetchpriority=\"high\"\n     width=\"${image.width}\"\n     height=\"${image.height}\" />",
  "category": "images"
}
```

**Improvements**:
✅ Concrete file path (`/apps/myproject/components/content/hero/hero.html`)
✅ Shows before/after code
✅ Maintainable (changes component template, not individual pages)
✅ Scales across site (all pages using hero component benefit)
✅ AEM-specific (HTL syntax, Core Component pattern)
✅ Follows modern best practices (fetchpriority over preload for content images)

## Testing

Run the agent on Qualcomm again:

```bash
node index.js --action agent \
  --url https://www.qualcomm.com/ \
  --device mobile \
  --skip-cache
```

**Check for improvements**:
1. Every suggestion has a concrete `codeExample` with file paths
2. Image suggestions use `fetchpriority="high"` + `loading="eager"` (not preload)
3. Font suggestions use `font-display:swap` + `size-adjust` (not preload)
4. Code examples show AEM-specific paths (HTL templates, clientlibs)
5. Suggestions are maintainable (component-level, not page-specific)

**Example validation**:
```bash
cat .cache/*.suggestions.*.json | jq '.suggestions[] | select(.codeExample == null or .codeExample == "")'
```
Should return **empty** (all suggestions must have code examples)

```bash
cat .cache/*.suggestions.*.json | jq '.suggestions[] | select(.codeExample | contains("preload") and contains("image"))'
```
Should return **empty** (no image preload suggestions)

```bash
cat .cache/*.suggestions.*.json | jq '.suggestions[] | select(.codeExample | contains("fetchpriority"))'
```
Should return **image optimization suggestions** with fetchpriority

## Benefits

1. **Practitioner-Friendly**: Copy-paste code examples ready to use
2. **CMS-Aware**: Respects AEM template constraints and Core Components
3. **Maintainable**: Component-level changes, not per-page hacks
4. **Modern Best Practices**: font-display:swap, size-adjust, fetchpriority over preload
5. **Scalable**: Solutions apply across entire site
6. **Concrete**: Actual file paths, not generic advice

## Files Modified

1. **`src/prompts/contexts/aemcs.js`**
   - Added "Practical Implementation Constraints" section
   - Documented AVOID vs PREFER patterns
   - Added code example requirements

2. **`src/prompts/shared.js`**
   - Changed `codeExample` from optional to REQUIRED
   - Added "Code Example Requirements" documentation

3. **`src/prompts/action.js`**
   - Added "Code Example Quality Standards" section
   - Included GOOD vs BAD examples with explanations

## Future Enhancements

1. **Validation for Code Examples**:
   - Add validation rule: `codeExample` must be >50 characters
   - Add validation rule: `codeExample` must contain file path or "File:" prefix
   - Block suggestions with missing or too-short code examples

2. **CMS-Specific Validators**:
   - Detect AEM anti-patterns (image preload, font preload)
   - Warn when suggesting per-page modifications
   - Validate HTL syntax in code examples

3. **Quality Metrics**:
   - Track % of suggestions with code examples
   - Track % using modern best practices (fetchpriority, font-display)
   - Track % with AEM-specific paths

## Related Issues

This addresses the feedback:
- "Image preload is usually not maintainable across a whole site"
- "Templates likely only allow limited flexibility"
- "Stick to loading=eager and fetchpriority=high suggestions"
- "Don't preload fonts, use font-display:swap with size-adjusted fallback"
- "Most suggestions are pretty generic and don't give concrete code samples"

All these concerns are now addressed through enhanced prompts and few-shot examples!
