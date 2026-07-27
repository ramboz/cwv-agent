#!/usr/bin/env node

/**
 * Ownership attribution + playbook-guided diagnosis.
 *
 * Answers the question "is it the platform, your code, or a third party?" by
 * tagging every Finding with an `owner`:
 *
 *   platform-default · cdn-edge · customer-code · customer-content · third-party
 *
 * The classification is derived from three sources, in this order of strength:
 *   1. The CWV playbook for the finding's issue type — its optional
 *      `applicable_stacks` front-matter is a platform-vs-site signal: a type
 *      whose playbook EXCLUDES the detected stack is platform-managed / N/A
 *      on that stack. (Absent front matter = applies everywhere.)
 *   2. The stack docs (.agents/references/stacks/, when a stack pack is
 *      installed) — who owns each layer (CDN/edge vs application code).
 *   3. Response headers + the finding's own evidence (third-party resource
 *      domains, cache HIT/MISS, the shifting selector).
 *
 * Pure helpers + a thin CLI (require.main guard). Diagnostics → stderr,
 * JSON → stdout. Zero runtime deps.
 *
 * Canonical references:
 *   .agents/references/playbooks/_FORMAT.md  (playbook front-matter schema)
 *   .agents/references/topics/finding-schema.md  (owner/ownership fields)
 *
 * Usage (module):
 *   import * as a from './attribution.js';
 *   const out = a.attributeFinding(finding, { flavor: 'generic' });
 *   // out.owner === 'customer-code'
 *
 * CLI:
 *   node attribution.js findings.json [--headers h.json] [--output o.json]
 *   node attribution.js --explain CLS   # which playbooks apply
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const OWNERS = [
  'platform-default',   // the hosting platform's own behaviour/defaults (operator-managed)
  'cdn-edge',           // caching / edge layer (CDN config, response headers)
  'customer-code',      // the site's own application code: templates, CSS, JS
  'customer-content',   // authored values: assets, CMS config, content positioning
  'third-party',        // external vendor scripts: analytics, tag managers, A/B, chat, CMP, ads
];

// Candidate playbook issue_types per CWV metric, most-likely first.
const METRIC_ISSUE_TYPES = {
  CLS: ['layout-shift', 'image-sizing', 'font-fallback'],
  LCP: ['lcp-image', 'resource-preload', 'resource-hints', 'request-chain', 'blocking-resource', 'ttfb'],
  INP: ['interaction', 'js-execution', 'third-party'],
  TBT: ['js-execution', 'third-party', 'bundling'],
  TTFB: ['ttfb', 'compression'],
  FCP: ['blocking-resource', 'inline-css', 'font-preload'],
  SI: ['blocking-resource', 'lcp-image'],
};

// Third-party vendor domains. A resource on one of these is owned by a vendor,
// not the customer (the customer chose to embed it, but the bytes/behaviour are
// the vendor's). A *first-party* selector with no such resource is NOT third
// party — e.g. a site's own custom consent banner component.
const THIRD_PARTY_DOMAIN_PATTERNS = [
  // Analytics / measurement
  /(^|\.)google-analytics\.com$/i,
  /(^|\.)googletagmanager\.com$/i,
  /(^|\.)segment\.(com|io)$/i,
  /(^|\.)mixpanel\.com$/i,
  /(^|\.)amplitude\.com$/i,
  /(^|\.)hotjar\.com$/i,
  /(^|\.)clarity\.ms$/i,
  /(^|\.)fullstory\.com$/i,
  /(^|\.)contentsquare\.net$/i,
  /(^|\.)heapanalytics\.com$/i,
  /(^|\.)mxpnl\.com$/i,
  /(^|\.)comscore\.com$/i,
  /(^|\.)scorecardresearch\.com$/i,
  /(^|\.)nielsen\.com$/i,
  // Adobe martech (Launch / DTM / Audience Manager / Analytics edge)
  /(^|\.)adobedtm\.com$/i,
  /(^|\.)omtrdc\.net$/i,
  /(^|\.)demdex\.net$/i,
  /(^|\.)2o7\.net$/i,
  // Consent / CMP
  /(^|\.)onetrust\.com$/i,
  /(^|\.)cookielaw\.org$/i,
  /(^|\.)cookiebot\.com$/i,
  /(^|\.)trustarc\.com$/i,
  /(^|\.)usercentrics\.(eu|com)$/i,
  /(^|\.)osano\.com$/i,
  /(^|\.)quantserve\.com$/i,
  // Ads
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)googlesyndication\.com$/i,
  /(^|\.)googleadservices\.com$/i,
  /(^|\.)2mdn\.net$/i,
  /(^|\.)adnxs\.com$/i,
  /(^|\.)amazon-adsystem\.com$/i,
  /(^|\.)criteo\.(com|net)$/i,
  /(^|\.)taboola\.com$/i,
  /(^|\.)outbrain\.com$/i,
  /(^|\.)rubiconproject\.com$/i,
  /(^|\.)pubmatic\.com$/i,
  /(^|\.)openx\.net$/i,
  // Social
  /(^|\.)facebook\.(com|net)$/i,
  /(^|\.)connect\.facebook\.net$/i,
  /(^|\.)platform\.twitter\.com$/i,
  /(^|\.)licdn\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)pinterest\.com$/i,
  /(^|\.)tiktok\.com$/i,
  // Monitoring
  /(^|\.)sentry\.io$/i,
  /(^|\.)datadoghq\.com$/i,
  /(^|\.)newrelic\.com$/i,
  /(^|\.)nr-data\.net$/i,
  /(^|\.)rollbar\.com$/i,
  /(^|\.)bugsnag\.com$/i,
  // Chat
  /(^|\.)intercom\.io$/i,
  /(^|\.)drift\.com$/i,
  /(^|\.)zendesk\.com$/i,
  /(^|\.)tawk\.to$/i,
  /(^|\.)livechatinc\.com$/i,
  // A/B testing
  /(^|\.)optimizely\.com$/i,
  /(^|\.)vwo\.com$/i,
  /(^|\.)abtasty\.com$/i,
  /(^|\.)launchdarkly\.com$/i,
  /(^|\.)split\.io$/i,
  /(^|\.)monetate\.net$/i,
  /(^|\.)dynamicyield\.com$/i,
  // Embedded Google / Firebase infra
  /(^|\.)gstatic\.com$/i,
  /(^|\.)firebaseio\.com$/i,
  /(^|\.)firebaseapp\.com$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)ytimg\.com$/i,
  // Third-party fonts / icons loaded as render-blocking resources
  /(^|\.)use\.typekit\.net$/i,
  /(^|\.)p\.typekit\.net$/i,
  /(^|\.)fonts\.googleapis\.com$/i,
  /(^|\.)use\.fontawesome\.com$/i,
];

// Tag-manager markers — third-party but the fix is "change the tag-manager
// rule", not "edit markup" (per third-party.md). Surfaced as a deliveryConstraint.
const TAG_MANAGER_PATTERNS = [
  /(^|\.)googletagmanager\.com$/i,
  /(^|\.)adobedtm\.com$/i,
  /(^|\.)assets\.adobedtm\.com$/i,
];
const TAG_MANAGER_URL_RE = /(?:gtm\.js|launch-[a-z0-9]+(?:\.min)?\.js)/i;

// ---------------------------------------------------------------------------
// Stack normalization — pluggable stack names, `generic` built in
// ---------------------------------------------------------------------------

/**
 * Normalize a stack label. Any non-empty name passes through lower-cased so a
 * stack pack can introduce its own vocabulary; empty/absent input is null.
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeFlavor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return s || null;
}

/**
 * Resolve the effective stack for a run: an explicit label wins; otherwise
 * null (playbook applicability filters no-op on null).
 * @param {{flavor?: string|null}} args
 * @returns {string|null}
 */
