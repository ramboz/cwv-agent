
/**
 * Spec 016-02 — Mode A / Mode B validate vocabulary (ADR-0016 §3).
 *
 * `describePatchModes(bundle)` re-labels every existing workbench patch op onto
 * the ASV two-mode ingest vocabulary, so the workbench validate output declares
 * its treatment in the same shape ASV consumes (spec 016-06 maps 1:1, no
 * translation).
 *
 * This module is PURE: it never touches interception, measurement, or verdict
 * logic. It reads a patch bundle and returns an array of mode descriptors.
 *
 * Vocabulary (ADR-0016 §3, Class 1/2):
 *   - Mode A       — `mutations: [{ target, op, value }]`. Platform-blind
 *                    attribute/head/link edits ASV's own engines can express.
 *   - Mode A (adjacent, workbench-only) — ops ASV's markup-Mode-A cannot express
 *                    (the workbench applies them at the CDP Fetch layer, not in
 *                    markup): `preload-link-header`, `request-header`,
 *                    `response-header`, `block`. Marked `workbenchOnly: true` so
 *                    016-06's adapter knows not to forward them as ASV Mode A.
 *                    This is a documented residue the spec's frame-critique noted.
 *   - Mode B `response` — `{ target, spliceKind:'response', bytesSummary }`. A
 *                    full-response / byte-injecting rewrite (injects a
 *                    style/script/link block or a large HTML chunk), OR a
 *                    whole-response fulfill-with-supplied-bytes op (the `response`
 *                    op, spec 016-04): the caller supplies finished bytes for a
 *                    request URL (a locally-rebuilt clientlib bundle) and the
 *                    launcher fulfils exactly those bytes. Both are byte injection.
 *   - Mode B `subtree` — RESERVED for 016-05's structural-HTL path. The current
 *                    bundle has no DOM-subtree op, so this function never emits it.
 */

// Heuristic thresholds for classifyRewriteRule.
// A "short" find/replace whose replacement injects no markup block is treated as
// an attribute-level rewrite (an ASV markup mutation could equivalently express
// it) → Mode A. Anything that injects a <style>/<link>/<script> block, or is a
// large HTML chunk, is byte injection → Mode B `response`.
const REWRITE_ATTR_MAX_LEN = 160;
const INJECTED_BLOCK_RE = /<\s*(style|link|script)\b/i;

/**
 * Classify a single `rewriteBody` rule as an attribute-level Mode-A rewrite or a
 * full-response / byte-injecting Mode-B `response` rewrite.
 *
 * Heuristic: a rule is Mode A only if EVERY replacement is a short find/replace
 * (both under REWRITE_ATTR_MAX_LEN chars) that injects no `<style>`/`<link>`/
 * `<script>` block. If any replacement injects such a block or is a large HTML
 * chunk, the whole rule is Mode B `response` (byte injection).
 *
 * @param {object} rule - `{ urlPattern, replacements: [{ find, replace }] }`
 * @returns {{ mode: 'A' | 'B', spliceKind?: 'response' }}
 */
function classifyRewriteRule(rule) {
  const replacements = rule && Array.isArray(rule.replacements) ? rule.replacements : [];
  for (const rep of replacements) {
    if (!rep || typeof rep !== 'object') continue;
    const find = typeof rep.find === 'string' ? rep.find : '';
    const replace = typeof rep.replace === 'string' ? rep.replace : '';
    if (INJECTED_BLOCK_RE.test(replace)) return { mode: 'B', spliceKind: 'response' };
    if (find.length > REWRITE_ATTR_MAX_LEN || replace.length > REWRITE_ATTR_MAX_LEN) {
      return { mode: 'B', spliceKind: 'response' };
    }
  }
  return { mode: 'A' };
}

/**
 * Build a compact human-readable summary of what a Mode-B `response` rewrite
 * injects (for the descriptor's `bytesSummary`). Names the block kinds injected
 * and the replacement count; never carries the full bytes (that is 016-06's job).
 *
 * @param {object} rule - `{ urlPattern, replacements: [{ find, replace }] }`
 * @returns {string}
 */
function summarizeInjectedBytes(rule) {
  const replacements = rule && Array.isArray(rule.replacements) ? rule.replacements : [];
  const kinds = new Set();
  let totalLen = 0;
  for (const rep of replacements) {
    const replace = rep && typeof rep.replace === 'string' ? rep.replace : '';
    totalLen += replace.length;
    let m;
    const re = new RegExp(INJECTED_BLOCK_RE.source, 'gi');
    while ((m = re.exec(replace)) !== null) kinds.add(m[1].toLowerCase());
  }
  const kindPart = kinds.size ? Array.from(kinds).sort().join('+') + ' block' : 'html chunk';
  return `injects ${kindPart} (${replacements.length} replacement(s), ~${totalLen} bytes)`;
}

/**
 * Byte length of a `response` op's supplied body. The body is either utf8 or
 * base64 (marked by `encoding:'base64'`); a base64 body is decoded so the count
 * reflects the real rebuilt-clientlib byte size, not the base64 expansion.
 *
 * @param {object} op - `{ body, encoding? }`
 * @returns {number}
 */
function responseBodyByteLength(op) {
  const body = op && typeof op.body === 'string' ? op.body : '';
  if (!body) return 0;
  if (op && op.encoding === 'base64') {
    try { return Buffer.from(body, 'base64').length; } catch { return body.length; }
  }
  return Buffer.byteLength(body, 'utf8');
}

