
/**
 * html-parse.js — static HTML structural analyzer.
 *
 * Fetches the raw server-rendered HTML (no JS execution) for a URL and inspects
 * <head> + above-the-fold DOM for structural CWV issues. Emits Findings per
 * .agents/references/topics/finding-schema.md (schemaVersion 1.0, source="html",
 * confidence cap 0.75).
 *
 * Regex-based extraction (no jsdom/cheerio) — works for well-formed markup.
 *
 * NOTE: fetches with a non-browser UA → WAF/bot-protected origins (Akamai/Cloudflare)
 * return 403/a challenge page; use the Puppeteer analyzers (launcher.js/coverage.js/
 * image-analysis.js) there. See ../../references/topics/html-structure.md → "WAF / bot protection".
 * Heuristics implemented (see ../../references/topics/html-structure.md):
 *   1. Render-blocking <script> in <head> without async/defer
 *   2. <img> missing width/height (first ~10KB of <body>)
 *   3. LCP-candidate <img> missing fetchpriority="high"
 *   4. Missing <meta name="viewport">
 *   5. Large render-blocking stylesheet without preload hint
 *   6. Inline <script> >5KB in <head>
 *   7. Favicon before first stylesheet in discovery order
 *   8. Preconnect / dns-prefetch to deferrable-tier third parties (analytics, RUM, etc.)
 *   9. Inline SVG payload in early body markup
 *  10. AEM EDS structural contract failure (reveal/page-shape gate)
 *
 * CLI:
 *   node html-parse.js --url <URL> [--output <path>]
 *   node html-parse.js --html <path-to-html-file> [--url <URL>] [--output <path>]
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { validateFinding } from '../finding-schema.js';

const SCHEMA_VERSION = '1.0';
const SOURCE = 'html';
const CONFIDENCE_CAP = 0.75;
const SKILL = 'cwv-diagnose';

// --------------------------------------------------------------------------
// HTML entity decoding + CSS attribute-value escaping.
//
// HTML attribute values arrive percent-/entity-encoded from the raw source
// (e.g. `href="/p?a=1&amp;b=2"`). We must decode them before:
//   (a) using them as URLs (so downstream URL comparisons match actual
//       network requests), and
//   (b) embedding them in CSS selectors (so `img[src="..."]` matches the
//       parsed DOM, which holds the decoded value).
//
// Conversely, once decoded, a value may contain `"` or `\` that would break
// a `[attr="..."]` CSS selector. `cssEscapeAttrValue` escapes those two
// characters per the CSS Syntax spec — the minimum needed for safe
// interpolation inside a double-quoted attribute selector.
// --------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
};

/**
 * Decode a limited but sufficient set of HTML entities found in attribute
 * values: named entities listed above, decimal (`&#NN;`), and hex
 * (`&#xHH;`) numeric character references. Unknown entities pass through
 * unchanged.
 *
 * @param {string} str Raw attribute value as it appears in source HTML.
 * @returns {string} Decoded value matching what a real parser would yield.
 */
function decodeHtmlEntities(str) {
  if (str == null || str === '') return str;
  if (typeof str !== 'string') return str;
  if (str.indexOf('&') === -1) return str;
  return str.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const isHex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88; // x/X
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const named = NAMED_ENTITIES[body];
    return named != null ? named : match;
  });
}

// CSS-attribute-value escaping is shared with other analyzers — imported
// from `.agents/scripts/selector-utils.js` so all selector construction
// across the toolkit uses one implementation.
import { cssEscapeAttrValue } from '../selector-utils.js';

// --------------------------------------------------------------------------
// Domain classification (DEFERRABLE tier from topics/martech.md).
// --------------------------------------------------------------------------

const DEFERRABLE_HOST_PATTERNS = [
  /(^|\.)google-analytics\.com$/i,
  /(^|\.)googletagmanager\.com$/i,
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)facebook\.(com|net)$/i,
  /(^|\.)connect\.facebook\.net$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)licdn\.com$/i,
  /(^|\.)segment\.(com|io)$/i,
  /(^|\.)hotjar\.com$/i,
  /(^|\.)fullstory\.com$/i,
  /(^|\.)mouseflow\.com$/i,
  /(^|\.)clarity\.ms$/i,
  /(^|\.)sentry\.io$/i,
  /(^|\.)datadoghq\.com$/i,
  /(^|\.)newrelic\.com$/i,
  /(^|\.)nr-data\.net$/i,
  /(^|\.)onetrust\.com$/i,
  /(^|\.)cookielaw\.org$/i,
  /(^|\.)trustarc\.com$/i,
  /(^|\.)cookiebot\.com$/i,
  /(^|\.)intercom\.(io|com)$/i,
  /(^|\.)drift\.com$/i,
  /(^|\.)zdassets\.com$/i,
  /(^|\.)zopim\.com$/i,
  /(^|\.)adsystem\.amazon\.com$/i,
];

function isDeferrableHost(host) {
  if (!host) return false;
  return DEFERRABLE_HOST_PATTERNS.some((re) => re.test(host));
}

// --------------------------------------------------------------------------
// Regex-based HTML extraction.
// --------------------------------------------------------------------------

/** Strip HTML comments (non-nested) — safer for <head> scanning. */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** Find the <head>…</head> region (case-insensitive). */
function extractHead(html) {
  const m = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i);
  return m ? { inner: m[1], start: m.index, end: m.index + m[0].length } : null;
}

/** Find the <body>…</body> region (case-insensitive). */
function extractBody(html) {
  const m = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  return m ? { inner: m[1], start: m.index } : null;
}

/** Find the <main>…</main> region (case-insensitive). */
function extractMain(html) {
  const m = html.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i);
  return m ? { inner: m[1], start: m.index } : null;
}

