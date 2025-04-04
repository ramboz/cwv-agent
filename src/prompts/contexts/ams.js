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
`; 