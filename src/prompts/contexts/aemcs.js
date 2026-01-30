/**
 * Technical context for AEM Cloud Service (CS)
 */
export const AEMCSContext = `
You know the following about AEM CS.
 
### Characteristics

- Dispatcher and CDN layer managed by Adobe
- Standard Adobe CDN is Fastly, with configuration capabilities
- Dispatcher can be customized via configuration files
- Frontend assets delivered through a combination of CDN and Dispatcher
- Core Components based markup with predictable HTML structure
- Client libraries (clientlibs) manage CSS and JavaScript bundling
- Adaptive Image Servlet handles image optimization
- Modern implementation relies on editable templates and Core Components
- Core Components implement responsive images with breakpoints
- Components typically follow BEM naming convention in CSS
- AEM SDK and Cloud Manager pipelines handle code deployment
- HTML structure can be customized via HTL templates
- Dynamic server-side personalization possible via ContextHub
- Page structure uses container/component hierarchy
- ClientLibs can be categorized as "js", "css", "dependencies", etc.
- Traffic is always on HTTPS

### Common Optimizations

#### LCP

- Configure clientlibs properly with categories to control loading order
- Set "async" and "defer" attributes to non-critical JavaScript
- Enable client-side libraries minification in production mode
- Implement proper responsive image handling for hero images
- Configure image breakpoints based on device viewport sizes
- Leverage Core Components image optimization features
- Configure proper Cache-Control headers in Dispatcher configuration
- Avoid excessive DOM depth in the component structure
- Optimize server-side rendering time for critical components
- Implement proper image format selection (WebP) via adaptive serving
- Implement preconnect for external domains used in the critical path
- Use HTTP/2 Server Push for critical resources via Dispatcher configuration

#### CLS

- Properly configure image dimensions in Core Components
- Implement CSS best practices for layout stability
- Use Core Components with proper responsive behaviors
- Avoid late-loading content that shifts page layout
- Implement proper content placeholders during loading phases
- Reserve space for dynamic content using CSS techniques
- Properly configure font loading strategies
- Utilize CSS containment where appropriate
- Set explicit width/height for all media elements
- Implement proper lazy loading strategies for below-the-fold content

#### INP

- Optimize clientlib JavaScript for performance
- Utilize efficient event delegation patterns
- Implement code-splitting for JavaScript bundles
- Optimize component initialization scripts
- Implement efficient DOM manipulation strategies
- Defer non-critical JavaScript execution
- Optimize third-party script loading and execution
- Implement proper task scheduling for JavaScript execution
- Optimize event handlers to avoid long tasks
- Break up large JavaScript operations into smaller chunks

### Anti-patterns

- Do not inline critical CSS for above-the-fold content in the <head>. It would require a build system
- Do not rely on excessive client-side rendering for critical content
- Avoid using monolithic clientlibs that load everything at once
- Do not use synchronous XMLHttpRequest for component data loading
- Avoid excessive DOM manipulation during page load
- Do not load large JavaScript libraries in the critical rendering path
- Avoid using deprecated AEM Foundation components that aren't optimized
- Do not depend on heavy jQuery operations for core functionality
- Avoid excessive CSS specificity that leads to performance issues
- Do not implement custom image handling that bypasses adaptive images
- Avoid implementing custom clientlib categories that bypass optimization

### Practical Implementation Constraints

**Image Optimization Recommendations:**
- AVOID: Suggesting page-specific <link rel="preload"> for hero images (not maintainable across site)
- PREFER: Use loading="eager" and fetchpriority="high" on hero images (works in templates)
- PREFER: Component-level image attribute configuration (scales across pages)
- Example: Update Image Core Component HTL to add fetchpriority="high" for above-fold images

**Font Loading Recommendations:**
- AVOID: Preloading fonts (can cause wasted bandwidth, CLS issues)
- PREFER: font-display: swap with size-adjusted fallback fonts (minimizes FOUT and CLS)
- PREFER: Preconnect to font origin (dns-prefetch + preconnect)
- Example: Use @font-face with font-display: swap and size-adjust property for fallback

**CSS Loading Recommendations:**
- RECOMMENDED: Split clientlibs into critical (sync) and non-critical (async) categories
  - Example: Create separate clientlib categories per template/component
  - Load critical clientlibs synchronously in <head>
  - Load non-critical clientlibs asynchronously using JavaScript
- AVOID: Inlining critical CSS in <style> tag (requires build system, not maintainable across AEM sites)
- RECOMMENDED: Load non-critical CSS asynchronously using JavaScript with requestIdleCallback
  - Example: Use createElement('link') in requestIdleCallback to load non-critical clientlibs
- AVOID: Using media="print" hack for async CSS (violates HTML spec, accessibility issues)
  - Example of anti-pattern: <link rel="stylesheet" href="..." media="print" onload="this.media='all'">
- AVOID: Using <link rel="preload" as="style" onload="..."> hack for async CSS (equally problematic)
  - Example of anti-pattern: <link rel="preload" href="..." as="style" onload="this.onload=null;this.rel='stylesheet'">
  - Issues: Violates preload semantics, accessibility problems, harder to debug than JavaScript approach
- AVOID: Loading 15+ render-blocking CSS files synchronously
- AVOID: Including 100% unused CSS clientlibs (audit with Coverage DevTools)
- AVOID: Cross-origin render-blocking CSS without preconnect
- PREFER: JavaScript-based async loading pattern:
  \`\`\`javascript
  // Load non-critical CSS asynchronously
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/etc.clientlibs/mysite/clientlibs/clientlib-base.min.css';
      document.head.appendChild(link);
    });
  } else {
    setTimeout(() => { /* same as above */ }, 1);
  }
  \`\`\`

**Resource Hints:**
- Preconnect: ONLY for external origins in the critical path for LCP (e.g., CDN hosting hero image)
  - Example: <link rel="preconnect" href="https://cdn.example.com"> if hero image loads from cdn.example.com
  - Valid use cases: CDN hosting LCP image, critical font CDN (if above-fold text)

- **NEVER PRECONNECT - These categories should ALWAYS be deferred/async instead:**
  - Cookie Consent: cookielaw.org, cdn.cookielaw.org, onetrust.com, cookiebot.com
    → Consent banners never affect LCP, always defer to post-LCP
  - Analytics: google-analytics.com, analytics.*, omtrdc.net
    → Analytics doesn't affect rendering, load async
  - Tag Managers: googletagmanager.com, assets.adobedtm.com (Adobe Launch)
    → Load async unless doing above-fold personalization (see exception below)
  - Monitoring: hotjar.com, fullstory.com, logrocket.com, newrelic.com
    → Session replay/monitoring is never rendering-critical
  - Social: facebook.net, twitter.com, linkedin.com
    → Social pixels are never LCP-critical
  - A/B Testing: optimizely.com, vwo.com
    → Unless doing above-fold flicker-prevention (rare)

- **Exception - Adobe Target Personalization:**
  - If Adobe Launch (adobedtm) is loading Adobe Target AND there's above-fold personalization:
    → Preconnect MAY be justified to reduce personalization flicker
  - Detection signal: Look for at.js, mbox calls, or Target-specific code
  - If no Target detected: Adobe Launch should load async, NOT preconnect

- Preload: Only for critical, discoverable-late resources in clientlibs (not content images)
  - Example: Critical CSS/JS in clientlibs that would otherwise be discovered late
- DNS-prefetch: Avoid - no practical use case for modern sites
  - If it's blocking LCP, use preconnect instead (does DNS + TCP + TLS)
  - If it's not blocking LCP, load it async later (no hint needed)
- Rule of thumb: If it affects LCP, use preconnect. If it doesn't affect LCP, load it async later.

**Code Example Requirements:**
- Always provide AEM-specific implementation paths (HTL templates, clientlib categories, Dispatcher config)
- Show actual file locations: /apps/myproject/components/content/hero/hero.html
- Include Dispatcher configuration snippets when suggesting caching changes
- Reference Core Components version-specific APIs when applicable

### TTFB Optimization and Caching

**Dispatcher Cache Detection:**
- X-Dispatcher-Cache header indicates cache status: "HIT" (cached) or "MISS" (origin fetch)
- Cache misses indicate content served from publish instance (slow)
- High cache miss rate suggests dispatcher.any rules need tuning

**Cache Invalidation Patterns:**
- Stat file invalidation: Content changes invalidate entire cache tree
- Auto-invalidation: Configured via /invalidate rules in dispatcher.any
- Manual invalidation: Flush agents or API calls
- TTL-based: Cache-Control headers for time-based expiry

**Common TTFB Issues:**
1. **Dispatcher Cache Miss**: Check X-Dispatcher-Cache header
   - Fix: Review /cache rules in dispatcher.any, ensure content paths are cached
   - Example: Add /cache { /rules { /0001 { /glob "*.html" /type "allow" } } }

2. **Sling Model Performance**: N+1 queries in components
   - Fix: Use lazy loading, batch queries, or cache Sling Model results
   - Example: @Model(adaptables = Resource.class, cache = true)

3. **CDN Cache Miss**: Check cf-cache-status or x-fastly-cache headers
   - Fix: Ensure proper Cache-Control headers, check CDN rules
   - Example: Set Cache-Control: max-age=3600 for static content

**Dispatcher Configuration Snippets:**

Cache HTML pages:
\`\`\`
/cache {
  /rules {
    /0001 { /glob "*.html" /type "allow" }
  }
  /headers {
    "Cache-Control"
    "Content-Type"
    "Expires"
  }
}
\`\`\`

Set Cache-Control headers:
\`\`\`
/headers {
  # Add Cache-Control for static assets
  <LocationMatch "^/content/dam/.*\\.(jpg|jpeg|png|gif|svg|webp)$">
    Header set Cache-Control "max-age=86400, public"
  </LocationMatch>
  # Add Cache-Control for clientlibs
  <LocationMatch "^/etc\\.clientlibs/.*\\.(js|css)$">
    Header set Cache-Control "max-age=31536000, public, immutable"
  </LocationMatch>
}
\`\`\`

**Server-Timing Header Analysis:**
- AEM CS may include Server-Timing headers showing processing breakdown
- Look for: cdn (CDN processing), origin (publish processing), dispatcher (cache lookup)
- Example: Server-Timing: cdn;dur=5, dispatcher;dur=10, origin;dur=1200
- High "origin" time indicates slow publish instance or Sling Model issues

**CDN Configuration (Fastly):**
- Adobe CDN is Fastly by default
- Custom CDN rules via Cloud Manager configuration
- VCL snippets for advanced caching logic
- Edge-side includes (ESI) for partial page caching

**Caching Best Practices:**
- Static assets (JS/CSS/images): max-age=31536000 (1 year) with versioned URLs
- HTML pages: max-age=300-3600 depending on content freshness needs
- API responses: Cache-Control: no-store for personalized content
- Use stale-while-revalidate for improved perceived performance
`;
 