/**
 * Parse attributes from a single opening tag body.
 * Handles quoted ("..." / '...') and unquoted attributes, booleans.
 * Returns a flat {name: value} map with lowercase names.
 */
function parseAttrs(tagBody) {
  const attrs = {};
  // tagBody is the inner substring after the tag name. Example: ` rel="stylesheet" href=/foo.css`.
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;
  let m;
  while ((m = re.exec(tagBody)) !== null) {
    const name = m[1].toLowerCase();
    const rawValue = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
    attrs[name] = decodeHtmlEntities(rawValue);
  }
  return attrs;
}

/**
 * Iterate tags of a given name within a region. Returns array of
 * { raw, attrs, index } in source order. Handles self-closing and normal forms.
 */
function findTags(region, tagName) {
  const out = [];
  const re = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  let m;
  while ((m = re.exec(region)) !== null) {
    out.push({ raw: m[0], attrs: parseAttrs(m[1] || ''), index: m.index });
  }
  return out;
}

/**
 * Extract inline <script>…</script> blocks (those without `src`).
 * Returns [{ attrs, body, index }].
 */
function findInlineScripts(region) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(region)) !== null) {
    const attrs = parseAttrs(m[1] || '');
    if (attrs.src) continue;
    out.push({ attrs, body: m[2] || '', index: m.index });
  }
  return out;
}

function findInlineStyles(region) {
  const out = [];
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
  let m;
  while ((m = re.exec(region)) !== null) {
    out.push({ attrs: parseAttrs(m[1] || ''), body: m[2] || '', index: m.index });
  }
  return out;
}

/**
 * Extract inline <svg>...</svg> blocks. This is intentionally shallow: it is
 * enough for SVG payload-size heuristics, not a general HTML parser.
 */
function findInlineSvgs(region) {
  const out = [];
  const re = /<svg\b([^>]*)>[\s\S]*?<\/svg\s*>/gi;
  let m;
  while ((m = re.exec(region)) !== null) {
    out.push({ raw: m[0], attrs: parseAttrs(m[1] || ''), index: m.index });
  }
  return out;
}

