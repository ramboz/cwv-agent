
/**
 * source-mapper.js — translate runtime patches.json into concrete source-code
 * edits in a user's repo.
 *
 * Closes the loop for `cwv-fix`: once a patch is proven to help in lab, this
 * module proposes (preview, default) or performs (`--apply`) the equivalent
 * permanent edit in the target repo.
 *
 * Supported stacks (fingerprinted automatically, or forced via --stack):
 *   - `generic`    — plain static HTML templates.
 *   - `aem-eds`    — AEM Edge Delivery Services (scripts/scripts.js + head.html + blocks/).
 *   - `aem-cs`     — AEM as a Cloud Service (clientlibs + HTL under apps/).
 *
 * Supported patch types:
 *   - `preloads`         — <link rel=preload> insertion.
 *   - `markup`           — selector-based attribute edits in templates/blocks.
 *   - `block`            — URL-pattern blocking (script removal or loadDelayed move).
 *   - `responseHeaders`  — CDN config preview (Fastly VCL / CloudFront JS / Nginx).
 *   - `requestHeaders`   — same, request stage.
 *
 * Zero runtime dependencies beyond Node's fs/path.
 *
 * Invariants:
 *   - Preview mode never writes to disk.
 *   - --apply mode always creates a `.bak` copy next to any edited file, and
 *     prints the backup paths before touching originals.
 *   - CDN header patches and anything under `apps/` in an AEM CS repo are NEVER
 *     auto-applied — they are emitted to the "Manual review needed" section.
 *
 * CLI:
 *   node source-mapper.js --patches <path> --repo <root> [--apply] [--stack <name>]
 *
 * Module API:
 *   import { mapToSource } from './source-mapper.js';
 *   const { edits, warnings, stack } = await mapToSource({ patches, repoRoot });
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// --------------------------------------------------------------------------
// Stack detection
// --------------------------------------------------------------------------

/**
 * Read the SpaceCat importer manifest (`.cwv-source-manifest.json`, written by
 * source-fetch.js) if present. Returns the parsed object, or null when absent
 * or unparseable.
 * @param {string} repoRoot
 * @returns {object|null}
 */
function readManifest(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, '.cwv-source-manifest.json'), 'utf8'));
  } catch { return null; }
}

/**
 * Map an importer manifest to a stack, honoring the code *channel* first.
 *
 * The `aemy` channel (GitHub-via-AEMY) is always an EDS frontend repo — the CWV
 * fix surface for both document-based EDS and XWalk (AEM-authored EDS). It is
 * authoritative over `deliveryType`, which on a XWalk site reflects the *author*
 * stack (often `aem_cs`), not the published EDS frontend we actually edit. The
 * `cm` / unknown channel falls back to deliveryType: aem_cs / aem_ams share the
 * Maven/HTL layout for source edits → 'aem-cs'; aem_edge → 'aem-eds'. Returns
 * null when the manifest carries no usable signal.
 * @param {object|null} manifest
 * @returns {'aem-cs'|'aem-eds'|null}
 */
function stackFromManifest(manifest) {
  if (!manifest) return null;
  if (manifest.channel === 'aemy') return 'aem-eds';
  const map = { aem_cs: 'aem-cs', aem_ams: 'aem-cs', aem_edge: 'aem-eds' };
  return map[manifest.deliveryType] || null;
}

/**
 * Fingerprint a repo to pick the right mapping strategy. Uses file-tree
 * signals (never executes repo code). Returns one of: 'aem-eds', 'aem-cs',
 * 'generic'. If no signals match, defaults to 'generic'.
 *
 * Precedence: the importer manifest is consulted first — the `aemy` channel
 * pins aem-eds (a XWalk frontend tagged `aem_cs` still resolves to EDS), and a
 * deliveryType sidesteps the depth-limited walk — EXCEPT an unmistakably-EDS
 * file tree overrides a CS deliveryType, because the pulled repo's structure is
 * ground truth.
 *
 * Heuristics (mirrors .agents/references/topics/stack-detection.md):
 *   - aem-eds: scripts/scripts.js OR scripts/aem.js OR blocks/* OR head.html
 *   - aem-cs:  apps/**\/clientlibs OR etc.clientlibs OR ui.apps dir OR *.html
 *              under apps/**\/components
 *   - generic: anything else that has at least one .html file
 *
 * @param {string} repoRoot
 * @returns {{stack: 'aem-eds'|'aem-cs'|'generic', signals: string[]}}
 */
