// Shared CSS-selector construction helpers. Analyzers emit patch.markup[]
// selectors like `img[src="${url}"]`; any URL containing `"` or `\` would
// otherwise break out of the attribute-selector quoted string, matching
// nothing at runtime. `cssEscapeAttrValue` escapes those two characters per
// the CSS Syntax spec — the minimum needed for safe interpolation inside a
// double-quoted `[name="VALUE"]` selector.
//
// Consumers: html-parse.js, chain-rum-correlator.js, waterfall-shift.js.
// Note: this module does NOT handle HTML-entity decoding — that is the
// parser's responsibility (see html-parse.js `parseAttrs`). Inputs here
// should already be decoded.

/**
 * Escape a decoded attribute value for safe embedding inside a
 * double-quoted CSS attribute selector (`[name="VALUE"]`).
 *
 * @param {string} value Decoded attribute value.
 * @returns {string} Value with `\` and `"` backslash-escaped.
 */
function cssEscapeAttrValue(value) {
  if (value == null) return '';
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export { cssEscapeAttrValue };
