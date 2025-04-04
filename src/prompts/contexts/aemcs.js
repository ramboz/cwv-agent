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
`; 