/**
 * Normalize a header rule's set/append/remove coordinates for the descriptor
 * `value`. Mirrors the workbench header engine's own fields.
 *
 * @param {object} rule
 * @returns {{ set: object|null, append: object|null, remove: string[] }}
 */
function headerCoordinates(rule) {
  return {
    set: rule && rule.set && typeof rule.set === 'object' ? rule.set : null,
    append: rule && rule.append && typeof rule.append === 'object' ? rule.append : null,
    remove: rule && Array.isArray(rule.remove) ? rule.remove.slice() : [],
  };
}

/**
 * Serialize a single preload spec into the `Link` header value form the
 * workbench actually injects (rel=preload; as=…; fetchpriority=…), for the
 * descriptor `value`.
 *
 * @param {object} p
 * @returns {string}
 */
function preloadLinkValue(p) {
  if (!p || !p.href) return '';
  const segments = [`<${p.href}>`, 'rel=preload'];
  if (p.as) segments.push(`as=${p.as}`);
  if (p.type) segments.push(`type=${p.type}`);
  if (p.fetchpriority) segments.push(`fetchpriority=${p.fetchpriority}`);
  if (p.crossorigin !== undefined && p.crossorigin !== null) {
    const v = p.crossorigin === true || p.crossorigin === '' ? 'anonymous' : p.crossorigin;
    segments.push(`crossorigin=${v}`);
  }
  return segments.join('; ');
}

/**
 * Map a patch bundle to an array of ASV-shaped mode descriptors, one per op
 * (one per attribute for `markup`, one per rule/pattern otherwise). Pure.
 *
 * @param {object} bundle - the launcher patch bundle
 * @returns {Array<object>} mode descriptors (empty for an empty/invalid bundle)
 */
function describePatchModes(bundle) {
  const safe = bundle && typeof bundle === 'object' ? bundle : {};
  const descriptors = [];

  // markup -> Mode A, one descriptor per attribute.
  if (Array.isArray(safe.markup)) {
    for (const item of safe.markup) {
      if (!item || typeof item !== 'object' || !item.selector || !item.attrs) continue;
      for (const [, val] of Object.entries(item.attrs)) {
        const isRemoval = val === null || val === undefined;
        descriptors.push({
          mode: 'A',
          target: item.selector,
          op: isRemoval ? 'removeAttribute' : 'setAttribute',
          value: isRemoval ? null : String(val),
        });
      }
    }
  }

  // preloads -> Mode A (adjacent, workbench-only): injected Link response header.
  if (Array.isArray(safe.preloads)) {
    for (const p of safe.preloads) {
      if (!p || typeof p !== 'object' || !p.href) continue;
      descriptors.push({
        mode: 'A',
        workbenchOnly: true,
        target: 'document',
        op: 'preload-link-header',
        value: preloadLinkValue(p),
      });
    }
  }

  // requestHeaders / responseHeaders -> Mode A (adjacent, workbench-only).
  for (const [key, op] of [['requestHeaders', 'request-header'], ['responseHeaders', 'response-header']]) {
    if (!Array.isArray(safe[key])) continue;
    for (const rule of safe[key]) {
      if (!rule || typeof rule !== 'object' || !rule.urlPattern) continue;
      descriptors.push({
        mode: 'A',
        workbenchOnly: true,
        target: rule.urlPattern,
        op,
        value: headerCoordinates(rule),
      });
    }
  }

  // block -> Mode A (adjacent, workbench-only), one descriptor per glob.
  if (Array.isArray(safe.block)) {
    for (const pattern of safe.block) {
      if (typeof pattern !== 'string' || !pattern) continue;
      descriptors.push({
        mode: 'A',
        workbenchOnly: true,
        target: pattern,
        op: 'block',
        value: pattern,
      });
    }
  }

  // response -> Mode B `response` (016-04): a whole-response fulfill-with-supplied
  // -bytes op — the caller supplies finished bytes (a locally-rebuilt clientlib
  // bundle) for a request URL. This is byte injection, so it labels as Mode B
  // response, one descriptor per op.
  if (Array.isArray(safe.response)) {
    for (const op of safe.response) {
      if (!op || typeof op !== 'object' || !op.urlPattern) continue;
      const bytes = responseBodyByteLength(op);
      descriptors.push({
        mode: 'B',
        spliceKind: 'response',
        target: op.urlPattern,
        bytesSummary: `rebuilt clientlib bytes (~${bytes} bytes)`,
      });
    }
  }

  // rewriteBody -> per-rule classification: attribute-level (A) vs byte-injecting (B response).
  if (Array.isArray(safe.rewriteBody)) {
    for (const rule of safe.rewriteBody) {
      if (!rule || typeof rule !== 'object' || !rule.urlPattern) continue;
      const cls = classifyRewriteRule(rule);
      if (cls.mode === 'A') {
        descriptors.push({
          mode: 'A',
          target: rule.urlPattern,
          op: 'rewrite-attr',
          value: {
            replacements: (Array.isArray(rule.replacements) ? rule.replacements : []).map((rep) => ({
              find: rep && typeof rep.find === 'string' ? rep.find : null,
              replace: rep && typeof rep.replace === 'string' ? rep.replace : null,
            })),
          },
        });
      } else {
        descriptors.push({
          mode: 'B',
          spliceKind: 'response',
          target: rule.urlPattern,
          bytesSummary: summarizeInjectedBytes(rule),
        });
      }
    }
  }

  return descriptors;
}

export { describePatchModes, classifyRewriteRule };
