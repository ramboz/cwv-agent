/**
 * Technical context for AEM Managed Services (AMS)
 */
export const AMSContext = `
You know the following about AEM AMS.
 
### Characteristics

- Dispatcher and publish instances managed by Adobe operations team
- Custom CDN configuration possible (Akamai/Fastly/others)
- Dispatcher configuration can be fully customized
- Typically uses classic UI or hybrid UI/Touch UI implementation
- Often relies on legacy Foundation components or custom components
- Client libraries managed through clientlibs framework
- Image optimization handled through custom or built-in servlets
- Implementation often uses JSP or HTL templating
- Often includes legacy code and customizations
- Server-side personalization possible through various mechanisms
- Components often rely on custom JavaScript frameworks
- Deployment through Adobe's Release Management process
- Custom replication agents often implemented
- Dispatcher flush agents handle cache invalidation
- Traffic may use HTTP/HTTPS with potential mixed content

### Common Optimizations

#### LCP

- Optimize Dispatcher TTL settings for static resources
- Configure CDN properly for edge caching of assets
- Implement proper clientlib categorization (css.async, etc.)
- Apply proper image optimization for critical above-the-fold images
- Implement preloading of critical resources
- Configure browser caching properly through Dispatcher
- Implement server-side optimization of critical path rendering
- Reduce time-to-first-byte through Dispatcher tuning
- Optimize component rendering sequence for critical content
- Implement proper HTML caching strategies at the Dispatcher level
- Configure proper flush agents to maintain cache freshness
- Apply proper image sizing and format selection for hero images

#### CLS

- Ensure all images have proper dimensions specified
- Implement proper font-loading strategies
- Reserve space for dynamic content that loads after initial paint
- Implement stable layouts that don't shift during page load
- Ensure advertisements and dynamic content have reserved space
- Use CSS techniques to maintain layout stability
- Implement progressive enhancement for dynamic content
- Ensure proper responsive behaviors for all viewport sizes
- Properly handle lazy-loaded content to maintain layout stability
- Implement content placeholders during loading phases

#### INP

- Optimize JavaScript execution in critical path
- Implement efficient event handling patterns
- Reduce JavaScript bundle sizes through proper clientlib configuration
- Implement main thread work distribution strategies
- Optimize third-party script loading and execution
- Implement code-splitting strategies for JavaScript
- Apply proper debouncing and throttling for event handlers
- Optimize DOM interaction patterns in JavaScript
- Implement efficient data structures for complex operations
- Apply proper task scheduling to prevent long tasks

### Anti-patterns

- Do not inline critical CSS for above-the-fold content in the <head>. It would require a build system
- Do not use synchronous XMLHttpRequest in critical path
- Avoid excessive clientlib dependencies loading in header
- Do not implement custom caching mechanisms that bypass Dispatcher
- Avoid using outdated JavaScript libraries with performance issues
- Do not implement monolithic JavaScript bundles
- Avoid excessive DOM manipulation during initial page load
- Do not rely on inefficient jQuery selectors for critical operations
- Avoid implementing render-blocking resource loading
- Do not neglect proper cache invalidation strategies
- Avoid implementing excessive server-side processing for initial render

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