# WordPress

The worked example of a stack pack (see [`_FORMAT.md`](./_FORMAT.md)).
WordPress powers a large share of the web and has unambiguous fingerprints
and well-known CWV failure shapes.

## Fingerprints

| Signal | Weight |
|--------|--------|
| `/wp-content/` asset paths | HIGH |
| `/wp-includes/` script paths | HIGH |
| `<meta name="generator" content="WordPress ...">` | HIGH (decisive) |
| `wp-emoji` inline script or stylesheet | MEDIUM |
| `admin-ajax.php` requests | MEDIUM |

## Who owns each layer

| Layer | Owner | Notes |
|-------|-------|-------|
| Theme templates + CSS/JS (`wp-content/themes/<theme>/`) | site (`customer-code`) | The main fix surface. Child themes survive updates; edits to a parent theme do not. |
| Plugin assets (`wp-content/plugins/<plugin>/`) | vendor (`third-party`-ish) | Don't edit plugin files — they're overwritten on update. Fix via hooks (`wp_enqueue_script` filters), a perf plugin, or replace the plugin. |
| Core (`wp-includes/`) | platform (`platform-default`) | Never edit. Emoji/embed scripts are dequeued via hooks, not file edits. |
| Media (`wp-content/uploads/`) | content (`customer-content`) | Sizes/formats come from the media pipeline + theme `add_image_size`. |
| Hosting/CDN | operator (`cdn-edge`) | Managed WP hosts often own caching, compression, and HTTP/2+. |

## Where fixes land

- **`preloads`** — the child theme's `header.php`, or PHP:
  `add_action('wp_head', ...)` with priority < 10. Many perf plugins also
  expose a preload field.
- **`markup` attr changes** (e.g. `fetchpriority`, `width`/`height`) — theme
  template files, or filters: `wp_get_attachment_image_attributes`,
  `wp_content_img_tag` (WP ≥ 6.0 adds `fetchpriority="high"` to the first
  content image automatically — check before duplicating).
- **`block` / defer third-party scripts** — dequeue via
  `wp_dequeue_script`/`wp_dequeue_style` in the child theme's
  `functions.php`, or add `defer`/`async` via the `script_loader_tag` /
  `wp_script_add_data` filters. Never hand-edit the emitted HTML.
- **`responseHeaders`** — host/CDN config; on managed hosts this is an
  operator ticket (`requires-operator`).
- **CSS fixes** — the child theme stylesheet or the Customizer's Additional
  CSS (which inlines — fine for small rules, an anti-pattern for big ones).

## Platform-specific anti-patterns

- **Editing parent-theme or plugin files.** Updates silently revert the fix.
  Always a child theme or a hook.
- **Stacking optimization plugins.** Two minify/defer plugins fighting each
  other is a classic INP/TBT source; one well-configured plugin beats three.
- **Dequeuing jQuery blindly.** Many plugins hard-depend on it; dequeue only
  after tracing dependents (the bundle dependency graph rule).
- **"Disable all emojis/embeds" snippets pasted into `functions.php`** —
  fine per se, but verify the savings: these are usually single-digit KB;
  the real LCP/TBT weight is theme CSS, hero media, and page builders.

## Known CWV patterns

- **Page-builder bloat (LCP/TBT)** — builders (Elementor, Divi, WPBakery)
  ship monolithic CSS/JS on every page. Fix path: builder's own
  "optimized assets" mode, per-page asset loading, or rebuilding hot
  templates natively. Maps to `bundling.md` / `unused-code.md`.
- **Unsized featured images (CLS)** — themes that strip `width`/`height`
  from `the_post_thumbnail`. Fix in the template or via
  `wp_get_attachment_image_attributes`. Maps to `image-sizing.md`.
- **Render-blocking plugin CSS (FCP/LCP)** — dozens of small enqueued
  stylesheets; consolidate/dequeue per template. Maps to
  `blocking-resource.md`.
- **Slow TTFB on cheap shared hosting** — no page cache. A page-cache plugin
  or host-level cache is the first move; maps to `ttfb.md` and is
  `cdn-edge`-owned on managed hosts.
