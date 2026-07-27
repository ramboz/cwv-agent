
/**
 * Build a single HTTP `Link` header value that combines multiple preload hints.
 * Format: `</hero.jpg>; rel=preload; as=image; fetchpriority=high, </main.woff2>; rel=preload; as=font; crossorigin=anonymous`.
 * @param {Array<{href:string, as:string, crossorigin?:string, fetchpriority?:string, type?:string}>} preloads
 * @returns {string}
 */
function buildPreloadLinkHeader(preloads) {
  if (!Array.isArray(preloads) || preloads.length === 0) return '';
  const parts = [];
  for (const p of preloads) {
    if (!p || !p.href || !p.as) continue;
    const segments = [`<${p.href}>`, 'rel=preload', `as=${p.as}`];
    if (p.type) segments.push(`type=${p.type}`);
    if (p.fetchpriority) segments.push(`fetchpriority=${p.fetchpriority}`);
    if (p.crossorigin !== undefined && p.crossorigin !== null) {
      const v = p.crossorigin === true || p.crossorigin === '' ? 'anonymous' : p.crossorigin;
      segments.push(`crossorigin=${v}`);
    }
    parts.push(segments.join('; '));
  }
  return parts.join(', ');
}

/**
 * Determine whether a CDP Fetch.requestPaused event is for the HTML document response.
 * Checks the Content-Type header and the resourceType hint when available.
 * @param {object} event
 * @returns {boolean}
 */
function isHtmlDocumentResponse(event) {
  if (!event) return false;
  if (event.resourceType && event.resourceType === 'Document') return true;
  const headers = event.responseHeaders || [];
  for (const h of headers) {
    if (!h || !h.name) continue;
    if (h.name.toLowerCase() === 'content-type') {
      return typeof h.value === 'string' && h.value.toLowerCase().includes('text/html');
    }
  }
  return false;
}

/**
 * Factory: returns a response-stage transformer that emits the Link preload header
 * ONLY for the top-level HTML document response, null otherwise.
 * @param {Array<object>} preloads
 * @returns {(event: object) => (string|null)}
 */
function buildPreloadHeaderTransformer(preloads) {
  const value = buildPreloadLinkHeader(preloads);
  if (!value) return () => null;
  return (event) => (isHtmlDocumentResponse(event) ? value : null);
}

export {
  buildPreloadLinkHeader,
  buildPreloadHeaderTransformer,
  isHtmlDocumentResponse,
};
