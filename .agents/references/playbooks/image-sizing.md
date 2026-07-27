---
issue_type: image-sizing
risk_tier: low

required_validation:
  - dimensions_known_at_render_time
  - srcset_check
  - markup_source_in_repo

forbidden_techniques:
  - pattern: 'width\s*=\s*"(?:100|placeholder|TODO)"'
    reason: "Don't use placeholder dimensions — pull real values from Lighthouse element attribution"
  - pattern: 'style\s*=\s*"[^"]*aspect-ratio[^"]*"'
    reason: "Inline aspect-ratio style is fragile; use width/height attributes (or a stylesheet rule for responsive images)"
  - pattern: 'dynamicmedia/deliver/\S*[?&](?:wid|hei)='
    reason: "Image-CDN resize params are endpoint-specific — verify the param the endpoint actually honors. A wrong param returns the full-size original (zero bytes saved) and only changes the URL, which can regress LCP via a cold-cache origin fetch. For LCP image-weight reduction see lcp-image.md."

---

# Image sizing

> **Risk tier:** low · **CWV metric:** CLS

## What this addresses

Images without intrinsic dimensions cause layout shift as the browser reflows surrounding content once the image loads. Adding `width` / `height` HTML attributes — *or* a CSS `aspect-ratio` rule that's reliably critical-path — lets the browser reserve space upfront.

> **Scope — this playbook is CLS (layout reservation), not LCP weight.** To cut an LCP hero's transfer *bytes* via image-CDN resize params, see [`lcp-image.md`](./lcp-image.md) → *Reduce LCP image transfer size*.

## When to apply / when to skip

**Apply when:**
- Image is rendered in HTML markup, **or is created by project JavaScript** (e.g. a shared image helper, component decorators, server-side rendered SPAs) — anywhere the markup-emitting code lives in this repo
- No `width` / `height` attributes (or critical-path `aspect-ratio` CSS) currently present
- Real dimensions are available — from Lighthouse element attribution, DAM metadata, the source data being rendered, or a known design-system ratio

**Skip when:**
- Image is created by *third-party* JavaScript that we don't own (vendor SDK, embedded widget) — different fix path, requires upstream change
- Dimensions are genuinely unknown (no Lighthouse attribution, no metadata, and the rendered ratio isn't fixed by the design system)
- Image is purely decorative and zero-sized at the element level (no shift)

## Recommended approaches

### Fixed-size image

Add `width` and `height` attributes matching the image's intrinsic dimensions:

```html
<!-- Good -->
<img src="/content/dam/hero.jpg" width="1200" height="800" alt="Hero">
```

The browser reserves a 3:2 box at any rendered size, so layout doesn't shift when the image loads.

### Responsive image with `srcset`

Keep `width` / `height` on the `<img>` tag (browsers compute aspect-ratio from them) and add a CSS rule so the image scales fluidly:

```html
<img src="hero-800.jpg"
     srcset="hero-400.jpg 400w, hero-800.jpg 800w, hero-1600.jpg 1600w"
     sizes="(max-width: 600px) 400px, 800px"
     width="1600" height="1067" alt="Hero">
```

```css
/* Stylesheet rule, not inline */
img { max-width: 100%; height: auto; }
```

The `width` / `height` attributes give the browser an aspect ratio (1600/1067 ≈ 3:2); `height: auto` in CSS lets the height scale with the rendered width while preserving that ratio.

### CSS-only `aspect-ratio` (no HTML attributes needed)

When the rendered ratio is fixed by the design system (hero, card thumbnail, avatar) rather than by the source image's intrinsic dimensions, a stylesheet rule on the image's class reserves space without any HTML attributes:

```css
/* Stylesheet rule per image class */
.hero-image { aspect-ratio: 16 / 9; width: 100%; height: auto; object-fit: cover; }
```

```html
<img src="hero.jpg" srcset="..." class="hero-image" alt="Hero">
```

This is preferable when:
- The design system enforces the ratio regardless of source image (e.g. a card thumbnail is always 16:9 even when the source is 4:3)
- CSS reliably loads on the critical path (critical CSS inlined, or `<link rel="stylesheet">` not behind a defer / lazy load)

The `width`/`height`-attributes approach is more robust because it works **before** CSS parses (covers FOUC). The CSS-only approach is more flexible for design-driven ratios. Either reserves layout space; pick based on which property (intrinsic vs design-system) drives the ratio.

> **Caveat — `aspect-ratio` needs a definite width to reserve height.** An **inline `<img>`
> inside a `<picture>`** (a common image-helper default) is
> `display:inline` with no definite width, so `aspect-ratio: …; width: 100%` resolves to **zero
> reserved height** and the shift still happens. For `<picture>`, prefer **`width`/`height`
> attributes on the `<img>` *and* on each `<source>`** (browsers read per-`<source>` dimensions
> for art-directed pictures) — attributes reserve the box even for `loading="lazy"` images and
> even before CSS parses. Use CSS `aspect-ratio` only on a block-level element with a resolvable
> width. (Verified on about.ups.com: CSS `aspect-ratio` on the inline hero `<img>` reserved
> nothing; `width`/`height` attrs on `<source>`+`<img>` eliminated the +283px shift.)

### Setting attributes in a shared image helper

When the markup is generated by a shared image helper (e.g. a `createOptimizedPicture`-style function), the fix is one line in the helper rather than per-image markup edits:

```javascript
// Good — setting width/height in createOptimizedPicture (block-level fix)
const img = document.createElement('img');
img.src = url;
img.alt = alt;
img.width = width;     // from DAM metadata or source-data dimensions
img.height = height;
img.loading = lazy ? 'lazy' : 'eager';
picture.appendChild(img);
```

A single edit in the helper applies the fix to every image the block emits, with no per-page churn.

## Anti-patterns

### Placeholder dimensions

```html
<!-- Bad -->
<img src="/content/dam/hero.jpg" width="100" height="100" alt="Hero">
```

**Why this is bad:** The actual image is 1200×800. A 100×100 reservation does nothing for the real layout — the shift still happens when the actual size arrives. Always use real Lighthouse dimensions, never placeholders.

### Inline `aspect-ratio` style

```html
<!-- Bad -->
<img src="/content/dam/hero.jpg" style="aspect-ratio: 3/2" alt="Hero">
```

**Why this is bad:** Inline style is harder to override per-breakpoint, doesn't help browsers that compute layout reservation from `width`/`height` attributes, and creates inconsistencies across the same image used in different components.

### Setting dimensions after the image is in the DOM

```html
<!-- Bad -->
<img src="/content/dam/hero.jpg" alt="Hero" data-set-size-on-load>
<script>
  document.querySelectorAll('img[data-set-size-on-load]').forEach((img) => {
    img.addEventListener('load', () => {
      img.width = img.naturalWidth;
      img.height = img.naturalHeight;
    });
  });
</script>
```

**Why this is bad:** the script sets dimensions *after* the image has already loaded, which is also after layout has already shifted at least once. CLS captures shifts up to ~5s after page load, so post-load sizing typically fires too late to matter.

This is different from JS that **emits** image markup with correct attributes from the start (e.g. a shared image helper, component decorators, SSR'd SPAs). Those are fine — see the "Setting attributes in a shared image helper" recommended approach above.