function detectStack(repoRoot) {
  const signals = [];
  const exists = (rel) => {
    try { return fs.existsSync(path.join(repoRoot, rel)); } catch { return false; }
  };
  const hasDir = (rel) => {
    try { return fs.statSync(path.join(repoRoot, rel)).isDirectory(); } catch { return false; }
  };

  // EDS signals — computed first so a clearly-EDS file tree can override a
  // mis-tagged manifest (e.g. a XWalk frontend whose deliveryType is aem_cs and
  // whose channel is missing from a hand-authored manifest).
  if (exists('scripts/scripts.js')) signals.push('eds:scripts/scripts.js');
  if (exists('scripts/aem.js')) signals.push('eds:scripts/aem.js');
  if (exists('head.html')) signals.push('eds:head.html');
  if (hasDir('blocks')) signals.push('eds:blocks/');
  if (exists('fstab.yaml') || exists('fstab.yml')) signals.push('eds:fstab');
  if (exists('helix-query.yaml')) signals.push('eds:helix-query');
  const edsScore = signals.filter((s) => s.startsWith('eds:')).length;
  const strongEds = edsScore >= 1
    && (exists('scripts/scripts.js') || exists('head.html') || hasDir('blocks'));

  // Most authoritative when present: the importer manifest. This also sidesteps
  // the file-tree heuristics' depth-limited walk, which otherwise mis-reads the
  // deeply-nested importer layout (portais/<site>/apps/.../jcr_root/apps/<proj>/
  // clientlibs, ~10 levels deep) as 'generic'.
  const manifest = readManifest(repoRoot);
  const fromManifest = stackFromManifest(manifest);
  if (fromManifest === 'aem-eds') {
    const via = manifest.channel === 'aemy' ? 'channel:aemy' : 'deliveryType:aem_edge';
    return { stack: 'aem-eds', signals: [`manifest:${via}`, ...signals] };
  }
  if (fromManifest === 'aem-cs') {
    // A strong EDS file tree beats a CS deliveryType (XWalk frontend, no channel).
    if (strongEds) {
      return { stack: 'aem-eds', signals: ['manifest:aem-cs(overridden by EDS file tree)', ...signals] };
    }
    return { stack: 'aem-cs', signals: ['manifest:aem-cs'] };
  }

  // No usable manifest signal — fall through to file-tree heuristics.
  if (strongEds) return { stack: 'aem-eds', signals };

  // AEM CS signals.
  if (hasDir('ui.apps')) signals.push('cs:ui.apps');
  if (hasDir('ui.frontend')) signals.push('cs:ui.frontend');
  if (hasDir('apps')) signals.push('cs:apps/');
  // any clientlibs subdir anywhere under apps/?
  const hasClientlibs = hasAnyPath(repoRoot, /\/clientlibs\//);
  if (hasClientlibs) signals.push('cs:clientlibs');
  const hasHtl = hasAnyPath(repoRoot, /\/apps\/.+\.html$/);
  if (hasHtl) signals.push('cs:htl');
  // `jcr_root/apps/` is the unmistakable AEM content-package marker — present in
  // the nested importer layout even when the top-level dirs are not ui.apps/apps.
  const hasJcrRoot = hasAnyPath(repoRoot, /\/jcr_root\/apps\//);
  if (hasJcrRoot) signals.push('cs:jcr_root');

  const csScore = signals.filter((s) => s.startsWith('cs:')).length;
  if (csScore >= 2) return { stack: 'aem-cs', signals };

  return { stack: 'generic', signals };
}

/**
 * Walk repoRoot (depth-limited) and return true if any relative path matches `re`.
 * Skips node_modules, .git, common build output.
 * @param {string} repoRoot
 * @param {RegExp} re
 * @returns {boolean}
 */
function hasAnyPath(repoRoot, re) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage']);
  // Deep enough for the importer's nested layout (clientlibs sit ~10 levels under
  // portais/<site>/apps/src/main/content/jcr_root/apps/<proj>/). Early-exits on
  // first match, so this only costs more on signal-free (generic) trees.
  const MAX_DEPTH = 16;
  const MAX_FILES = 5000;
  let count = 0;
  function walk(dir, depth) {
    if (depth > MAX_DEPTH) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (count++ > MAX_FILES) return false;
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(repoRoot, full).split(path.sep).join('/');
      if (re.test('/' + rel)) return true;
      if (e.isDirectory() && walk(full, depth + 1)) return true;
    }
    return false;
  }
  return walk(repoRoot, 0);
}

/**
 * List all files under `root` matching the given extension(s), bounded.
 * @param {string} root
 * @param {string[]} exts  e.g. ['.html'] — include leading dot
 * @param {number} max     cap
 * @returns {string[]} absolute paths
 */
function findFilesByExt(root, exts, max = 2000) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage']);
  const out = [];
  function walk(dir) {
    if (out.length >= max) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (exts.some((x) => full.toLowerCase().endsWith(x))) out.push(full);
      if (out.length >= max) return;
    }
  }
  walk(root);
  return out;
}

