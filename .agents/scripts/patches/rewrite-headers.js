
/**
 * Convert a glob-style pattern (with `*` wildcards) to a RegExp.
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

/**
 * Compile the rule list once, attaching a RegExp to each rule.
 * @param {Array<object>} rules
 * @returns {Array<object>}
 */
function compileRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      regex: globToRegex(r.urlPattern || '*'),
      set: r.set || null,
      append: r.append || null,
      remove: Array.isArray(r.remove) ? r.remove.map((k) => k.toLowerCase()) : [],
    }));
}

/**
 * Convert an object-of-headers map to CDP Fetch's array form.
 * Preserves existing headers unless overridden.
 * @param {Array<{name:string, value:string}>} existing
 * @param {object} rule
 * @returns {Array<{name:string, value:string}>}
 */
function applyRule(existing, rule) {
  // Map of lowercase-name -> { name, value } to preserve original casing where possible.
  const map = new Map();
  for (const h of existing) {
    if (!h || !h.name) continue;
    map.set(h.name.toLowerCase(), { name: h.name, value: String(h.value ?? '') });
  }
  // Remove first.
  for (const key of rule.remove || []) {
    map.delete(key);
  }
  // Set (overwrites).
  if (rule.set) {
    for (const [k, v] of Object.entries(rule.set)) {
      map.set(k.toLowerCase(), { name: k, value: String(v) });
    }
  }
  // Append (comma-joined per HTTP semantics; falls back to set if absent).
  if (rule.append) {
    for (const [k, v] of Object.entries(rule.append)) {
      const lower = k.toLowerCase();
      const existingEntry = map.get(lower);
      if (existingEntry) {
        existingEntry.value = existingEntry.value + ', ' + String(v);
      } else {
        map.set(lower, { name: k, value: String(v) });
      }
    }
  }
  return Array.from(map.values());
}

/**
 * Build a request-stage header transformer used inside the launcher's CDP handler.
 * Receives the CDP `request` object; returns the mutated header array.
 * @param {Array<object>} rules
 * @returns {(request: object) => Array<{name:string, value:string}>}
 */
function buildRequestHeaderTransformer(rules) {
  const compiled = compileRules(rules);
  return (request) => {
    const headersObj = (request && request.headers) || {};
    let arr = Object.entries(headersObj).map(([name, value]) => ({ name, value: String(value) }));
    const url = (request && request.url) || '';
    for (const rule of compiled) {
      if (rule.regex.test(url)) {
        arr = applyRule(arr, rule);
      }
    }
    return arr;
  };
}

/**
 * Build a response-stage header transformer used inside the launcher's CDP handler.
 * Receives the full Fetch.requestPaused event (has `responseHeaders` array and `request.url`).
 * @param {Array<object>} rules
 * @returns {(event: object) => Array<{name:string, value:string}>}
 */
function buildResponseHeaderTransformer(rules) {
  const compiled = compileRules(rules);
  return (event) => {
    const existing = Array.isArray(event && event.responseHeaders) ? event.responseHeaders.slice() : [];
    const url = (event && event.request && event.request.url) || '';
    let arr = existing.map((h) => ({ name: h.name, value: String(h.value ?? '') }));
    for (const rule of compiled) {
      if (rule.regex.test(url)) {
        arr = applyRule(arr, rule);
      }
    }
    return arr;
  };
}

export {
  buildRequestHeaderTransformer,
  buildResponseHeaderTransformer,
  globToRegex,
  compileRules,
};
