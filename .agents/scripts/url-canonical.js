
/**
 * url-canonical.js — zero-dependency URL canonicalization + selector URL
 * extraction helpers.
 *
 * Problem space
 * -------------
 * Analyzer emitters across html-parse, image-analysis, coverage, waterfall
 * and the correlator quote the same logical resource with different string
 * forms: relative vs absolute, encoded entities (`&#x26;`, `&amp;`) vs raw
 * `&`, query params in different orders, upper/lowercase scheme+host, and
 * default vs explicit ports. That causes duplicate candidates at ranking
 * time — two candidates for the same resource + intervention can burn the
 * experiment budget twice.
 *
 * This module exposes pure helpers used by rank-candidates.js (belt-and-
 * braces dedup pass) and documented in Rule 5e of .agents/skills/cwv-
 * analyze.md.
 *
 * Exports
 * -------
 *  canonicalUrl(raw, base?)                  → string (or raw on failure)
 *  urlsMatch(a, b, base?)                    → boolean
 *  extractUrlsFromSelector(selector)         → Array<{ mode, url }>
 *  htmlDecode(s)                             → string
 */

/**
 * HTML-decode a string. Handles the common named entities plus decimal and
 * hex numeric character references. Intentionally minimal — the analyzers
 * that feed us only emit attribute values, so we avoid pulling in a full
 * HTML parser.
 *
 * @param {string} s
 * @returns {string}
 */
function htmlDecode(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      if (!Number.isFinite(code)) return _;
      try { return String.fromCodePoint(code); } catch { return _; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      if (!Number.isFinite(code)) return _;
      try { return String.fromCodePoint(code); } catch { return _; }
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Canonicalize a URL for equality comparison.
 *
 * Rules (applied in order):
 *   1. data: URLs are returned as-is (no canonicalization — they're
 *      inline and the full string IS the identity).
 *   2. HTML entities are decoded (&#x26; → &, &amp; → &, numeric refs).
 *   3. Resolve against base (if supplied).
 *   4. Lowercase scheme + host.
 *   5. Strip default ports (80 for http, 443 for https).
 *   6. Decode percent-encoding in the path (preserving spaces as %20 by
 *      re-encoding them after the full decode pass).
 *   7. Sort query params by key (stable secondary sort by value).
 *   8. Drop fragment.
 *   9. Bare-origin URLs lose the trailing slash ("http://x.com/" → "http://x.com").
 *  10. On parse failure, return the raw input — never throw.
 *
 * @param {string} raw   The URL string to canonicalize.
 * @param {string} [base] Optional base URL for resolving relatives.
 * @returns {string}     Canonical URL or raw on failure.
 */
function canonicalUrl(raw, base) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  // data: URLs are self-contained identities. Don't touch them.
  if (/^data:/i.test(trimmed)) return trimmed;

  const decoded = htmlDecode(trimmed);

  let u;
  try {
    u = base ? new URL(decoded, base) : new URL(decoded);
  } catch {
    return raw;
  }

  // Scheme + host lowercasing (URL already does this in most browsers but
  // Node is explicit about preserving userinfo casing, which we don't
  // particularly care about here; scheme+host is what matters).
  const scheme = u.protocol.toLowerCase();
  const host = u.hostname.toLowerCase();
  let port = u.port;

  // Strip default ports.
  if ((scheme === 'http:' && port === '80') || (scheme === 'https:' && port === '443')) {
    port = '';
  }

  // Path: percent-decode, but preserve spaces as %20 for consistency.
  let pathname;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch {
    pathname = u.pathname;
  }
  pathname = pathname.replace(/ /g, '%20');

  // Sort query params by key, secondary by value — both stable.
  const params = Array.from(u.searchParams.entries());
  params.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  const search = params.length
    ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';

  // Auth (userinfo) — preserve as-is if present.
  const userinfo = u.username
    ? (u.password ? `${u.username}:${u.password}@` : `${u.username}@`)
    : '';

  const authority = `${userinfo}${host}${port ? ':' + port : ''}`;

  // Bare-origin trailing-slash collapse.
  let finalPath = pathname;
  const isBareOrigin = (pathname === '/' || pathname === '') && search === '';
  if (isBareOrigin) finalPath = '';

  return `${scheme}//${authority}${finalPath}${search}`;
}

/**
 * Shallow equality of two URLs under canonicalization.
 *
 * @param {string} a
 * @param {string} b
 * @param {string} [base]
 * @returns {boolean}
 */
function urlsMatch(a, b, base) {
  if (a === b) return true;
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return canonicalUrl(a, base) === canonicalUrl(b, base);
}

/**
 * Extract URL references from a CSS selector string.
 *
 * Recognized shapes:
 *   [src="..."], [src='...'], [src=...]         → { mode: 'exact', url }
 *   [href="..."], [href='...'], [href=...]      → { mode: 'exact', url }
 *   [src^="..."], [src^='...']                  → { mode: 'prefix', url }
 *   [src*="..."], [src*='...']                  → { mode: 'contains', url }
 *   [src$="..."], [src$='...']                  → { mode: 'suffix', url }
 *   (same substring operators apply to href)
 *
 * Returns an empty array if nothing matches.
 *
 * NOTE: only `mode: 'exact'` entries are safe to use for equality-based
 * dedup. Prefix/contains/suffix are documented for completeness but callers
 * should filter to exact-match before merging.
 *
 * @param {string} selector
 * @returns {Array<{ mode: 'exact'|'prefix'|'contains'|'suffix', url: string }>}
 */
function extractUrlsFromSelector(selector) {
  if (typeof selector !== 'string' || !selector) return [];
  const out = [];
  // Match [attr][op]="value" / [attr][op]='value' / [attr][op]=value
  // attr ∈ {src, href}; op ∈ {'', ^, *, $}.
  const re = /\[(src|href)(\^|\*|\$)?=(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\]/gi;
  let m;
  while ((m = re.exec(selector)) !== null) {
    const op = m[2] || '';
    const value = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : '';
    if (!value) continue;
    let mode = 'exact';
    if (op === '^') mode = 'prefix';
    else if (op === '*') mode = 'contains';
    else if (op === '$') mode = 'suffix';
    out.push({ mode, url: value });
  }
  return out;
}

export {
  canonicalUrl,
  urlsMatch,
  extractUrlsFromSelector,
  htmlDecode,
};