// --------------------------------------------------------------------------
// Edit builders — per patch type x stack.
// --------------------------------------------------------------------------

/**
 * Build a preload <link> line exactly.
 * @param {{href:string, as:string, crossorigin?:string|boolean, fetchpriority?:string, type?:string}} p
 * @returns {string}
 */
function buildPreloadLinkTag(p) {
  const parts = [`<link rel="preload" href="${p.href}" as="${p.as}"`];
  if (p.type) parts[0] += ` type="${p.type}"`;
  if (p.fetchpriority) parts[0] += ` fetchpriority="${p.fetchpriority}"`;
  if (p.crossorigin !== undefined && p.crossorigin !== null) {
    const v = p.crossorigin === true || p.crossorigin === '' ? 'anonymous' : p.crossorigin;
    parts[0] += ` crossorigin="${v}"`;
  }
  parts[0] += '>';
  return parts[0];
}

/**
 * Pick the "most recently modified .html file with a <head>" under repoRoot for
 * generic-HTML preload insertion. Prefer `index.html` when present.
 * @param {string} repoRoot
 * @returns {string|null} absolute path or null
 */
function pickGenericHtmlTemplate(repoRoot) {
  const htmlFiles = findFilesByExt(repoRoot, ['.html'], 1000);
  if (htmlFiles.length === 0) return null;
  const indexes = htmlFiles.filter((f) => /\/index\.html$/i.test(f) || path.basename(f).toLowerCase() === 'index.html');
  const candidates = indexes.length > 0 ? indexes : htmlFiles;
  let best = null;
  let bestMtime = -1;
  for (const f of candidates) {
    try {
      const src = fs.readFileSync(f, 'utf8');
      if (!/<head[\s>]/i.test(src)) continue;
      const mt = fs.statSync(f).mtimeMs;
      if (mt > bestMtime) { bestMtime = mt; best = f; }
    } catch { /* ignore */ }
  }
  return best;
}

/**
 * Build preload edits.
 * @param {Array<object>} preloads
 * @param {string} stack
 * @param {string} repoRoot
 * @param {Array<object>} warnings
 * @param {string} rationale
 * @returns {Array<object>}
 */
