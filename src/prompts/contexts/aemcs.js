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
- RECOMMENDED: Inline critical CSS (<14KB) in <style> tag for above-the-fold content
- RECOMMENDED: Load non-critical CSS asynchronously using JavaScript with requestIdleCallback
  - Example: Use createElement('link') in requestIdleCallback to load non-critical clientlibs
- RECOMMENDED: Split clientlibs into critical (sync) and non-critical (async) categories
- AVOID: Using media="print" hack for async CSS (violates HTML spec, accessibility issues)
  - Example of anti-pattern: <link rel="stylesheet" href="..." media="print" onload="this.media='all'">
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
- AVOID: Preconnect for non-critical resources (analytics, fonts loaded async, third-party scripts)
  - Bad: <link rel="preconnect" href="https://fonts.googleapis.com"> (fonts should use font-display:swap, not preconnect)
  - Bad: <link rel="preconnect" href="https://analytics.example.com"> (analytics is not in LCP critical path)
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
`; 