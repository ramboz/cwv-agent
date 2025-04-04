/**
 * Technical context for AEM Experience Delivery Service (EDS)
 */
export const EDSContext = `
You know the following about AEM EDS.
 
### Characteristics
 
- the page typically has references either "aem.js" or "lib-franklin.js" in the frontend code (but is not mandatory), a reference to "scripts.js"
- the markup has "data-block-status" data attributes
- the main CDN used is Fastly. Fastly VCL and configs cannot be modified
- the CDN cache headers for the first-party domain are properly optimized already. Cache-Control headers should not be modified for first-party resources.
- the files are purely static and served by the CDN
- the code is usually written in vanilla JavaScript & CSS for the frontend, and the files are usually not minified
- all images starting with "media_" are already minified and served from the CDN using the Fastly Image Optimizer. The images are dynamically optimized at the CDN level and you should not trust the image's extension, but rather look at the "format" query parameter. For instance, if that parameter has the value "webply" this means the image is in WebP (Lossy) format.
- all images starting with "media_" are using loading="lazy" in the initial markup, and the initial markup cannot be changed
- "aem.js" and "lib-franklin.js", if present, are the rendering engine library and they instrument Real User Monitoring (RUM) logic. Those should not be touched and cannot be deferred or loaded asynchronously
- "scripts.js" is responsible for the page rendering flow and is typically composed of 3 phases "loadEager" (which handles the LCP), "loadLazy" which renders the rest of the page, and "loadDelayed" (which loads additional resources that do not directly impact the user experience with a timeout of a few seconds). This file also needs to be executed as early as possible (to minimize its contribution to TBT and ensure timely LCP processing).
- "scripts.js" usually has a "decorateMain" method that is typically used to patch the HTML markup before the page rendering starts, and has to runs in the eager phase before the LCP. For instance, to decorate buttons, a hero block, etc.
- "alloy.min.js" and "at.min.js", when present, are used for experimentation and personalization logic that needs to run before the LCP, in the "loadEager" method, to avoid content flicker and CLS due to asynchronous content updates they may cause. Those files cannot be deferred
- header and footer are loaded asynchronously and are not part of the initial page markup. They should be loaded in the lazy phase
- blocks are loaded asynchronously as needed via inline imports, which contributes to proper code splitting
- themes and templates logic runs in the eager phase (to minimize its contribution to CLS)
- "styles.css" is used for critical styles that need to be loaded render-blocking, and there is a separate "lazy-styles.css" for asynchronous CSS that can be deferred
- custom fonts are loaded asynchronously in the lazy phase to free up the critical path
- HTTP headers can be set for individual pages (i.e. "/home"), or all pages following a generic pattern (i.e. "/products/**")
- The HTML <head> is mostly global for the whole site, and only individual metadata can be changed without a global impact
- Traffic is always on HTTPS
 
### Common Optimizations
 
#### LCP
 
- cleaning up the critical path for the LCP by delaying unused dependencies, martech and third-party libraries
- leveraging inline imports to do tree shaking of the JavaScript files at runtime
- making sure images above the fold, especially in the hero section or block and for the LCP element, are loaded eagerly and with a high fetch-priority. The initial markup itself cannot be modified, so this is typically done via Javascript
- keeping the 1st section short so it doesn't have to wait for every block in it to render before showing the LCP. A good rule of thumb is to not have more than 3 blocks in the first section
- defer non-critical styles and move them out of "styles.css" and into "lazy-styles.css". If they are block-specific keep them in the block's CSS file
- avoiding inlining SVG images in the HTML markup, and instead rely on an "img" element loaded lazily
- header and footer should be loaded in the "loadLazy" phase
- self-hosting third-party resources (like martech, custom fonts, etc.). This helps reduce the number of external hosts that need to be resolved and the number of TLS connections that need to be established
- preloading critical JS and CSS files needed to render the LCP directly in the HTML head or via HTTP Link headers (better) to benefit from Early Hints
- defer third-party embeds (like maps, videos, social widgets, etc.) with a "facade" (i.e. placeholder) and only load them using an Intersection Observer or an actual user interaction
 
#### CLS
 
- ensure all images have proper height and width, or an aspect ratio defined
- making sure that the CSS uses "scrollbar-gutter: stable;" to avoid CLS when the page is longer than the initial viewport
- loading any page template files (CSS and JS) in the eager phase before the LCP
- setting a minimum height on the blocks that are loaded asynchronously to avoid CLS after the block is shown
- when custom fonts are used, they should have the "font-display: swap;" CSS property, and there should also be a fallback font for it in styles.css using a safe web font that has the "size-adjust" CSS property to reduce CLS
 
#### INP
 
- deferring all third-party logic to the delayed phase (except for the experimentation/personalization libraries)
- removing unused tags from the tag manager containers
- breaking up long tasks in event handlers at the project level by leveraging "window.requestAnimationFrame", "window.requestIdleCallback", "window.setTimeout" or "scheduler.yield" APIs
- patching datalayer push operations to forcibly yield to the main thread, so first party event handlers are prioritized and third-party metrics tracking is executed afterwards
- patching global event listeners like "load", "DOMContentLoaded", "click", etc. to forcibly yield to the main thread, so first party event handlers are prioritized and third-party metrics tracking is executed afterwards
 
### Anti-patterns
 
- Do not inline critical CSS for above-the-fold content in the <head>. It would require a build system
- Do not minify CSS and JS files. The files are already small, HTTP compression is already properly configured, and it would again require a build system
- Do not preload the LCP image via meta tags or HTTP headers. Setting loading to eager and fetchpriority to high using Javascript is the recommended approach. The initial markup itself cannot be modified
- Do not add defer or async to third-party scripts in the head. "aem.js"/"lib-franklin.js" are modules and anyways loaded like "defer". Instead load those dependencies via the "loadDelayed" method
- Do not preload JS and CSS for individual blocks. This is considered overkill and would require page-specific rules that won't scale
- Do not preload custom fonts. This would clutter the LCP critical path. Instead, defer the fonts to the lazy phase with appropriate font fallbacks defined
- Do not preload/preconnect any third-party resource that is not in the critical path for the LCP. Instead, let them load async in "loadLazy" or "loadDelayed"
`; 