function buildPreloadEdits(preloads, stack, repoRoot, warnings, rationale) {
  if (!Array.isArray(preloads) || preloads.length === 0) return [];
  const edits = [];

  if (stack === 'aem-eds') {
    // Prefer head.html if present — simpler and explicit.
    const headHtml = path.join(repoRoot, 'head.html');
    if (fs.existsSync(headHtml)) {
      const src = fs.readFileSync(headHtml, 'utf8');
      const lines = src.split(/\r?\n/);
      const existingTags = new Set();
      for (const ln of lines) {
        const m = ln.match(/rel=["']?preload["']?[^>]*href=["']([^"']+)["']/i);
        if (m) existingTags.add(m[1]);
      }
      for (const p of preloads) {
        if (existingTags.has(p.href)) continue;
        const tag = buildPreloadLinkTag(p);
        // Insert near the end of head.html (which IS the head fragment).
        const insertLine = lines.length + 1;
        edits.push({
          file: headHtml,
          line: insertLine,
          before: lines[lines.length - 1] || '',
          after: (lines[lines.length - 1] || '') + '\n' + tag,
          rationale: rationale + ' (EDS: edit head.html)',
          autoApplicable: true,
          patchType: 'preloads',
          insertion: { mode: 'append', text: tag + '\n' },
        });
      }
      return edits;
    }
    // No head.html — recommend programmatic preload in loadEager.
    const scripts = path.join(repoRoot, 'scripts', 'scripts.js');
    if (fs.existsSync(scripts)) {
      for (const p of preloads) {
        warnings.push({
          kind: 'manual-review',
          reason: 'EDS repo has no head.html — preload must be added programmatically in loadEager()',
          file: scripts,
          recommendation: `Inside loadEager(), add:\n  const link = document.createElement('link');\n  link.rel = 'preload'; link.href = '${p.href}'; link.as = '${p.as}';${p.fetchpriority ? ` link.fetchPriority = '${p.fetchpriority}';` : ''}\n  document.head.appendChild(link);\nNOTE: EDS already emits Link: rel=preload headers for fetchpriority="high" images — prefer editing the <img> tag over manual preload when possible.`,
        });
      }
      return edits;
    }
  }

  if (stack === 'aem-cs') {
    for (const p of preloads) {
      warnings.push({
        kind: 'manual-review',
        reason: 'AEM CS preloads must be added to the page template HTL — do not auto-edit',
        recommendation: `Add <link rel="preload" href="${p.href}" as="${p.as}"${p.fetchpriority ? ` fetchpriority="${p.fetchpriority}"` : ''}> to the page template HTL (typically under apps/<project>/components/structure/page/customheaderlibs.html) or emit via a custom clientlib category included in <head>.`,
      });
    }
    return edits;
  }

  // Generic HTML.
  const tpl = pickGenericHtmlTemplate(repoRoot);
  if (!tpl) {
    warnings.push({ kind: 'manual-review', reason: 'No .html template with a <head> found in repo', recommendation: 'Add preload <link> tags to your HTML head manually.' });
    return edits;
  }
  const src = fs.readFileSync(tpl, 'utf8');
  const lines = src.split(/\r?\n/);
  // Collect already-present preload hrefs to dedupe.
  const existingHrefs = new Set();
  for (const ln of lines) {
    const m = ln.match(/rel=["']?preload["']?[^>]*href=["']([^"']+)["']/i);
    if (m) existingHrefs.add(m[1]);
  }
  // Find the <head> open line and the first child line (for insertion position).
  let headOpenIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/<head[\s>]/i.test(lines[i])) { headOpenIdx = i; break; }
  }
  if (headOpenIdx === -1) {
    warnings.push({ kind: 'manual-review', reason: `Template ${tpl} has no <head> tag`, recommendation: 'Manual preload insertion required.' });
    return edits;
  }
  const insertIdx = headOpenIdx + 1;
  for (const p of preloads) {
    if (existingHrefs.has(p.href)) continue;
    const tag = buildPreloadLinkTag(p);
    const beforeLine = lines[insertIdx] || '';
    edits.push({
      file: tpl,
      line: insertIdx + 1, // 1-indexed for display
      before: beforeLine,
      after: `  ${tag}\n${beforeLine}`,
      rationale,
      autoApplicable: true,
      patchType: 'preloads',
      insertion: { mode: 'insert-at-line', lineIndex: insertIdx, text: `  ${tag}\n` },
    });
    existingHrefs.add(p.href);
  }
  return edits;
}

/**
 * Build markup edits — set attributes on elements matching a selector.
 * Simple selector support: `tag`, `.class`, `tag.class`, `#id`, `tag#id`, `tag.cl1.cl2`.
 * For anything more exotic, emit a manual-review warning.
 *
 * @param {Array<{selector:string, attrs:object}>} mutations
 * @param {string} stack
 * @param {string} repoRoot
 * @param {Array<object>} warnings
 * @param {string} rationale
 * @returns {Array<object>}
 */
async function buildMarkupEdits(mutations, stack, repoRoot, warnings, rationale) {
  if (!Array.isArray(mutations) || mutations.length === 0) return [];
  const edits = [];

  for (const m of mutations) {
    const sel = parseSimpleSelector(m.selector || '');
    if (!sel) {
      warnings.push({ kind: 'manual-review', reason: `Selector "${m.selector}" is too complex for simple mapping`, recommendation: 'Apply attrs in the relevant template/block manually.' });
      continue;
    }

    if (stack === 'aem-eds') {
      // EDS: templates are authored elsewhere (Google Docs); the canonical
      // place to set attributes on rendered elements is inside the block
      // decorator in blocks/<name>/<name>.js.
      const blockName = inferEdsBlockFromSelector(sel);
      let blockJs = null;
      if (blockName) {
        const candidate = path.join(repoRoot, 'blocks', blockName, `${blockName}.js`);
        if (fs.existsSync(candidate)) blockJs = candidate;
      }
      if (!blockJs) {
        // Fall back to generic block match under blocks/* that uses this selector pattern.
        const blockFiles = findFilesByExt(path.join(repoRoot, 'blocks'), ['.js'], 200);
        if (blockFiles.length > 0) blockJs = blockFiles[0];
      }
      if (!blockJs) {
        warnings.push({ kind: 'manual-review', reason: `No EDS block found matching selector ${m.selector}`, recommendation: `Add a decorate-time attribute setter in the block that renders <${sel.tag || '*'}${sel.classes.map((c) => '.' + c).join('')}>.` });
        continue;
      }
      const snippet = buildEdsDecorateSnippet(m.selector, m.attrs);
      edits.push({
        file: blockJs,
        line: null, // append to decorate()
        before: '// inside decorate(block):',
        after: snippet,
        rationale: rationale + ' (EDS: edit block decorator)',
        autoApplicable: false, // decorator shape varies — recommend, do not auto-patch
        patchType: 'markup',
      });
      continue;
    }

    if (stack === 'aem-cs') {
      // Enrich the manual-review note by resolving the selector to its owning
      // component via selector-resolver (G4) — turns "likely under apps/…" into
      // the actual HTL path + delivery recommendation. Best-effort; falls back to
      // the generic pointer if the source tree can't resolve it. Lazy require
      // avoids the source-mapper ↔ selector-resolver dependency cycle.
      let resolution = null;
      try {
        const { resolveSelector } = await import('./selector-resolver.js');
        resolution = await resolveSelector({ selector: m.selector, sourceRoot: repoRoot, stack: 'aem-cs' });
      } catch { /* resolver is enrichment only */ }

      if (resolution && resolution.component) {
        const c = resolution.component;
        warnings.push({
          kind: 'manual-review',
          reason: `AEM CS markup edit for ${m.selector} → component ${c.name} (confidence ${resolution.confidence})`,
          file: c.htl || c.dir,
          recommendation: [
            `Component: ${c.name} (${c.resourceType})`,
            c.htl ? `HTL: ${c.htl}` : `Dir: ${c.dir}`,
            `Add attrs ${JSON.stringify(m.attrs)} to the matching element in the HTL (HTL is never auto-edited).`,
            `For a CSS/layout fix on this element, recommended delivery is "${resolution.delivery.recommended}" — see selector-resolver for the full styling trace + scaffold.`,
          ].join('\n'),
          resolution,
        });
      } else {
        warnings.push({ kind: 'manual-review', reason: `AEM CS markup edit for ${m.selector} — HTL cannot be auto-edited safely`, recommendation: `Locate the HTL template for the component rendering <${sel.tag || '*'}${sel.classes.map((c) => '.' + c).join('')}> (likely under apps/<project>/components/) and add attrs: ${JSON.stringify(m.attrs)}.` });
      }
      continue;
    }

    // Generic: grep .html files for the selector.
    const htmls = findFilesByExt(repoRoot, ['.html'], 1000);
    const matches = [];
    for (const f of htmls) {
      const src = fs.readFileSync(f, 'utf8');
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (matchesSelector(lines[i], sel)) {
          matches.push({ file: f, lineIdx: i, lineText: lines[i] });
        }
      }
    }
    if (matches.length === 0) {
      warnings.push({ kind: 'manual-review', reason: `No element matched selector ${m.selector} in any .html template`, recommendation: `Set attrs ${JSON.stringify(m.attrs)} on the target element manually.` });
      continue;
    }
    if (matches.length > 1) {
      warnings.push({ kind: 'ambiguous-selector', reason: `Selector ${m.selector} matched ${matches.length} locations`, candidates: matches.map((x) => `${x.file}:${x.lineIdx + 1}`), recommendation: 'Disambiguate the selector or pick one manually.' });
      continue;
    }
    const hit = matches[0];
    const edited = applyAttrsToLine(hit.lineText, sel, m.attrs);
    edits.push({
      file: hit.file,
      line: hit.lineIdx + 1,
      before: hit.lineText,
      after: edited,
      rationale,
      autoApplicable: edited !== hit.lineText,
      patchType: 'markup',
      insertion: { mode: 'replace-line', lineIndex: hit.lineIdx, text: edited },
    });
  }

  return edits;
}

/**
 * Parse very simple CSS selectors (no combinators, no attribute selectors, no pseudo).
 * Supported: optional tag, optional #id, zero-or-more .class.
 * Returns null if the selector has characters outside that grammar.
 * @param {string} s
 * @returns {{tag:string|null,id:string|null,classes:string[]}|null}
 */
function parseSimpleSelector(s) {
  const str = String(s).trim();
  if (!str) return null;
  if (/[\s>+~[\]:(),]/.test(str)) return null;
  const tagMatch = str.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  const tag = tagMatch ? tagMatch[0].toLowerCase() : null;
  const rest = tag ? str.slice(tag.length) : str;
  const classes = [];
  let id = null;
  const re = /([#.])([a-zA-Z0-9_-]+)/g;
  let m;
  let consumed = 0;
  while ((m = re.exec(rest)) !== null) {
    if (m.index !== consumed) return null;
    consumed = m.index + m[0].length;
    if (m[1] === '#') {
      if (id) return null;
      id = m[2];
    } else {
      classes.push(m[2]);
    }
  }
  if (consumed !== rest.length) return null;
  if (!tag && !id && classes.length === 0) return null;
  return { tag, id, classes };
}

/**
 * Test whether a single HTML line contains an opening tag matching `sel`.
 * Regex-based, not a real parser — good enough for template-authored HTML.
 * @param {string} line
 * @param {{tag:string|null,id:string|null,classes:string[]}} sel
 * @returns {boolean}
 */
function matchesSelector(line, sel) {
  const tagPattern = sel.tag || '[a-zA-Z][a-zA-Z0-9]*';
  const re = new RegExp(`<(${tagPattern})\\b([^>]*)>`, 'i');
  const m = line.match(re);
  if (!m) return false;
  const attrs = m[2];
  if (sel.id) {
    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
    if (!idMatch || idMatch[1] !== sel.id) return false;
  }
  if (sel.classes.length > 0) {
    const clsMatch = attrs.match(/\bclass\s*=\s*["']([^"']+)["']/i);
    if (!clsMatch) return false;
    const present = new Set(clsMatch[1].split(/\s+/));
    for (const c of sel.classes) if (!present.has(c)) return false;
  }
  return true;
}

/**
 * Apply attribute changes to an opening tag on a single line.
 * If an attr exists, its value is replaced; otherwise it is inserted before `>`.
 * @param {string} line
 * @param {{tag:string|null}} sel
 * @param {Object<string,string>} attrs
 * @returns {string}
 */
function applyAttrsToLine(line, sel, attrs) {
  const tagPattern = sel.tag || '[a-zA-Z][a-zA-Z0-9]*';
  const re = new RegExp(`<(${tagPattern})\\b([^>]*)>`, 'i');
  return line.replace(re, (full, tag, inner) => {
    let body = inner;
    for (const [k, v] of Object.entries(attrs || {})) {
      const attrRe = new RegExp(`\\s${escapeRegex(k)}\\s*=\\s*["'][^"']*["']`, 'i');
      if (attrRe.test(body)) {
        body = body.replace(attrRe, ` ${k}="${v}"`);
      } else {
        body = body.replace(/\s*$/, '') + ` ${k}="${v}"`;
      }
    }
    return `<${tag}${body}>`;
  });
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Heuristic: if a selector looks like `.hero` or `.teaser`, treat as an EDS block name.
 * @param {{tag:string|null,classes:string[]}} sel
 * @returns {string|null}
 */
function inferEdsBlockFromSelector(sel) {
  if (sel.classes.length > 0) return sel.classes[0];
  return null;
}

function buildEdsDecorateSnippet(selector, attrs) {
  const attrsJson = JSON.stringify(attrs || {});
  return `// Add inside decorate(block):
block.querySelectorAll('${selector}').forEach((el) => {
  const attrs = ${attrsJson};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null) el.removeAttribute(k);
    else el.setAttribute(k, String(v));
  }
});`;
}

/**
 * Build edits for `block` patches (URL patterns to block).
 * @param {string[]} patterns
 * @param {string} stack
 * @param {string} repoRoot
 * @param {Array<object>} warnings
 * @param {string} rationale
 * @returns {Array<object>}
 */
function buildBlockEdits(patterns, stack, repoRoot, warnings, rationale) {
  if (!Array.isArray(patterns) || patterns.length === 0) return [];
  const edits = [];

  if (stack === 'aem-eds') {
    const scriptsJs = path.join(repoRoot, 'scripts', 'scripts.js');
    if (!fs.existsSync(scriptsJs)) {
      warnings.push({ kind: 'manual-review', reason: 'No scripts/scripts.js in EDS repo', recommendation: 'Move third-party loaders into loadDelayed() manually.' });
      return edits;
    }
    const src = fs.readFileSync(scriptsJs, 'utf8');
    const lines = src.split(/\r?\n/);
    // For each blocked pattern, try to find a matching script import/url in scripts.js.
    for (const pat of patterns) {
      const simple = pat.replace(/\*/g, '');
      let hitIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(simple)) { hitIdx = i; break; }
      }
      if (hitIdx === -1) {
        warnings.push({ kind: 'manual-review', reason: `Pattern ${pat} not found in scripts/scripts.js`, recommendation: `Locate where this URL is loaded and move the call into loadDelayed().` });
        continue;
      }
      edits.push({
        file: scriptsJs,
        line: hitIdx + 1,
        before: lines[hitIdx],
        after: `// TODO: move into loadDelayed()\n// ${lines[hitIdx]}`,
        rationale: rationale + ' (EDS: move into loadDelayed)',
        autoApplicable: false,
        patchType: 'block',
      });
    }
    return edits;
  }

  if (stack === 'aem-cs') {
    // Emit Dispatcher rewrite rule text as a warning-level recommendation.
    const rules = patterns.map((p) => `  # block: ${p}\n  RewriteRule "${globToRegexString(p)}" - [F]`).join('\n');
    warnings.push({
      kind: 'manual-review',
      reason: 'AEM CS: block patterns should be applied at the Dispatcher / CDN layer, not in clientlibs',
      recommendation: `Add to Dispatcher vhost (or Fastly VCL equivalent):\n${rules}`,
    });
    return edits;
  }

  // Generic: find <script src="..."> tags in templates that match pattern.
  const htmls = findFilesByExt(repoRoot, ['.html'], 1000);
  for (const pat of patterns) {
    const globRe = new RegExp(globToRegexString(pat));
    for (const f of htmls) {
      const src = fs.readFileSync(f, 'utf8');
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i);
        if (m && globRe.test(m[1])) {
          edits.push({
            file: f,
            line: i + 1,
            before: lines[i],
            after: `<!-- removed by cwv-fix: ${pat} -->`,
            rationale,
            autoApplicable: true,
            patchType: 'block',
            insertion: { mode: 'replace-line', lineIndex: i, text: `<!-- removed by cwv-fix: ${pat} -->` },
          });
        }
      }
    }
  }
  return edits;
}

function globToRegexString(pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return '^' + escaped + '$';
}

/**
 * Build CDN-config previews for responseHeaders / requestHeaders rules.
 * Output goes to warnings as preview text — never auto-edited.
 * @param {Array<object>} rules
 * @param {'request'|'response'} stage
 * @param {string} stack
 * @param {Array<object>} warnings
 */
function buildHeaderRuleWarnings(rules, stage, stack, warnings) {
  if (!Array.isArray(rules) || rules.length === 0) return;
  // Default CDN target: Fastly VCL (most common with EDS sites).
  const vclSnippets = rules.map((r) => renderFastlyVcl(r, stage)).join('\n\n');
  warnings.push({
    kind: 'cdn-config',
    stage,
    recommendation: `Apply at CDN layer (Fastly VCL shown — adapt for CloudFront Functions, Nginx, or Vercel rewrites as needed). Do NOT commit into repo unless you operate the CDN.\n\n${vclSnippets}`,
  });
}

function renderFastlyVcl(rule, stage) {
  const urlGlob = rule.urlPattern || '*';
  const guard = urlGlob === '*' ? '' : `  if (req.url !~ "${urlGlob.replace(/\*/g, '.*')}") { return; }\n`;
  const set = rule.set || {};
  const append = rule.append || {};
  const remove = Array.isArray(rule.remove) ? rule.remove : [];
  const hdrBase = stage === 'request' ? 'req.http' : 'resp.http';
  const subName = stage === 'request' ? 'vcl_recv' : 'vcl_deliver';
  const lines = [];
  lines.push(`sub ${subName} {`);
  if (guard) lines.push(guard.trimEnd());
  for (const k of remove) lines.push(`  unset ${hdrBase}.${k};`);
  for (const [k, v] of Object.entries(set)) lines.push(`  set ${hdrBase}.${k} = "${v}";`);
  for (const [k, v] of Object.entries(append)) lines.push(`  set ${hdrBase}.${k} = if(${hdrBase}.${k}, ${hdrBase}.${k} + ", " + "${v}", "${v}");`);
  lines.push('}');
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Main entry
// --------------------------------------------------------------------------

/**
 * Translate a patches.json object to a list of concrete source edits + warnings.
 * @param {{patches: object, repoRoot: string, apply?: boolean, stack?: string}} opts
 * @returns {Promise<{edits: Array<object>, warnings: Array<object>, stack: string, signals: string[]}>}
 */
async function mapToSource(opts) {
  const { patches, repoRoot, apply = false } = opts || {};
  if (!patches || typeof patches !== 'object') throw new Error('patches object required');
  if (!repoRoot || !fs.existsSync(repoRoot)) throw new Error(`repoRoot does not exist: ${repoRoot}`);

  let stack = opts.stack;
  let signals = [];
  if (!stack) {
    const det = detectStack(repoRoot);
    stack = det.stack;
    signals = det.signals;
  }

  const warnings = [];
  let edits = [];

  // Accept a Finding with .patches, or a raw patches.json.
  const p = patches.patches && typeof patches.patches === 'object' ? patches.patches : patches;

  const baseRationale = patches.id
    ? `per finding ${patches.id}${patches.confidence != null ? ` (confidence ${patches.confidence})` : ''}${patches.impactReduction ? ` (+${patches.impactReduction.valueMs || patches.impactReduction.score}${patches.impactReduction.valueMs ? 'ms' : ' score'} ${patches.impactReduction.metric})` : ''}`
    : 'per patches.json';

  if (p.preloads) edits = edits.concat(buildPreloadEdits(p.preloads, stack, repoRoot, warnings, baseRationale));
  if (p.markup) edits = edits.concat(await buildMarkupEdits(p.markup, stack, repoRoot, warnings, baseRationale));
  if (p.block) edits = edits.concat(buildBlockEdits(p.block, stack, repoRoot, warnings, baseRationale));
  if (p.responseHeaders) buildHeaderRuleWarnings(p.responseHeaders, 'response', stack, warnings);
  if (p.requestHeaders) buildHeaderRuleWarnings(p.requestHeaders, 'request', stack, warnings);

  if (apply) {
    applyEdits(edits);
  }

  return { edits, warnings, stack, signals };
}

/**
 * Apply autoApplicable edits. Creates .bak copies first. Prints backup paths.
 * @param {Array<object>} edits
 */
function applyEdits(edits) {
  const touched = new Set();
  const backups = [];
  for (const e of edits) {
    if (!e.autoApplicable) continue;
    if (!e.file || touched.has(e.file)) continue;
    const bak = e.file + '.bak';
    fs.copyFileSync(e.file, bak);
    backups.push(bak);
    touched.add(e.file);
  }
  for (const bak of backups) {
    process.stdout.write(`backup: ${bak}\n`);
  }
  // Group edits by file; apply bottom-up to keep line indices stable.
  const byFile = new Map();
  for (const e of edits) {
    if (!e.autoApplicable || !e.insertion) continue;
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  for (const [file, fileEdits] of byFile) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split(/\r?\n/);
    // Sort descending by line index so earlier edits are stable.
    fileEdits.sort((a, b) => (b.insertion.lineIndex ?? lines.length) - (a.insertion.lineIndex ?? lines.length));
    for (const e of fileEdits) {
      const ins = e.insertion;
      if (ins.mode === 'replace-line') {
        lines[ins.lineIndex] = ins.text;
      } else if (ins.mode === 'insert-at-line') {
        lines.splice(ins.lineIndex, 0, ins.text.replace(/\n$/, ''));
      } else if (ins.mode === 'append') {
        lines.push(ins.text.replace(/\n$/, ''));
      }
    }
    fs.writeFileSync(file, lines.join('\n'));
  }
}

// --------------------------------------------------------------------------
// Preview report
// --------------------------------------------------------------------------

/**
 * Render a markdown preview of edits + warnings.
 * @param {{edits:Array<object>, warnings:Array<object>, stack:string, signals:string[]}} result
 * @returns {string}
 */
function renderPreview(result) {
  const { edits, warnings, stack, signals } = result;
  const out = [];
  out.push(`# Source Mapper preview`);
  out.push('');
  out.push(`Detected stack: **${stack}**${signals && signals.length ? ` (signals: ${signals.join(', ')})` : ''}`);
  out.push('');
  if (edits.length === 0) {
    out.push('_No automatic edits proposed._');
  } else {
    edits.forEach((e, i) => {
      out.push(`## Edit ${i + 1}: ${e.patchType} in ${path.basename(e.file)}`);
      out.push(`File: ${e.file}${e.line != null ? `:${e.line}` : ''}`);
      out.push(`Auto-applicable: ${e.autoApplicable ? 'yes' : 'no (manual)'}`);
      out.push('Before:');
      out.push('```');
      out.push(String(e.before).replace(/\n/g, '\n'));
      out.push('```');
      out.push('After:');
      out.push('```');
      out.push(String(e.after).replace(/\n/g, '\n'));
      out.push('```');
      out.push(`Rationale: ${e.rationale}`);
      out.push('');
    });
  }

  if (warnings.length > 0) {
    out.push('## Manual review needed');
    warnings.forEach((w, i) => {
      out.push(`${i + 1}. **${w.kind}** — ${w.reason || ''}`);
      if (w.file) out.push(`   File: ${w.file}`);
      if (w.stage) out.push(`   Stage: ${w.stage}`);
      if (w.candidates) out.push(`   Candidates:\n     - ${w.candidates.join('\n     - ')}`);
      if (w.recommendation) {
        out.push(`   Recommendation:`);
        out.push('   ```');
        out.push(w.recommendation.split('\n').map((l) => '   ' + l).join('\n'));
        out.push('   ```');
      }
    });
  }
  return out.join('\n');
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--patches') out.patches = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--stack') out.stack = argv[++i];
    else if (a === '--apply') out.apply = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (args.help || !args.patches || !args.repo) {
    process.stdout.write('Usage: node source-mapper.js --patches <path> --repo <root> [--apply] [--stack <name>]\n');
    process.exit(args.help ? 0 : 2);
  }
  const patchesPath = path.resolve(args.patches);
  const repoRoot = path.resolve(args.repo);
  const raw = fs.readFileSync(patchesPath, 'utf8');
  const patches = JSON.parse(raw);
  const result = await mapToSource({ patches, repoRoot, apply: args.apply, stack: args.stack });
  if (args.apply) {
    process.stdout.write(`applied ${result.edits.filter((e) => e.autoApplicable).length} edit(s)\n`);
    for (const w of result.warnings) {
      process.stdout.write(`warning: ${w.kind} — ${w.reason || ''}\n`);
    }
  } else {
    process.stdout.write(renderPreview(result) + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cliMain().catch((err) => { process.stderr.write(String(err && err.stack || err) + '\n'); process.exit(1); });
}

export {
  mapToSource,
  detectStack,
  stackFromManifest,
  renderPreview,
  buildPreloadLinkTag,
  parseSimpleSelector,
  matchesSelector,
  applyAttrsToLine,
  globToRegexString,
};