function resolveFlavor(args = {}) {
  return normalizeFlavor(args.flavor);
}

// ---------------------------------------------------------------------------
// Playbook front-matter parser (focused YAML subset — see playbooks/_FORMAT.md)
// ---------------------------------------------------------------------------

const KEY_RE = /^([A-Za-z0-9_][\w-]*):(?:\s+(.*))?$/;

/** Strip a trailing `# comment` that is not inside single/double quotes. */
function stripComment(line) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(s) {
  const t = String(s).trim();
  if (t.length >= 2 && ((t[0] === "'" && t[t.length - 1] === "'") || (t[0] === '"' && t[t.length - 1] === '"'))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineList(s) {
  const inner = s.trim().slice(1, -1).trim(); // drop [ ]
  if (!inner) return [];
  return inner.split(',').map((x) => unquote(x)).filter((x) => x !== '');
}

function scalarOrList(rest) {
  const t = rest.trim();
  if (t.startsWith('[')) return parseInlineList(t);
  return unquote(t);
}

/** Tokenize YAML text into [{ indent, text }], dropping blank / comment-only lines. */
function tokenizeYaml(yaml) {
  const out = [];
  for (const rawLine of yaml.split('\n')) {
    const noComment = stripComment(rawLine);
    if (!noComment.trim()) continue;
    const indent = (noComment.match(/^(\s*)/)[1] || '').length;
    out.push({ indent, text: noComment.trim() });
  }
  return out;
}

function parseNode(lines, i, indent) {
  if (i >= lines.length) return { value: null, next: i };
  if (lines[i].text.startsWith('- ') || lines[i].text === '-') return parseSeq(lines, i, indent);
  return parseMap(lines, i, indent);
}

function parseMap(lines, i, mapIndent) {
  const obj = {};
  while (i < lines.length && lines[i].indent === mapIndent
      && !(lines[i].text.startsWith('- ') || lines[i].text === '-')) {
    const m = lines[i].text.match(KEY_RE);
    if (!m) { i += 1; continue; }
    const key = m[1];
    const rest = m[2] !== undefined ? m[2].trim() : '';
    if (rest === '') {
      const childIndent = (i + 1 < lines.length && lines[i + 1].indent > mapIndent) ? lines[i + 1].indent : null;
      if (childIndent == null) { obj[key] = null; i += 1; continue; }
      const r = parseNode(lines, i + 1, childIndent);
      obj[key] = r.value;
      i = r.next;
    } else {
      obj[key] = scalarOrList(rest);
      i += 1;
    }
  }
  return { value: obj, next: i };
}

function parseSeq(lines, i, seqIndent) {
  const arr = [];
  while (i < lines.length && lines[i].indent === seqIndent
      && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
    const after = lines[i].text === '-' ? '' : lines[i].text.slice(2).trim();
    const km = after.match(KEY_RE);
    if (km) {
      // Inline mapping item: "- key: val" plus deeper sibling keys on next lines.
      const itemIndent = seqIndent + 2;
      const obj = {};
      const k0 = km[1];
      const r0 = km[2] !== undefined ? km[2].trim() : '';
      if (r0 === '') {
        const childIndent = (i + 1 < lines.length && lines[i + 1].indent > itemIndent) ? lines[i + 1].indent : null;
        if (childIndent != null) {
          const r = parseNode(lines, i + 1, childIndent);
          obj[k0] = r.value;
          i = r.next;
        } else { obj[k0] = null; i += 1; }
      } else {
        obj[k0] = scalarOrList(r0);
        i += 1;
      }
      const sub = parseMap(lines, i, itemIndent);
      Object.assign(obj, sub.value);
      i = sub.next;
      arr.push(obj);
    } else if (after === '') {
      const childIndent = (i + 1 < lines.length && lines[i + 1].indent > seqIndent) ? lines[i + 1].indent : null;
      if (childIndent != null) {
        const r = parseNode(lines, i + 1, childIndent);
        arr.push(r.value);
        i = r.next;
      } else { arr.push(null); i += 1; }
    } else {
      arr.push(unquote(after));
      i += 1;
    }
  }
  return { value: arr, next: i };
}

/** Extract the raw text between the first two `---` fences. */
function extractFrontmatterBlock(text) {
  const lines = String(text).split('\n');
  if (lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') return lines.slice(1, i).join('\n');
  }
  return null;
}

/**
 * Parse a playbook's YAML front matter into a normalized object.
 * @param {string} text - full playbook markdown
 * @returns {object|null} { issueType, applicableFlavors, riskTier, requiredValidation, forbiddenTechniques, flavorOverrides, raw }
 */
function parsePlaybookFrontmatter(text) {
  const block = extractFrontmatterBlock(text);
  if (block == null) return null;
  const tokens = tokenizeYaml(block);
  const { value: raw } = parseMap(tokens, 0, 0);
  const asArray = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
  return {
    issueType: raw.issue_type || null,
    applicableFlavors: asArray(raw.applicable_stacks !== undefined ? raw.applicable_stacks : raw.applicable_flavors),
    riskTier: raw.risk_tier || null,
    requiredValidation: asArray(raw.required_validation),
    forbiddenTechniques: asArray(raw.forbidden_techniques),
    flavorOverrides: raw.flavor_overrides && typeof raw.flavor_overrides === 'object' ? raw.flavor_overrides : {},
    raw,
  };
}

// ---------------------------------------------------------------------------
// Playbook loading
// ---------------------------------------------------------------------------

function playbooksDir(opts) {
  if (opts && opts.dir) return opts.dir;
  if (process.env.CWV_PLAYBOOKS_DIR) return process.env.CWV_PLAYBOOKS_DIR;
  return path.join(__dirname, '..', 'references', 'playbooks');
}

/**
 * Load + parse a playbook by issue_type. Returns null if the file is absent
 * (callers degrade gracefully — attribution still works from signals + stack).
 * @param {string} issueType
 * @param {object} [opts] - { dir }
 * @returns {{issueType, file, frontmatter, body}|null}
 */
function loadPlaybook(issueType, opts) {
  if (!issueType) return null;
  const file = path.join(playbooksDir(opts), `${issueType}.md`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const frontmatter = parsePlaybookFrontmatter(text);
  const block = extractFrontmatterBlock(text);
  const body = block == null ? text : text.slice(text.indexOf('---', text.indexOf('---') + 3) + 3);
  return { issueType, file, frontmatter, body };
}

/**
 * Which playbooks apply to a metric on a given flavor — the "playbook-guided
 * diagnosis" entry point. Returns candidates in priority order, each flagged
 * `applicable` (its applicable_flavors includes the flavor).
 * @param {string} metric
 * @param {string|null} flavor - already normalized, or null
 * @param {object} [opts] - { dir }
 */
function playbooksForMetric(metric, flavor, opts) {
  const candidates = METRIC_ISSUE_TYPES[metric] || ['general'];
  return candidates.map((issueType) => {
    const pb = loadPlaybook(issueType, opts);
    const fm = pb && pb.frontmatter;
    const flavors = (fm && fm.applicableFlavors) || [];
    return {
      issueType,
      riskTier: (fm && fm.riskTier) || null,
      applicableFlavors: flavors,
      applicable: flavor && flavors.length > 0 ? flavors.includes(flavor) : true,
      loaded: Boolean(pb),
    };
  });
}

// ---------------------------------------------------------------------------
// Finding introspection helpers
// ---------------------------------------------------------------------------

function safeDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function primaryTarget(finding) {
  for (const ev of finding.evidence || []) {
    if (!ev || !ev.data) continue;
    if (typeof ev.data.target === 'string' && ev.data.target) return ev.data.target;
    if (typeof ev.data.largestShiftTarget === 'string' && ev.data.largestShiftTarget) return ev.data.largestShiftTarget;
  }
  const mk = finding.patches && Array.isArray(finding.patches.markup) && finding.patches.markup[0];
  if (mk && typeof mk.selector === 'string') return mk.selector;
  return '';
}

/** Collect { url, domain } resource references from a finding's evidence + patches. */
function resourceRefs(finding) {
  const refs = [];
  const push = (url) => { if (url && typeof url === 'string') refs.push({ url, domain: safeDomain(url) }); };
  for (const ev of finding.evidence || []) {
    if (!ev || !ev.data) continue;
    push(ev.data.url);
    if (Array.isArray(ev.data.byElement)) for (const b of ev.data.byElement) if (b) push(b.url);
  }
  const p = finding.patches || {};
  if (Array.isArray(p.block)) for (const u of p.block) push(u);
  if (Array.isArray(p.preloads)) for (const pl of p.preloads) if (pl) push(pl.href);
  return refs.filter((r) => r.domain);
}

/** A signature of the patch shape: attribute keys + notable inline-style markers. */
function patchSignature(finding) {
  const sig = new Set();
  const p = finding.patches || {};
  if (Array.isArray(p.preloads) && p.preloads.length) sig.add('preload');
  if (Array.isArray(p.block) && p.block.length) sig.add('block');
  if (p.responseHeaders) sig.add('response-header');
  if (Array.isArray(p.markup)) {
    for (const m of p.markup) {
      if (!m || !m.attrs) continue;
      for (const [k, v] of Object.entries(m.attrs)) {
        sig.add(k.toLowerCase());
        const val = String(v == null ? '' : v).toLowerCase();
        if (/min-height/.test(val)) sig.add('min-height');
        if (/aspect-ratio/.test(val)) sig.add('aspect-ratio');
        if (/font-display/.test(val)) sig.add('font-display');
      }
    }
  }
  return sig;
}

function isThirdPartyResource(domain) {
  if (!domain) return false;
  return THIRD_PARTY_DOMAIN_PATTERNS.some((re) => re.test(domain));
}

function isTagManager(domain, url) {
  if (domain && TAG_MANAGER_PATTERNS.some((re) => re.test(domain))) return true;
  if (url && TAG_MANAGER_URL_RE.test(url)) return true;
  return false;
}

function lcHeaders(headers) {
  if (!headers) return {};
  const out = {};
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h && h.name) out[String(h.name).toLowerCase()] = String(h.value == null ? '' : h.value);
    }
  } else if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = String(v == null ? '' : v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Issue-type inference (which playbook describes this finding)
// ---------------------------------------------------------------------------

/**
 * Infer the playbook issue_type a finding belongs to, from its metric +
 * shifting target + cause + patch shape. Deliberately weights the *specific*
 * cause + target + patch over the (often multi-branch, generic) recommendation.
 * @param {object} finding
 * @returns {string}
 */
function classifyFindingIssueType(finding) {
  const metric = (Array.isArray(finding.metric) && finding.metric[0]) || null;
  const target = (primaryTarget(finding) || '').toLowerCase();
  const cause = (finding.cause || '').toLowerCase();
  const sig = patchSignature(finding);
  const refs = resourceRefs(finding);
  const hasThirdParty = refs.some((r) => isThirdPartyResource(r.domain));
  const isImgTarget = /(^|[\s>.#])(img|picture)\b/.test(target) || /<img|hero image|lcp image/.test(cause);

  if (metric === 'CLS') {
    if (sig.has('font-display') || /font[- ]?swap|foit|fout|@font-face|font-display/.test(cause)) return 'font-fallback';
    if (isImgTarget || sig.has('width') || sig.has('height')
        || /missing (width|height|dimension)|unsized image|without (width|height|dimensions)/.test(cause)) return 'image-sizing';
    return 'layout-shift';
  }
  if (metric === 'LCP' || metric === 'SI') {
    if (sig.has('fetchpriority') || sig.has('preload') || isImgTarget) return 'lcp-image';
    if (/preconnect|dns-?prefetch/.test(cause)) return 'resource-hints';
    if (sig.has('defer') || sig.has('async') || /render-?blocking|blocking (script|stylesheet|css)/.test(cause)) return 'blocking-resource';
    if (/\bttfb\b|cache (miss|hit)|server-?timing/.test(cause)) return 'ttfb';
    return 'lcp-image';
  }
  if (metric === 'INP' || metric === 'TBT') {
    if (hasThirdParty && /defer|async|tag manager|analytics|third-?party/.test(cause)) return 'third-party';
    if (/long task|main thread|bundle|script (eval|parse|execution)|execution cost/.test(cause)) return 'js-execution';
    return 'interaction';
  }
  if (metric === 'TTFB') {
    if (/compress|gzip|brotli/.test(cause)) return 'compression';
    return 'ttfb';
  }
  return (METRIC_ISSUE_TYPES[metric] && METRIC_ISSUE_TYPES[metric][0]) || 'general';
}

// ---------------------------------------------------------------------------
// Owner classification — the core of G5(a)
// ---------------------------------------------------------------------------

function result(owner, confidence, issueType, flavor, signals, rationale, deliveryConstraint) {
  return {
    owner,
    confidence: Number(confidence.toFixed(2)),
    issueType,
    flavor: flavor || null,
    signals,
    rationale,
    deliveryConstraint: deliveryConstraint || null,
  };
}

/**
 * Classify the owner of a finding.
 * @param {object} finding - a Finding (see finding-schema.md)
 * @param {object} [ctx]
 * @param {string} [ctx.flavor] - stack name (e.g. generic, or a stack-pack name)
 * @param {object|Array} [ctx.responseHeaders] - response headers (map or [{name,value}])
 * @param {string} [ctx.issueType] - override the inferred issue type
 * @param {object} [ctx.playbook] - preloaded playbook frontmatter (skips disk load)
 * @param {string} [ctx.playbooksDir]
 * @returns {{owner, confidence, issueType, flavor, signals, rationale, deliveryConstraint}}
 */
function classifyOwner(finding, ctx = {}) {
  const flavor = normalizeFlavor(ctx.flavor);
  const issueType = ctx.issueType || classifyFindingIssueType(finding);
  const pbDir = ctx.playbooksDir;
  const playbook = ctx.playbook
    || (loadPlaybook(issueType, pbDir ? { dir: pbDir } : undefined) || {}).frontmatter
    || null;

  const signals = [];
  if (playbook) {
    signals.push(`consulted playbook "${issueType}" (risk_tier=${playbook.riskTier || '?'}${playbook.applicableFlavors && playbook.applicableFlavors.length ? `, applicable_stacks=[${playbook.applicableFlavors.join(', ')}]` : ''})`);
  } else {
    signals.push(`issue type "${issueType}" (no playbook loaded)`);
  }

  const cause = (finding.cause || '').toLowerCase();
  const rec = (finding.recommendation || '').toLowerCase();
  const text = `${cause} ${rec}`;
  const refs = resourceRefs(finding);
  const target = primaryTarget(finding);
  const metric = (Array.isArray(finding.metric) && finding.metric[0]) || null;
  const headers = lcHeaders(ctx.responseHeaders);

  // ---- S1: third-party — an actual vendor resource in the evidence. -------
  // The governing playbook is third-party.md regardless of the metric, so the
  // result records `third-party` as the consulted playbook.
  const tp = refs.find((r) => isThirdPartyResource(r.domain));
  if (tp) {
    const viaTagManager = isTagManager(tp.domain, tp.url);
    signals.push(`evidence cites third-party resource on ${tp.domain} → governed by the third-party playbook`);
    const rationale = viaTagManager
      ? `Owned by a third party (${tp.domain}) and injected via a tag manager — the fix is a tag-manager rule change, not a markup edit.`
      : `Owned by a third party (${tp.domain}). The site embedded it, but the bytes/behaviour are the vendor's; defer/async/gate it safely (see the third-party playbook).`;
    return result('third-party', viaTagManager ? 0.8 : 0.85, 'third-party', flavor, signals, rationale,
      viaTagManager ? 'requires-tag-manager-rule' : null);
  }

  // ---- S2: cdn-edge — TTFB-class or explicit cache signal. ----------------
  const xCache = headers['x-cache'] || '';
  const cacheMiss = /miss/i.test(xCache) || headers.age === '0';
  if (metric === 'TTFB' || issueType === 'ttfb' || issueType === 'compression' || cacheMiss) {
    if (cacheMiss) signals.push(`response headers show a caching-layer signal (${xCache || 'Age:0'})`);
    signals.push('TTFB/compression/cache issue — caching & edge layer, not page code');
    return result('cdn-edge', 0.8, issueType, flavor, signals,
      'Owned by the caching/edge layer (CDN / server config) — fix via cache rules, compression config, or origin tuning, not page code.', null);
  }

  // ---- S3: platform-default. ----------------------------------------------
  // The playbook EXCLUDES this stack → the type is platform-managed / N/A here.
  if (flavor && playbook && Array.isArray(playbook.applicableFlavors)
      && playbook.applicableFlavors.length > 0 && !playbook.applicableFlavors.includes(flavor)) {
    signals.push(`playbook "${issueType}" does not list stack "${flavor}" → platform-managed / N/A on this stack`);
    return result('platform-default', 0.8, issueType, flavor, signals,
      'Owned by the hosting platform — this issue type is not site-fixable on this stack per the playbook applicability matrix.',
      'requires-operator');
  }

  // ---- S4: customer-content — authored assets / dialog / content. ---------
  if (issueType === 'image-sizing'
      && /authored|dialog|content image|aspect-ratio|width.*height|set explicit (width|height)/.test(text)) {
    signals.push('image dimensions are an authoring / CMS-configuration concern');
    return result('customer-content', 0.7, issueType, flavor, signals,
      'Owned as content/authoring — image dimensions come from the authored asset or the CMS configuration, fixable without a code deploy (or in the template).',
      null);
  }

  // ---- S5: customer-code — the default for site implementation. -----------
  if (target) signals.push(`shifting/target element "${target}" is a first-party selector (no third-party resource in evidence)`);
  if (flavor && playbook && Array.isArray(playbook.applicableFlavors) && playbook.applicableFlavors.includes(flavor)) {
    signals.push(`playbook "${issueType}" applies to "${flavor}" → a site-fixable issue type on this stack`);
  }
  const rationale = `Owned by the site's own implementation (templates, CSS, JS). The shift/cost originates in site code, not the platform — fix per the ${issueType} playbook.`;
  return result('customer-code', flavor ? 0.72 : 0.6, issueType, flavor, signals, rationale, null);
}

// ---------------------------------------------------------------------------
// Public attribution API
// ---------------------------------------------------------------------------

/**
 * Return a copy of the finding tagged with `owner` (scalar) + `ownership` (detail).
 * @param {object} finding
 * @param {object} [ctx] - see classifyOwner
 */
function attributeFinding(finding, ctx = {}) {
  const r = classifyOwner(finding, ctx);
  return {
    ...finding,
    owner: r.owner,
    ownership: {
      owner: r.owner,
      confidence: r.confidence,
      flavor: r.flavor,
      playbook: r.issueType,
      deliveryConstraint: r.deliveryConstraint,
      rationale: r.rationale,
      signals: r.signals,
    },
  };
}

/**
 * Attribute every finding in an envelope (or a single finding). Returns a new
 * object; does not mutate the input.
 * @param {object} envelope - { findings: [...] } or a single Finding
 * @param {object} [ctx]
 */
function attributeEnvelope(envelope, ctx = {}) {
  if (envelope && Array.isArray(envelope.findings)) {
    return { ...envelope, findings: envelope.findings.map((f) => attributeFinding(f, ctx)) };
  }
  if (envelope && envelope.id && envelope.cause) return attributeFinding(envelope, ctx);
  return envelope;
}

// exported for testing
const _internals = { tokenizeYaml, parseMap, parseSeq, isThirdPartyResource, resourceRefs, primaryTarget, patchSignature };

export {
  OWNERS,
  METRIC_ISSUE_TYPES,
  normalizeFlavor,
  resolveFlavor,
  parsePlaybookFrontmatter,
  loadPlaybook,
  playbooksForMetric,
  classifyFindingIssueType,
  classifyOwner,
  attributeFinding,
  attributeEnvelope,
  _internals,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { input: null, flavor: null, headers: null, playbooksDir: null, output: null, explain: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--flavor':
      case '--stack': args.flavor = argv[++i]; break;
      case '--headers': args.headers = argv[++i]; break;
      case '--playbooks-dir': args.playbooksDir = argv[++i]; break;
      case '--output': args.output = argv[++i]; break;
      case '--explain': args.explain = argv[++i]; break;
      case '--help':
      case '-h': args.help = true; break;
      default:
        if (a.startsWith('--')) { process.stderr.write(`Unknown flag: ${a}\n`); process.exit(64); }
        args.input = a;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`
attribution.js — ownership attribution + playbook-guided diagnosis.

Tag each finding's owner (platform-default | cdn-edge | customer-code |
customer-content | third-party) from playbook applicability + response headers
+ evidence.

Usage:
  node .agents/scripts/attribution.js <findings.json> [flags]
  node .agents/scripts/attribution.js --explain <CLS|LCP|INP|TTFB|...>

Flags:
  --flavor / --stack <name>       Stack name (from a stack pack; default: none).
  --headers <path>                Response headers JSON ({name:value} or [{name,value}]).
  --playbooks-dir <dir>           Override the playbooks directory (default: vendored).
  --output <path>                 Write the attributed envelope (default: stdout).
  --explain <metric>              Print which playbooks apply to a metric (+ optional --flavor).
  --help, -h                      Show this help.

Exit codes: 0 ok · 64 bad usage · 65 input not readable/JSON
`.trimStart());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }
  const flavor = resolveFlavor(args);
  const opts = args.playbooksDir ? { dir: args.playbooksDir } : undefined;

  if (args.explain) {
    const metric = args.explain.toUpperCase();
    const pbs = playbooksForMetric(metric, flavor, opts);
    process.stdout.write(`${JSON.stringify({ metric, flavor: flavor || null, playbooks: pbs }, null, 2)}\n`);
    process.exit(0);
  }

  if (!args.input) { process.stderr.write('Error: a findings file is required (or use --explain <metric>).\n'); process.exit(64); }
  let data;
  try { data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args.input), 'utf8')); }
  catch (e) { process.stderr.write(`Error reading ${args.input}: ${e.message}\n`); process.exit(65); }

  let headers = null;
  if (args.headers) {
    try { headers = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args.headers), 'utf8')); }
    catch (e) { process.stderr.write(`Error reading ${args.headers}: ${e.message}\n`); process.exit(65); }
  }

  const out = attributeEnvelope(data, { flavor, responseHeaders: headers, playbooksDir: args.playbooksDir });
  const findings = Array.isArray(out.findings) ? out.findings : [out];
  const counts = {};
  for (const f of findings) counts[f.owner] = (counts[f.owner] || 0) + 1;

  const json = JSON.stringify(out, null, 2);
  if (args.output) {
    const dir = path.dirname(args.output);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(args.output, `${json}\n`, 'utf8');
    process.stderr.write(`Wrote ${args.output}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
  process.stderr.write(`attribution (flavor=${flavor || 'unknown'}): ${findings.length} finding(s) — ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}\n`);
}