function stripTags(markup) {
  return String(markup || '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract top-level <div> elements from a region. This is deliberately narrow:
 * EDS pages represent sections as top-level divs under <main>, and pulling only
 * that level avoids treating nested block content as sections.
 */
function findTopLevelDivs(region) {
  const out = [];
  const re = /<\/?div\b[^>]*>/gi;
  let depth = 0;
  let current = null;
  let m;
  while ((m = re.exec(region)) !== null) {
    const raw = m[0];
    const closing = /^<\/div\b/i.test(raw);
    const selfClosing = /\/\s*>$/.test(raw);
    if (!closing) {
      if (depth === 0) {
        current = {
          start: m.index,
          openEnd: re.lastIndex,
          openTag: raw,
          attrs: parseAttrs(raw.replace(/^<div\b/i, '').replace(/\/?>$/i, '')),
        };
      }
      depth += 1;
      if (selfClosing) depth -= 1;
      if (selfClosing && depth === 0 && current) {
        current.end = re.lastIndex;
        current.inner = '';
        current.raw = raw;
        out.push(current);
        current = null;
      }
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0 && current) {
        current.end = re.lastIndex;
        current.inner = region.slice(current.openEnd, m.index);
        current.raw = region.slice(current.start, re.lastIndex);
        out.push(current);
        current = null;
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Finding helpers.
// --------------------------------------------------------------------------

let idCounter = 0;
function nextId(metric, tag) {
  idCounter += 1;
  return `diagnose-${(metric || 'cwv').toLowerCase()}-${tag}-${idCounter}`;
}

function resetIds() { idCounter = 0; }

function clampConfidence(v) {
  return Math.min(CONFIDENCE_CAP, Math.max(0, v));
}

function deriveSeverity(metric, valueMs, score) {
  // Per finding-schema.md MIN_ACTIONABLE_IMPACT.
  const floors = {
    LCP: { delta: 200, type: 'ms' },
    CLS: { delta: 0.03, type: 'score' },
    INP: { delta: 50, type: 'ms' },
    TBT: { delta: 100, type: 'ms' },
    FCP: { delta: 150, type: 'ms' },
    TTFB: { delta: 150, type: 'ms' },
  };
  const f = floors[metric];
  if (!f) return 'low';
  const mag = Math.abs(f.type === 'ms' ? (valueMs || 0) : (score || 0));
  if (mag >= 3 * f.delta) return 'high';
  if (mag >= f.delta) return 'medium';
  return 'low';
}

function makeFinding({ url, timestamp, metric, type, cause, recommendation, evidence,
  impactReduction, patches, rootCause, severityOverride, confidence }) {
  const primaryMetric = Array.isArray(metric) ? metric[0] : metric;
  const sev = severityOverride || deriveSeverity(
    impactReduction.metric,
    impactReduction.valueMs,
    impactReduction.score,
  );
  const f = {
    schemaVersion: SCHEMA_VERSION,
    id: nextId(primaryMetric, type),
    timestamp,
    url,
    skill: SKILL,
    source: SOURCE,
    metric: Array.isArray(metric) ? metric : [metric],
    type,
    severity: sev,
    rootCause: !!rootCause,
    cause,
    evidence,
    recommendation,
    confidence: clampConfidence(confidence != null ? confidence : 0.7),
    impactReduction,
    status: 'proposed',
  };
  if (patches) f.patches = patches;
  return f;
}

// --------------------------------------------------------------------------
// Heuristics.
// --------------------------------------------------------------------------

/**
 * Resolve an href relative to a base. Returns absolute URL string or the original.
 */
function absolutize(href, baseUrl) {
  if (!href) return href;
  try {
    return new URL(href, baseUrl || 'https://example.invalid/').toString();
  } catch {
    return href;
  }
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * H1 — Render-blocking <script src=…> in <head> without async/defer.
 * Emits one Finding per blocking script (deduped by URL).
 */
function checkRenderBlockingScripts(head, ctx) {
  const findings = [];
  const scripts = findTags(head.inner, 'script');
  const seen = new Set();
  for (const s of scripts) {
    const src = s.attrs.src;
    if (!src) continue; // inline handled elsewhere
    if (s.attrs.async != null || s.attrs.defer != null) continue;
    // module scripts are defer-by-default.
    if ((s.attrs.type || '').toLowerCase() === 'module') continue;
    const abs = absolutize(src, ctx.url);
    if (seen.has(abs)) continue;
    seen.add(abs);
    findings.push(makeFinding({
      url: ctx.url,
      timestamp: ctx.timestamp,
      metric: ['LCP', 'FCP'],
      type: 'bottleneck',
      cause: `Render-blocking <script src="${src}"> in <head> without async/defer blocks HTML parsing.`,
      recommendation: `Add \`defer\` (or \`async\` if order-independent) to \`<script src="${src}">\`, or move it to the end of <body>.`,
      evidence: [
        {
          kind: 'rule-violation',
          data: {
            ruleId: 'html/blocking-script-in-head',
            match: s.raw.slice(0, 300),
            context: { tag: 'script', location: 'head', attrs: s.attrs },
          },
        },
        { kind: 'resource-timing', data: { url: abs, type: 'script' } },
      ],
      impactReduction: { metric: 'LCP', valueMs: 150 },
      rootCause: false,
      confidence: 0.7,
      patches: {
        markup: [{ selector: `script[src="${cssEscapeAttrValue(src)}"]`, attrs: { defer: '' } }],
      },
    }));
  }
  return findings;
}

/**
 * H2 — <img> missing width/height in top ~10KB of <body>.
 */
function checkMissingImgDimensions(body, ctx) {
  const findings = [];
  if (!body) return findings;
  const slice = body.inner.slice(0, 10 * 1024);
  const imgs = findTags(slice, 'img');
  for (const img of imgs) {
    const src = img.attrs.src || img.attrs['data-src'] || '';
    const hasW = img.attrs.width != null;
    const hasH = img.attrs.height != null;
    // Both must be present; presence of only one still triggers CLS risk but less severe.
    if (hasW && hasH) continue;
    // Skip analytics/tracking beacons — they're invisible (display:none / 1×1)
    // and cause no layout shift, so flagging them as a CLS source is a false
    // positive. (otempo G3: a Comscore tracking pixel with no width/height was
    // fingered as a CLS rootCause.)
    if (/scorecardresearch|comscore|doubleclick\.net|google-analytics|googletagmanager|facebook\.com\/tr|\/(pixel|beacon|collect|track(?:ing)?)([./?]|$)/i.test(src)) continue;
    findings.push(makeFinding({
      url: ctx.url,
      timestamp: ctx.timestamp,
      metric: ['CLS'],
      type: 'bottleneck',
      cause: `<img${src ? ` src="${src}"` : ''}> has no explicit width/height — CANDIDATE CLS source (static guess; confirm at runtime).`,
      recommendation: `If this image is visible at/above the fold, add explicit \`width\`/\`height\` (or \`aspect-ratio\`) to reserve its box. Confirm it actually shifts with a scroll-aware runtime capture (\`launcher.js --scroll\`) before treating it as the CLS root cause — static HTML can't tell whether this element is visible, sized by CSS, or shifts at all.`,
      evidence: [
        {
          kind: 'rule-violation',
          data: {
            ruleId: 'html/img-missing-dimensions',
            match: img.raw.slice(0, 300),
            context: { tag: 'img', attrs: img.attrs, aboveFoldProxy: true },
          },
        },
      ],
      impactReduction: { metric: 'CLS', score: 0.05 },
      // G3 — static element guess: a HYPOTHESIS to confirm at runtime, never a
      // confirmed root cause. The runtime CLS analyzer (perf_observer shift
      // sources, chain-rum-correlator C6) is authoritative and is the only path
      // that may set rootCause:true for a CLS element.
      rootCause: false,
      confidence: 0.5,
      // No runtime patch: the mutate-markup applier only sets attributes, and
      // injecting intrinsic width/height requires knowing the image's natural
      // dimensions (not known from HTML alone). The `recommendation` carries
      // the actionable guidance; source-mapping is handled by the fix skill.
      patches: undefined,
    }));
  }
  return findings;
}

/**
 * H3 — First "large" <img> in markup missing fetchpriority="high".
 * Heuristic: first <img> (in either body or head-level preload-less position)
 * with a src that isn't obviously a sprite/icon.
 */
function checkLcpCandidateFetchPriority(body, ctx) {
  const findings = [];
  if (!body) return findings;
  // Use a broad slice — LCP candidate is usually within the first ~30KB.
  const slice = body.inner.slice(0, 30 * 1024);
  const imgs = findTags(slice, 'img');
  for (const img of imgs) {
    const src = img.attrs.src;
    if (!src) continue;
    // Skip icons / sprites / tiny explicit dims.
    if (/sprite|icon|pixel|blank|1x1/i.test(src)) continue;
    const w = parseInt(img.attrs.width, 10);
    const h = parseInt(img.attrs.height, 10);
    if (!Number.isNaN(w) && !Number.isNaN(h) && w < 100 && h < 100) continue;
    // Candidate found.
    const fp = (img.attrs.fetchpriority || '').toLowerCase();
    if (fp === 'high') return findings; // already optimal
    const abs = absolutize(src, ctx.url);
    findings.push(makeFinding({
      url: ctx.url,
      timestamp: ctx.timestamp,
      metric: ['LCP'],
      type: 'opportunity',
      cause: `Likely LCP <img src="${src}"> has no fetchpriority="high"; browser may discover it late.`,
      recommendation: `Add \`fetchpriority="high"\` to the LCP image, OR add \`<link rel="preload" as="image" href="${src}" fetchpriority="high">\` in <head>.`,
      evidence: [
        {
          kind: 'rule-violation',
          data: {
            ruleId: 'html/lcp-candidate-missing-fetchpriority',
            match: img.raw.slice(0, 300),
            context: { tag: 'img', attrs: img.attrs },
          },
        },
        { kind: 'resource-timing', data: { url: abs, type: 'img' } },
      ],
      impactReduction: { metric: 'LCP', valueMs: 200 },
      rootCause: false,
      confidence: 0.6,
      patches: {
        markup: [{ selector: `img[src="${cssEscapeAttrValue(src)}"]`, attrs: { fetchpriority: 'high' } }],
        preloads: [{ href: src, as: 'image', fetchpriority: 'high' }],
      },
    }));
    return findings; // only emit for the first candidate
  }
  return findings;
}

/**
 * H4 — Missing <meta name="viewport">.
 */
function checkViewportMeta(head, ctx) {
  const metas = findTags(head.inner, 'meta');
  const hasViewport = metas.some((m) => (m.attrs.name || '').toLowerCase() === 'viewport');
  if (hasViewport) return [];
  return [makeFinding({
    url: ctx.url,
    timestamp: ctx.timestamp,
    metric: ['CLS', 'LCP'],
    type: 'bottleneck',
    cause: 'No `<meta name="viewport">` — mobile viewport defaults to desktop width and scales, causing layout reflow and poor LCP/CLS on mobile.',
    recommendation: 'Add `<meta name="viewport" content="width=device-width, initial-scale=1">` as early as possible in <head>.',
    evidence: [
      {
        kind: 'rule-violation',
        data: {
          ruleId: 'html/missing-viewport-meta',
          match: '<head>…</head>',
          context: { location: 'head', metaCount: metas.length },
        },
      },
    ],
    impactReduction: { metric: 'LCP', valueMs: 300 },
    rootCause: true,
    severityOverride: 'medium',
    confidence: 0.75,
    // No runtime patch: injecting a <meta> tag is outside the attribute-setter
    // capability of mutate-markup.js. Surface via `recommendation` only.
    patches: undefined,
  })];
}

/**
 * H5 — First render-blocking external stylesheet without a matching preload hint.
 * Emits ONE finding (for the first external stylesheet, not all).
 */
function checkStylesheetPreloadOpportunity(head, ctx) {
  const links = findTags(head.inner, 'link');
  // First external stylesheet (rel includes "stylesheet").
  const stylesheets = links.filter((l) => {
    const rel = (l.attrs.rel || '').toLowerCase();
    return rel.split(/\s+/).includes('stylesheet') && !!l.attrs.href;
  });
  if (stylesheets.length === 0) return [];
  const first = stylesheets[0];
  const href = first.attrs.href;
  const abs = absolutize(href, ctx.url);
  // Has a preload link for this href?
  const hasPreload = links.some((l) => {
    const rel = (l.attrs.rel || '').toLowerCase();
    return rel === 'preload'
      && (l.attrs.as || '').toLowerCase() === 'style'
      && absolutize(l.attrs.href, ctx.url) === abs;
  });
  if (hasPreload) return [];
  return [makeFinding({
    url: ctx.url,
    timestamp: ctx.timestamp,
    metric: ['LCP', 'FCP'],
    type: 'opportunity',
    cause: `First render-blocking stylesheet "${href}" has no preload hint; inlining critical CSS or preloading can shave early discovery time.`,
    recommendation: `Either inline the critical subset of "${href}" into <head>, or add \`<link rel="preload" as="style" href="${href}">\` before the <link rel=stylesheet>.`,
    evidence: [
      {
        kind: 'rule-violation',
        data: {
          ruleId: 'html/stylesheet-not-preloaded',
          match: first.raw.slice(0, 300),
          context: { tag: 'link', attrs: first.attrs },
        },
      },
      { kind: 'resource-timing', data: { url: abs, type: 'css' } },
    ],
    impactReduction: { metric: 'LCP', valueMs: 200 },
    rootCause: false,
    confidence: 0.55,
    patches: {
      preloads: [{ href, as: 'style' }],
    },
  })];
}

/**
 * H6 — Inline <script> block >5KB in <head>.
 */
function checkInlineScriptSize(head, ctx) {
  const findings = [];
  const inlines = findInlineScripts(head.inner);
  for (const s of inlines) {
    const bytes = Buffer.byteLength(s.body, 'utf8');
    if (bytes <= 5 * 1024) continue;
    findings.push(makeFinding({
      url: ctx.url,
      timestamp: ctx.timestamp,
      metric: ['FCP', 'LCP'],
      type: 'waste',
      cause: `Inline <script> in <head> is ${bytes} bytes — parse+compile cost blocks FCP.`,
      recommendation: 'Move large inline scripts to an external file with `defer`, or trim the inline payload to the minimum bootstrap.',
      evidence: [
        {
          kind: 'rule-violation',
          data: {
            ruleId: 'html/large-inline-script-in-head',
            match: `${s.body.slice(0, 120)}…`,
            context: { bytes, attrs: s.attrs, location: 'head' },
          },
        },
      ],
      impactReduction: { metric: 'FCP', valueMs: 200 },
      rootCause: false,
      confidence: 0.6,
    }));
  }
  return findings;
}

/**
 * H7 — Favicon link appears before the first stylesheet.
 */
function checkFaviconOrdering(head, ctx) {
  const links = findTags(head.inner, 'link');
  let iconIdx = -1;
  let cssIdx = -1;
  for (let i = 0; i < links.length; i += 1) {
    const rel = (links[i].attrs.rel || '').toLowerCase();
    if (iconIdx < 0 && /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel)) iconIdx = i;
    if (cssIdx < 0 && rel.split(/\s+/).includes('stylesheet')) cssIdx = i;
  }
  if (iconIdx < 0 || cssIdx < 0 || iconIdx >= cssIdx) return [];
  const iconRaw = links[iconIdx].raw;
  return [makeFinding({
    url: ctx.url,
    timestamp: ctx.timestamp,
    metric: ['LCP', 'FCP'],
    type: 'opportunity',
    cause: 'Favicon link appears before the first stylesheet — low-priority icon gets an early slot in the resource discovery queue.',
    recommendation: 'Move `<link rel="icon">` below the critical stylesheet so the browser discovers render-blocking CSS first.',
    evidence: [
      {
        kind: 'rule-violation',
        data: {
          ruleId: 'html/favicon-before-stylesheet',
          match: iconRaw.slice(0, 300),
          context: { faviconIndex: iconIdx, firstStylesheetIndex: cssIdx },
        },
      },
    ],
    impactReduction: { metric: 'LCP', valueMs: 150 },
    rootCause: false,
    severityOverride: 'low',
    confidence: 0.5,
  })];
}

/**
 * H8 — Preconnect / dns-prefetch to DEFERRABLE-tier third parties.
 */
function checkPreconnectToDeferrable(head, ctx) {
  const findings = [];
  const links = findTags(head.inner, 'link');
  for (const link of links) {
    const rel = (link.attrs.rel || '').toLowerCase().trim();
    if (rel !== 'preconnect' && rel !== 'dns-prefetch') continue;
    const href = link.attrs.href;
    if (!href) continue;
    const host = safeHost(absolutize(href, ctx.url));
    if (!isDeferrableHost(host)) continue;
    findings.push(makeFinding({
      url: ctx.url,
      timestamp: ctx.timestamp,
      metric: ['LCP'],
      type: 'waste',
      cause: `<link rel="${rel}" href="${href}"> subsidizes a DEFERRABLE chain (${host}) — steals connection slots from LCP-critical origins.`,
      recommendation: `Remove the ${rel} hint for ${host}. Analytics/monitoring/consent domains must load after LCP. See topics/martech.md (DEFERRABLE tier).`,
      evidence: [
        {
          kind: 'rule-violation',
          data: {
            ruleId: 'html/preconnect-to-deferrable',
            match: link.raw.slice(0, 300),
            context: { rel, host, href },
          },
        },
      ],
      impactReduction: { metric: 'LCP', valueMs: 200 },
      rootCause: false,
      confidence: 0.65,
      // Remove-element is not supported by mutate-markup.js (which only sets
      // attributes). Neutralise the hint by blanking rel/as attributes instead —
      // an invalid rel makes the browser ignore the link.
      patches: {
        markup: [{ selector: `link[rel="${cssEscapeAttrValue(rel)}"][href="${cssEscapeAttrValue(href)}"]`, attrs: { rel: null, as: null } }],
      },
    }));
  }
  return findings;
}

/**
 * H9 — Inline SVG payload in early body markup.
 */
function checkInlineSvgPayload(body, ctx) {
  const earlyBodyLimit = 30 * 1024;
  const svgs = findInlineSvgs(body.inner).filter((svg) => svg.index < earlyBodyLimit);
  if (svgs.length === 0) return [];

  const totalBytes = svgs.reduce((sum, svg) => sum + Buffer.byteLength(svg.raw, 'utf8'), 0);
  const largest = svgs.slice().sort((a, b) => Buffer.byteLength(b.raw, 'utf8') - Buffer.byteLength(a.raw, 'utf8'))[0];
  const largestBytes = Buffer.byteLength(largest.raw, 'utf8');

  // Tiny inline icons are often a reasonable authoring choice. Flag payloads
  // large enough to plausibly affect document transfer and parser/main-thread
  // work before first paint.
  if (largestBytes < 2 * 1024 && totalBytes < 6 * 1024) return [];

  return [makeFinding({
    url: ctx.url,
    timestamp: ctx.timestamp,
    metric: ['FCP', 'LCP', 'TBT'],
    type: 'waste',
    cause: `Inline SVG payload in early <body> markup totals ${totalBytes} bytes and must be transferred and parsed with the main document before first paint.`,
    recommendation: 'Externalize large decorative or reusable SVGs to cacheable assets and reference them with `<img src="...svg" loading="lazy">` when they are not part of the LCP. Keep only tiny semantic icons inline when the styling/accessibility tradeoff justifies it.',
    evidence: [
      {
        kind: 'rule-violation',
        data: {
          ruleId: 'html/inline-svg-in-body',
          match: largest.raw.slice(0, 300),
          context: {
            tag: 'svg',
            count: svgs.length,
            totalBytes,
            largestBytes,
            aboveFoldProxy: true,
            attrs: largest.attrs,
          },
        },
      },
    ],
    impactReduction: { metric: 'FCP', valueMs: 150 },
    rootCause: false,
    confidence: 0.55,
  })];
}

// --------------------------------------------------------------------------
// H10 — AEM EDS structural contract failure.
// --------------------------------------------------------------------------

const EDS_PLACEHOLDER_CLASSES = new Set([
  'css-block',
  'metadata',
  'section-metadata',
  'spacer',
  'spacer-and-divider',
  'transparent-block',
]);

function classList(attrs) {
  return String((attrs && attrs.class) || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function detectEdsStack(html, sectionCount = 0) {
  const signals = [];
  if (/\/(?:eds\/)?scripts\/scripts\.js(?:[?#"'])/i.test(html)) signals.push('scripts.js');
  if (/\/blocks\/[^"')\s]+/i.test(html)) signals.push('/blocks/');
  if (/\bdata-block-name\s*=/i.test(html)) signals.push('data-block-name');
  if (/\bdata-section-status\s*=/i.test(html)) signals.push('data-section-status');
  if (/main\s*>\s*div|\bclass=["'][^"']*\bsection\b/i.test(html)) signals.push('section-markup');
  return {
    eds: signals.includes('scripts.js') && (signals.length > 1 || sectionCount > 0),
    signals,
  };
}

function classifyEdsSection(section, index) {
  const classes = classList(section.attrs);
  const classSet = new Set(classes);
  const text = stripTags(section.inner);
  const textLength = text.length;
  const hasMedia = /<(picture|img|video)\b/i.test(section.inner);
  const hasHeading = /<h[1-3]\b/i.test(section.inner);
  const placeholder = classes.some((cls) => EDS_PLACEHOLDER_CLASSES.has(cls));
  const tabShell = classSet.has('tabs') || /\btabs?\b/i.test(classes.join(' '));
  const kind = placeholder ? 'placeholder' : tabShell ? 'tab-shell' : 'content';
  const meaningful = !placeholder && !tabShell && (hasHeading || hasMedia || textLength >= 80);
  return {
    index: index + 1,
    classes,
    id: section.attrs.id || null,
    kind,
    placeholder,
    tabShell,
    meaningful,
    textLength,
    hasMedia,
    hasHeading,
    text: text.slice(0, 160),
  };
}

function revealRuleSignals(rawHtml) {
  const lower = String(rawHtml || '').toLowerCase();
  const removalLanguage = /\b(?:remov(?:e|ed|ing)|delet(?:e|ed|ing)|disabl(?:e|ed|ing)|comment(?:ed)?\s+out|bypass(?:ed|ing)?|drop(?:ped|ping)?)\b/i;
  const gatingTarget = /body:not\(\.appear\)|section\.style\.display|section hiding|reveal gating|prevent fouc/i;
  const removeGatingComment = String(rawHtml || '')
    .split(/\r?\n/)
    .some((line) => removalLanguage.test(line) && gatingTarget.test(line));
  return {
    bodyNotAppearMainHidden: /body:not\(\.appear\)\s+main\s*\{[^}]*display\s*:\s*none/i.test(rawHtml),
    bodyNotAppearHiddenAny: /body:not\(\.appear\)[^{]*\{[^}]*display\s*:\s*none/i.test(rawHtml),
    viewblockDisplayBlock: /section-block___viewblock[^{]*\{[^}]*display\s*:\s*block\s*!important/i.test(rawHtml),
    bodyAppearDisplayBlock: /body\.appear\s+main[^{]*\{[^}]*display\s*:\s*block/i.test(rawHtml),
    removeGatingComment,
    gatingCommentText: removeGatingComment ? lower.match(/[^.\n]*(?:body:not\(\.appear\)|section\.style\.display|section hiding|reveal gating|prevent fouc)[^.\n]*/i)?.[0]?.trim() || null : null,
  };
}

function headerOverlaySignals(rawHtml) {
  const headerTag = String(rawHtml || '').match(/<header\b([^>]*)>/i);
  const headerAttrs = headerTag ? parseAttrs(headerTag[1] || '') : {};
  const headerClasses = classList(headerAttrs);
  const inlineStyle = headerAttrs.style || '';
  const styles = findInlineStyles(rawHtml).map((style) => style.body).join('\n');
  const headerRuleRe = /(?:^|[}\n])\s*(?:header|\.header|#header|\.header-wrapper|\.nav-wrapper|\.navigation-wrapper|\.site-header|\.global-header)\b[^{]*\{[^}]*position\s*:\s*(fixed|absolute|sticky)\b/gi;
  const headerRulePositions = [];
  let m;
  while ((m = headerRuleRe.exec(styles)) !== null) {
    headerRulePositions.push(m[1].toLowerCase());
  }
  const inlinePosition = (inlineStyle.match(/(?:^|;)\s*position\s*:\s*(fixed|absolute|sticky)\b/i) || [])[1] || null;
  const classPosition = headerClasses.find((cls) => /\b(?:fixed|absolute|sticky|floating|overlay)\b/i.test(cls)) || null;
  const zIndexHint = /(?:header|\.header|#header|\.header-wrapper|\.nav-wrapper|\.site-header)[^{]*\{[^}]*z-index\s*:\s*(?:[1-9]\d{2,}|var\()/i.test(styles)
    || /(?:^|;)\s*z-index\s*:\s*(?:[1-9]\d{2,}|var\()/i.test(inlineStyle);
  const mainOffsetCompensation = /(?:main|\.main)\b[^{]*\{[^}]*(?:padding-top|margin-top)\s*:\s*(?:0|-[\d.]+|var\(--header|calc\()/i.test(styles);
  const positions = [
    ...(inlinePosition ? [inlinePosition.toLowerCase()] : []),
    ...headerRulePositions,
    ...(classPosition ? [`class:${classPosition}`] : []),
  ];
  return {
    headerPresent: !!headerTag,
    classes: headerClasses,
    inlinePosition: inlinePosition ? inlinePosition.toLowerCase() : null,
    cssPositions: Array.from(new Set(headerRulePositions)),
    classPosition,
    zIndexHint,
    mainOffsetCompensation,
    overlayLikely: positions.length > 0,
  };
}

function analyzeEdsStructure(rawHtml, ctx) {
  const cleaned = stripComments(rawHtml);
  const main = extractMain(cleaned);
  const sections = main ? findTopLevelDivs(main.inner).map(classifyEdsSection) : [];
  const stack = detectEdsStack(cleaned, sections.length);
  const signals = revealRuleSignals(rawHtml);
  const headerSignals = headerOverlaySignals(rawHtml);
  const firstMeaningful = sections.find((section) => section.meaningful) || null;
  const beforeMeaningful = firstMeaningful
    ? sections.filter((section) => section.index < firstMeaningful.index)
    : sections;
  const placeholderBeforeMeaningful = beforeMeaningful.filter((section) => section.placeholder).length;
  const spacerBeforeMeaningful = beforeMeaningful.filter((section) => (
    section.classes.some((cls) => cls === 'spacer' || cls === 'spacer-and-divider')
  )).length;
  const tabShellBeforeMeaningful = beforeMeaningful.filter((section) => section.tabShell).length;
  const reasons = [];

  if (!stack.eds) {
    return {
      stack,
      gate: { name: 'eds-structural-contract', result: 'not-run', reasons: [] },
      sections,
      finding: null,
    };
  }

  if (!firstMeaningful) {
    reasons.push('No meaningful top-level EDS section was found in <main>.');
  } else if (firstMeaningful.index > 3) {
    reasons.push(`First meaningful section is section ${firstMeaningful.index}, after placeholder or shell sections.`);
  }
  if (placeholderBeforeMeaningful >= 3) {
    reasons.push(`${placeholderBeforeMeaningful} placeholder/spacer sections appear before the first meaningful section.`);
  }
  if (spacerBeforeMeaningful >= 2) {
    reasons.push(`${spacerBeforeMeaningful} spacer sections appear before meaningful content.`);
  }
  if (tabShellBeforeMeaningful > 0 && firstMeaningful && firstMeaningful.index > 3) {
    reasons.push('A tab-shell section appears before the first meaningful/LCP-like section.');
  }
  if (signals.viewblockDisplayBlock) {
    reasons.push('Source-visible CSS forces section-block___viewblock sections to display:block, which can bypass EDS reveal gating.');
  }
  if (signals.bodyAppearDisplayBlock && !signals.bodyNotAppearMainHidden) {
    reasons.push('Inline/source CSS shows body.appear display rules without a matching body:not(.appear) main display:none gate.');
  }
  if (signals.removeGatingComment) {
    reasons.push('Source comments mention removing EDS body or section hiding to prevent FOUC.');
  }
  if (headerSignals.overlayLikely && (
    placeholderBeforeMeaningful > 0
    || spacerBeforeMeaningful > 0
    || (firstMeaningful && firstMeaningful.index > 1)
    || headerSignals.mainOffsetCompensation
  )) {
    reasons.push('Header HTML/CSS suggests a floating overlay while content is offset by placeholder/spacer sections instead of normal document flow.');
  }

  const result = reasons.length > 0 ? 'fail' : 'pass';
  const gate = {
    name: 'eds-structural-contract',
    result,
    reasons,
    sectionCount: sections.length,
    headerOverlayHints: headerSignals,
  };
  if (firstMeaningful) {
    gate.firstMeaningfulSection = {
      index: firstMeaningful.index,
      id: firstMeaningful.id,
      classes: firstMeaningful.classes,
      text: firstMeaningful.text,
    };
  }

  if (result === 'pass') {
    return { stack, gate, sections, finding: null };
  }

  const context = {
    gateResult: result,
    reasons,
    stackSignals: stack.signals,
    sectionCount: sections.length,
    firstMeaningfulSection: gate.firstMeaningfulSection || null,
    placeholderSectionsBeforeMeaningful: placeholderBeforeMeaningful,
    spacerSectionsBeforeMeaningful: spacerBeforeMeaningful,
    tabShellSectionsBeforeMeaningful: tabShellBeforeMeaningful,
    revealRuleSignals: signals,
    headerOverlayHints: headerSignals,
    sections: sections.slice(0, 10).map((section) => ({
      index: section.index,
      id: section.id,
      classes: section.classes,
      kind: section.kind,
      meaningful: section.meaningful,
      textLength: section.textLength,
      hasMedia: section.hasMedia,
      text: section.text,
    })),
  };

  const finding = makeFinding({
    url: ctx.url,
    timestamp: ctx.timestamp,
    metric: ['CLS', 'LCP'],
    type: 'bottleneck',
    cause: 'AEM EDS reveal/page-shape contract appears broken: meaningful content is delayed behind placeholder sections or reveal gating is bypassed.',
    recommendation: 'Restore the EDS structural contract before promoting selector-level fixes: reveal main/sections only after eager content is ready, make the first meaningful/LCP section eager, keep header/content in normal flow, and remove spacer/transparent sections used as layout padding.',
    evidence: [
      {
        kind: 'rule-violation',
        data: {
          ruleId: 'html/eds-structural-contract',
          match: main ? main.inner.slice(0, 600) : '<main> not found',
          context,
        },
      },
    ],
    impactReduction: { metric: 'CLS', score: 0.1 },
    rootCause: true,
    severityOverride: 'high',
    confidence: 0.7,
  });
  finding.structuralGate = gate;
  return { stack, gate, sections, finding };
}

// --------------------------------------------------------------------------
// Orchestrator.
// --------------------------------------------------------------------------

/**
 * Analyze raw HTML. If given a URL, fetches it; if given markup, uses it directly.
 *
 * @param {string} urlOrHtml  Either an http(s) URL to fetch, or a raw HTML string.
 * @param {{ url?: string, timestamp?: string, fromString?: boolean }} [opts]
 *   fromString: force treating urlOrHtml as HTML content (default: autodetect).
 * @returns {Promise<{findings: object[], summary: string, meta: object}>}
 */
async function analyzeHtml(urlOrHtml, opts = {}) {
  resetIds();
  const timestamp = opts.timestamp || new Date().toISOString();

  let html;
  let fetchedFrom = null;
  let contentLength = null;
  let responseHeaders = null;
  let resolvedUrl = opts.url || null;

  const looksLikeUrl = !opts.fromString
    && typeof urlOrHtml === 'string'
    && /^https?:\/\//i.test(urlOrHtml.trim());

  if (looksLikeUrl) {
    fetchedFrom = urlOrHtml;
    resolvedUrl = resolvedUrl || urlOrHtml;
    const res = await fetch(urlOrHtml, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'cwv-agent/html-parse' },
    });
    if (!res.ok && res.status >= 400) {
      throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
    }
    html = await res.text();
    contentLength = Buffer.byteLength(html, 'utf8');
    responseHeaders = Object.fromEntries(res.headers.entries());
  } else {
    html = String(urlOrHtml);
    contentLength = Buffer.byteLength(html, 'utf8');
    if (!resolvedUrl) resolvedUrl = 'https://example.invalid/';
  }

  const ctx = { url: resolvedUrl, timestamp };
  const cleaned = stripComments(html);
  const head = extractHead(cleaned);
  const body = extractBody(cleaned);
  const edsStructure = analyzeEdsStructure(html, ctx);

  const findings = [];
  if (head) {
    findings.push(...checkRenderBlockingScripts(head, ctx));
    findings.push(...checkViewportMeta(head, ctx));
    findings.push(...checkStylesheetPreloadOpportunity(head, ctx));
    findings.push(...checkInlineScriptSize(head, ctx));
    findings.push(...checkFaviconOrdering(head, ctx));
    findings.push(...checkPreconnectToDeferrable(head, ctx));
  }
  if (body) {
    findings.push(...checkMissingImgDimensions(body, ctx));
    findings.push(...checkLcpCandidateFetchPriority(body, ctx));
    findings.push(...checkInlineSvgPayload(body, ctx));
  }
  if (edsStructure.finding) {
    findings.push(edsStructure.finding);
  }

  // Validate every finding; drop invalid ones with a warning on stderr (CLI safety).
  const validated = [];
  for (const f of findings) {
    const res = validateFinding(f);
    if (res.valid) {
      validated.push(f);
    } else {
      process.stderr.write(`html-parse: dropping invalid finding ${f.id}: ${res.errors.join('; ')}\n`);
    }
  }

  const summary = [
    `Analyzed ${resolvedUrl} (${contentLength} bytes)`,
    `head=${head ? 'found' : 'missing'} body=${body ? 'found' : 'missing'}`,
    `findings=${validated.length}`,
  ].join(' · ');

  return {
    findings: validated,
    summary,
    meta: {
      fetchedFrom,
      contentLength,
      responseHeaders,
      stack: edsStructure.stack,
      structuralGate: edsStructure.gate,
    },
  };
}

// --------------------------------------------------------------------------
// CLI.
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url' || a === '--html' || a === '--output') {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node html-parse.js --url <URL> [--output <path>]',
    '  node html-parse.js --html <path-to-html-file> [--url <URL>] [--output <path>]',
    '',
    'Emits a Finding envelope (schemaVersion 1.0) to stdout, or to --output.',
    '',
  ].join('\n'));
}

function buildErrorEnvelope(args, err) {
  const url = args.url || (args.html ? `file:${path.resolve(args.html)}` : 'https://example.invalid/');
  const message = err && err.message ? err.message : String(err);
  return {
    schemaVersion: SCHEMA_VERSION,
    skill: SKILL,
    url,
    timestamp: new Date().toISOString(),
    findings: [],
    summary: `html-parse failed for ${url}: ${message}`,
    meta: {
      fetchedFrom: args.url || null,
      htmlInput: args.html || null,
      error: {
        name: err && err.name ? err.name : 'Error',
        message,
      },
    },
  };
}

function writeJsonOutput(outputPath, payload) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, payload);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.url && !args.html)) {
    printUsage();
    process.exit(args.help ? 0 : 2);
  }

  let result;
  if (args.html) {
    const abs = path.resolve(args.html);
    const html = fs.readFileSync(abs, 'utf8');
    result = await analyzeHtml(html, { url: args.url, fromString: true });
  } else {
    result = await analyzeHtml(args.url);
  }

  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    skill: SKILL,
    url: args.url || (result.meta.fetchedFrom || 'https://example.invalid/'),
    timestamp: new Date().toISOString(),
    findings: result.findings,
    summary: result.summary,
    meta: result.meta,
  };

  const out = JSON.stringify(envelope, null, 2);
  if (args.output) {
    writeJsonOutput(args.output, out);
    process.stderr.write(`${result.summary}\nwrote ${args.output}\n`);
  } else {
    process.stdout.write(`${out}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const args = parseArgs(process.argv.slice(2));
    if (args.output) {
      const envelope = buildErrorEnvelope(args, err);
      try {
        writeJsonOutput(args.output, JSON.stringify(envelope, null, 2));
        process.stderr.write(`${envelope.summary}\nwrote ${args.output}\n`);
      } catch (writeErr) {
        process.stderr.write(`html-parse error: ${err.message}\n`);
        process.stderr.write(`html-parse output error: ${writeErr.message}\n`);
      }
    } else {
      process.stderr.write(`html-parse error: ${err.message}\n`);
    }
    process.exit(1);
  });
}

// Exposed for tests.
const _internal = {
  parseAttrs,
  findTags,
  findInlineScripts,
  findInlineStyles,
  findInlineSvgs,
  findTopLevelDivs,
  extractHead,
  extractBody,
  extractMain,
  stripComments,
  stripTags,
  isDeferrableHost,
  decodeHtmlEntities,
  cssEscapeAttrValue,
  analyzeEdsStructure,
  headerOverlaySignals,
  buildErrorEnvelope,
};

export {
  analyzeHtml,
  _internal,
};
