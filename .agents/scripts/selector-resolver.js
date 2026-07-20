
/**
 * selector-resolver.js — translate a *runtime selector* into its owning source
 * component, a trace of how that element is styled, and a recommended delivery
 * for a CSS/layout fix (ROADMAP G4: the "translate to source" gap).
 *
 * Where `source-mapper.js` translates a proven *patch* into concrete edits,
 * this module answers the upstream question those edits depend on: given a
 * selector that G1's `cls.shiftSources` / G3's chain-rum-correlator C6 flagged
 * as a layout-shift source (e.g. `.cookies__container`), *where does it live in
 * the repo and how is it styled?* On AEM CS that is a multi-hop question —
 * decoration class → component dir → HTL → Sling model → authored dialog →
 * clientlib CSS (or, often, vendor-built CSS that is NOT in git) — and getting
 * it wrong means shipping an edit to a layer that never reaches production.
 *
 * Scope: AEM Cloud Service (`aem-cs`) is the supported stack — the one where the
 * mapping is hard and the otempo golden case lives. `aem-eds` / `generic` get a
 * graceful "use source-mapper's <markup> path" pointer rather than a wrong guess.
 *
 * Design — four stages, pure helpers split from the source-tree orchestrator:
 *   1. parse     — `parseRuntimeSelector` splits a descendant chain into tokens.
 *   2. identify  — two strategies, reconciled: decoration-class (AEM wraps each
 *                  component in `<div class="<nodeName>">`) + HTL-class grep.
 *   3. trace     — inline style / Sling model / authored dialog / clientlib CSS.
 *   4. classify  — base-CSS origin (in-git vs vendor-built) → delivery rec
 *                  (direct edit / override clientlib / content-dialog change).
 *
 * Degrades gracefully: when the styling CSS is not found in git and the repo
 * shows built-package / submodule signals, it concludes "vendor-built — use an
 * override clientlib" instead of inventing a source path to edit.
 *
 * Zero runtime dependencies beyond Node's fs/path. Diagnostics → stderr,
 * machine output (JSON) → stdout, `require.main` guard — repo convention.
 *
 * CLI:
 *   node selector-resolver.js --selector <sel> --source <root> [--stack <name>]
 *                             [--md] [--emit <dir>]
 *
 * Module API:
 *   import { resolveSelector } from './selector-resolver.js';
 *   const result = await resolveSelector({ selector, sourceRoot });
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// Reuse the source-mapper's fingerprinting + simple-selector grammar so the two
// modules never drift on what "aem-cs" means or how a token parses.
import { detectStack, parseSimpleSelector } from './source-mapper.js';

// --------------------------------------------------------------------------
// Stage 1 — runtime selector parsing
// --------------------------------------------------------------------------

/**
 * AEM layout/decoration classes that are NOT component node names. The Grid
 * (parsys) wrappers in particular appear in every runtime selector path and
 * must never be mistaken for an owning component.
 */
const AEM_LAYOUT_CLASSES = new Set([
  'aem-Grid',
  'aem-GridColumn',
  'aem-Grid--default',
  'aem-GridColumn--default',
  'newpar',
  'section',
  'cq-placeholder',
  'aem-AuthorLayout',
]);

/**
 * True for a class that is AEM layout chrome rather than a component marker.
 * Matches the exact set above plus the `aem-Grid*` / `aem-GridColumn*` families
 * (responsive variants like `aem-GridColumn--phone--12`).
 * @param {string} c
 * @returns {boolean}
 */
function isLayoutClass(c) {
  if (!c) return true;
  if (AEM_LAYOUT_CLASSES.has(c)) return true;
  if (/^aem-Grid/.test(c) || /^aem-GridColumn/.test(c)) return true;
  return false;
}

/**
 * Typography / colour utility class prefixes that carry no structural (layout-
 * affecting) CSS. A selector leaf like `section.cookies__container.font-lato`
 * lists the structural block class first and a font utility second; tracing the
 * *utility* class would falsely find committed CSS (every site styles `.font-*`)
 * and mis-recommend a direct edit. We trace the structural class instead.
 */
const UTILITY_CLASS_RE = /^(font|text|fw|fs|bg|color|fg)-/;

/**
 * True for a typography/colour utility class (no structural CSS).
 * @param {string} c
 * @returns {boolean}
 */
function isUtilityClass(c) {
  return !!c && UTILITY_CLASS_RE.test(c);
}

/**
 * The structural (layout-bearing) classes among a list: drop AEM layout chrome
 * and typography utilities. Falls back to the original list if filtering would
 * leave nothing, so we never lose the only signal we have.
 * @param {string[]} classes
 * @returns {string[]}
 */
function structuralClasses(classes) {
  const kept = (classes || []).filter((c) => !isLayoutClass(c) && !isUtilityClass(c));
  return kept.length ? kept : (classes || []).slice();
}

/**
 * Parse a runtime selector (a descendant chain produced by the in-page CLS
 * shift-source aggregator, e.g.
 *   `div#container-32e9>div.aem-Grid>div.t004-cookie>section.cookies__container.font-lato`)
 * into ordered compound tokens. Combinators `>`, ` `, `+`, `~` all split tokens
 * (we only care about the set of ancestors, not their precise relationship).
 *
 * @param {string} selector
 * @returns {{tokens: Array<{raw:string, tag:string|null, id:string|null, classes:string[]}>,
 *            leaf: {raw:string, tag:string|null, id:string|null, classes:string[]}|null,
 *            allClasses: string[]}}
 */
function parseRuntimeSelector(selector) {
  const str = String(selector || '').trim();
  const empty = { tokens: [], leaf: null, allClasses: [] };
  if (!str) return empty;
  // Split on combinators with optional surrounding whitespace.
  const rawTokens = str.split(/\s*[>+~]\s*|\s+/).map((t) => t.trim()).filter(Boolean);
  const tokens = [];
  const allClasses = [];
  for (const raw of rawTokens) {
    const parsed = parseSimpleSelector(raw);
    if (parsed) {
      tokens.push({ raw, ...parsed });
      for (const c of parsed.classes) if (!allClasses.includes(c)) allClasses.push(c);
    } else {
      // Keep an opaque token so the path length / leaf stay meaningful even if a
      // single segment uses grammar parseSimpleSelector rejects.
      tokens.push({ raw, tag: null, id: null, classes: [] });
    }
  }
  if (tokens.length === 0) return empty;
  return { tokens, leaf: tokens[tokens.length - 1], allClasses };
}

// --------------------------------------------------------------------------
// FQCN <-> source path (Sling model resolution)
// --------------------------------------------------------------------------

/**
 * Map a Java fully-qualified class name to the source-relative paths AEM
 * convention puts it at. The HTL `data-sly-use.model` references the *interface*
 * (`a.b.c.T004Cookie`); the Sling-model impl lives in the `impl` sub-package as
 * `<Name>Impl.java` by overwhelming convention.
 *
 * @param {string} fqcn  e.g. "gruposada.otempo.core.models.T004Cookie"
 * @returns {{name:string, pkg:string, interfaceRel:string, implRel:string}|null}
 */
function fqcnToRelPaths(fqcn) {
  const s = String(fqcn || '').trim();
  // Looks-like-FQCN guard: dotted, last segment Capitalized (a class, not a pkg).
  if (!/^[a-zA-Z_][\w.]*\.[A-Z]\w*$/.test(s)) return null;
  const parts = s.split('.');
  const name = parts[parts.length - 1];
  const pkg = parts.slice(0, -1).join('.');
  const pkgPath = parts.slice(0, -1).join('/');
  return {
    name,
    pkg,
    interfaceRel: `${pkgPath}/${name}.java`,
    implRel: `${pkgPath}/impl/${name}Impl.java`,
  };
}

// --------------------------------------------------------------------------
// Stage 2 — component-candidate reconciliation (pure)
// --------------------------------------------------------------------------

/**
 * Reconcile the two component-identification strategies into a single choice.
 * Both strategies emit hits keyed by absolute component dir. Convergence (a dir
 * found by *both*) is the strongest signal; a single-strategy hit is medium; two
 * or more rival components are returned as ambiguous candidates.
 *
 * Confidence is capped at the lab/static tier (≤ 0.85, per finding-schema) since
 * this is a structural source inference, not a runtime measurement.
 *
 * @param {Array<{dir:string, name:string, via:string}>} decorationHits
 * @param {Array<{dir:string, name:string, via:string}>} htlHits
 * @returns {{chosen:object|null, confidence:number, matchedBy:string[], candidates:object[]}}
 */
function rankComponentCandidates(decorationHits, htlHits) {
  const byDir = new Map();
  const add = (h) => {
    if (!byDir.has(h.dir)) byDir.set(h.dir, { dir: h.dir, name: h.name, via: [] });
    byDir.get(h.dir).via.push(h.via);
  };
  for (const h of decorationHits || []) add(h);
  for (const h of htlHits || []) add(h);

  const candidates = [...byDir.values()];
  if (candidates.length === 0) {
    return { chosen: null, confidence: 0, matchedBy: [], candidates: [] };
  }

  // Score: converged (decoration + htl) > decoration-only > htl-only.
  const score = (c) => {
    const hasDeco = c.via.some((v) => v.startsWith('decoration-class'));
    const hasHtl = c.via.some((v) => v.startsWith('htl-class'));
    if (hasDeco && hasHtl) return 3;
    if (hasDeco) return 2;
    return 1;
  };
  candidates.sort((a, b) => score(b) - score(a));
  const top = candidates[0];
  const topScore = score(top);
  const tiedTop = candidates.filter((c) => score(c) === topScore);

  let confidence;
  if (topScore === 3) confidence = 0.85; // both strategies agree — lab-tier cap
  else if (topScore === 2) confidence = 0.7; // decoration class is AEM's own marker
  else confidence = 0.55; // HTL grep only

  // Genuine ambiguity (two+ components tied at the top score) — drop confidence
  // and surface all of them rather than guessing.
  if (tiedTop.length > 1) confidence = Math.min(confidence, 0.5);

  return {
    chosen: top,
    confidence,
    matchedBy: top.via.slice(),
    candidates,
  };
}

// --------------------------------------------------------------------------
// Stage 4 — delivery classification (pure)
// --------------------------------------------------------------------------

/**
 * Decide how a CSS/layout fix for the resolved element should be delivered,
 * from the styling-trace flags. This is the line the gap is about: when the
 * styling CSS is editable in git → direct edit; when it is vendor-built / not in
 * git → an override clientlib (the only thing that actually reaches prod); and a
 * content/dialog change when the property is authored.
 *
 * @param {{cssFoundInGit:boolean, buildPackageSignals:boolean, hasDialog:boolean,
 *          modelDriven:boolean, hasInlineStyle:boolean}} flags
 * @returns {{recommended:string, rationale:string, alternatives:Array<{kind:string, note:string}>}}
 */
function classifyDelivery(flags) {
  const f = flags || {};
  const alternatives = [];

  // Authored position/layout → a content change is always worth naming (zero code).
  const dialogAlt = f.hasDialog
    ? { kind: 'content-dialog', note: 'Change the authored value on the component instance (no code deploy). Repositions only — does not change the entrance animation / reflow behaviour that usually drives the shift.' }
    : null;

  if (f.cssFoundInGit) {
    if (dialogAlt) alternatives.push(dialogAlt);
    alternatives.push({ kind: 'override-clientlib', note: 'Also valid as a non-invasive overlay if you prefer not to touch the source CSS.' });
    return {
      recommended: 'direct-source-edit',
      rationale: 'The styling CSS for this element is committed in the repo — edit it directly and let the normal clientlib build ship it.',
      alternatives,
    };
  }

  // CSS not in git. The interesting case.
  const directEditAlt = (f.hasInlineStyle || f.modelDriven)
    ? { kind: 'direct-source-edit', note: 'The element\'s inline position is source-available (HTL + Sling model) and can be edited directly — but that controls position only, not the base visual CSS, which is not in git.' }
    : null;

  if (f.buildPackageSignals) {
    if (dialogAlt) alternatives.push(dialogAlt);
    if (directEditAlt) alternatives.push(directEditAlt);
    return {
      recommended: 'override-clientlib',
      rationale: 'The base visual CSS for this element is not in the repo — it ships as a vendor-built content package (built `.all` / submodule), so it cannot be source-edited. Deliver the fix as an override clientlib loaded AFTER the vendor styles (`!important` wins over the compiled CSS).',
      alternatives,
    };
  }

  // CSS not found and no build-package signal — do not guess a path. Override
  // clientlib is the safe, reversible default.
  if (dialogAlt) alternatives.push(dialogAlt);
  if (directEditAlt) alternatives.push(directEditAlt);
  return {
    recommended: 'override-clientlib',
    rationale: 'No committed CSS rule was found for this element and the build origin could not be confirmed. An override clientlib is the safe default (non-invasive, reversible); alternatively locate the styling source (it may be vendor-supplied) and edit it directly.',
    alternatives,
  };
}

// --------------------------------------------------------------------------
// Override-clientlib scaffold builder (pure)
// --------------------------------------------------------------------------

/**
 * Build the file set for a self-contained override clientlib, matching the
 * shipped otempo exemplar (`progress/otempo-com-br/fix/clientlib-cwv-fixes/`):
 * a `cq:ClientLibraryFolder` with `allowProxy`, a `css.txt` manifest, and one CSS
 * file. The CSS targets the resolved selector(s) with `!important` (it loads
 * after the vendor styles) and carries a header explaining the load order.
 *
 * The resolver does not invent the *fix* — it scaffolds the structure with the
 * resolved selectors and a sensible overlay default; diagnose/fix fills in the
 * validated rules.
 *
 * @param {{project:string, selectors:string[], fixSlug?:string, cssBody?:string}} opts
 * @returns {{category:string, files:Array<{relPath:string, content:string}>}}
 */
function buildOverrideClientlibScaffold(opts) {
  const project = (opts && opts.project) || 'project';
  const fixSlug = (opts && opts.fixSlug) || 'cwv-cls';
  const selectors = (opts && opts.selectors && opts.selectors.length)
    ? opts.selectors
    : [`/* TODO: target the shifting element */`];
  const category = `${project}.cwv-fixes`;

  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<jcr:root xmlns:jcr="http://www.jcp.org/jcr/1.0" xmlns:cq="http://www.day.com/jcr/cq/1.0"
    jcr:primaryType="cq:ClientLibraryFolder"
    categories="[${category}]"
    allowProxy="{Boolean}true"/>
`;

  const cssTxt = `#base=css\n${fixSlug}.css\n`;

  const selectorList = selectors.join(',\n');
  const cssBody = (opts && opts.cssBody) || `${selectorList} {
  /* Pin as a true overlay so the element's appearance never reflows the page.
     This clientlib must load AFTER the vendor styles; !important wins over the
     compiled vendor CSS. Replace with the validated rules from cwv-fix. */
  position: fixed !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  top: auto !important;
  margin: 0 !important;
}`;

  const css = `/*
 * CWV fix override clientlib (category ${category}).
 * Generated by selector-resolver (G4). Embed this category in the page <head>
 * AFTER the vendor / base styles, then replace the rules below with the
 * lab-validated fix from cwv-fix.
 */
${cssBody}
`;

  return {
    category,
    files: [
      { relPath: '.content.xml', content: contentXml },
      { relPath: 'css.txt', content: cssTxt },
      { relPath: `css/${fixSlug}.css`, content: css },
    ],
  };
}

// --------------------------------------------------------------------------
// Source-tree scan (the one impure walk)
// --------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', 'coverage', 'dam', // /content/dam = assets, never source
]);

/**
 * One bounded depth-first walk of the source tree, collecting only what the
 * resolver needs: AEM component dirs (a dir under `/apps/` holding a
 * `cq:Component` `.content.xml`), HTL files under `/components/`, stylesheet
 * sources, Java model files, and build-origin signals.
 *
 * Reading `.content.xml` is gated to paths under `/apps/` so authored content
 * nodes (which also carry `.content.xml`) in a multi-GB tree are never read.
 *
 * @param {string} sourceRoot
 * @param {{maxEntries?:number}} [opts]
 * @returns {{componentDirs:Array<{dir:string,name:string,project:string|null}>,
 *            htlFiles:string[], cssFiles:string[], javaFiles:string[],
 *            signals:{gitmodules:boolean, allPackages:string[], vendorDir:boolean, uiFrontend:boolean}}}
 */
function scanSource(sourceRoot, opts = {}) {
  const maxEntries = opts.maxEntries || 200000;
  const componentDirs = [];
  const htlFiles = [];
  const cssFiles = [];
  const javaFiles = [];
  const signals = { gitmodules: false, allPackages: [], vendorDir: false, uiFrontend: false };
  let count = 0;

  if (fs.existsSync(path.join(sourceRoot, '.gitmodules'))) signals.gitmodules = true;
  if (dirExists(path.join(sourceRoot, 'vendor'))) signals.vendorDir = true;

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const rel = '/' + path.relative(sourceRoot, dir).split(path.sep).join('/');
    const underApps = rel.includes('/apps/') || rel.endsWith('/apps');

    // A component dir: under /apps/ and holding a cq:Component .content.xml.
    if (underApps && entries.some((e) => e.isFile() && e.name === '.content.xml')) {
      try {
        const xml = fs.readFileSync(path.join(dir, '.content.xml'), 'utf8');
        if (/jcr:primaryType\s*=\s*"cq:Component"/.test(xml)) {
          componentDirs.push({ dir, name: path.basename(dir), project: projectOfAppsPath(rel) });
        }
      } catch { /* ignore */ }
    }

    for (const e of entries) {
      if (count++ > maxEntries) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name === 'ui.frontend') signals.uiFrontend = true;
        walk(full);
      } else {
        const lower = e.name.toLowerCase();
        const frel = '/' + path.relative(sourceRoot, full).split(path.sep).join('/');
        if (lower.endsWith('.html') && frel.includes('/components/')) htlFiles.push(full);
        else if (lower.endsWith('.css') || lower.endsWith('.less') || lower.endsWith('.scss')) cssFiles.push(full);
        else if (lower.endsWith('.java') && frel.includes('/src/main/java/')) javaFiles.push(full);
        else if (/\.all[.-].*\.zip$/.test(lower) || /\.all\.zip$/.test(lower)) signals.allPackages.push(full);
      }
    }
  }
  walk(sourceRoot);
  return { componentDirs, htlFiles, cssFiles, javaFiles, signals };
}

function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/**
 * Extract the `<project>` segment after the JCR `/apps/` in a tree-relative
 * path. The importer layout has two `/apps/` segments — the Maven module dir
 * (`portais/otempo/apps/`) and the JCR content root (`…/jcr_root/apps/otempo/`);
 * the project lives after the *last* one (greedy `.*`).
 */
function projectOfAppsPath(rel) {
  const m = rel.match(/^.*\/apps\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

/**
 * The nearest enclosing component dir for a file path, given the scanned
 * component dirs (longest matching dir prefix wins).
 * @param {string} filePath
 * @param {Array<{dir:string,name:string,project:string|null}>} componentDirs
 * @returns {{dir:string,name:string,project:string|null}|null}
 */
function enclosingComponent(filePath, componentDirs) {
  let best = null;
  for (const c of componentDirs) {
    if (filePath === c.dir || filePath.startsWith(c.dir + path.sep)) {
      if (!best || c.dir.length > best.dir.length) best = c;
    }
  }
  return best;
}

// --------------------------------------------------------------------------
// HTL inspection helpers
// --------------------------------------------------------------------------

/**
 * Does an HTML/HTL source contain an opening tag carrying `className` in its
 * `class="..."` attribute? Mirrors source-mapper's regex approach (template
 * HTML, not a full parser).
 * @param {string} src
 * @param {string} className
 * @returns {boolean}
 */
function htlHasClass(src, className) {
  const re = /class\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const classes = m[1].split(/\s+/);
    if (classes.includes(className)) return true;
  }
  return false;
}

/**
 * Find the opening tag in an HTL source that carries `className`, and return its
 * inline `style="..."` (if any) plus whether that style is Sling-model-driven
 * (`${model.* }`) — the otempo signature.
 * @param {string} src
 * @param {string} className
 * @returns {{style:string|null, modelDriven:boolean}}
 */
function inlineStyleForClass(src, className) {
  // Match opening tags and inspect the ones whose class list includes className.
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const attrs = m[2];
    const cls = attrs.match(/class\s*=\s*"([^"]*)"/i);
    if (!cls) continue;
    if (!cls[1].split(/\s+/).includes(className)) continue;
    const style = attrs.match(/style\s*=\s*"([^"]*)"/i);
    if (style) {
      return { style: style[1].trim(), modelDriven: /\$\{[^}]*\bmodel\./.test(style[1]) };
    }
    return { style: null, modelDriven: false };
  }
  return { style: null, modelDriven: false };
}

/**
 * Extract Sling-model FQCNs referenced by `data-sly-use.<var>="<FQCN>"` in HTL.
 * Only values that look like a Java FQCN are kept (so `data-sly-use.templates=
 * "core/wcm/.../templates.html"` is correctly ignored).
 * @param {string} src
 * @returns {string[]}
 */
function modelFqcnsInHtl(src) {
  const out = [];
  const re = /data-sly-use\.[\w-]+\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const val = m[1].trim();
    if (fqcnToRelPaths(val)) out.push(val);
  }
  return [...new Set(out)];
}

/**
 * Parse an authored `_cq_dialog/.content.xml` for its form-field names (nodes
 * with a `name="./<field>"` Granite property). These are the authored values a
 * Sling model reads — i.e. the content-change surface.
 * @param {string} xml
 * @returns {string[]}
 */
function dialogFieldNames(xml) {
  const out = [];
  const re = /\bname\s*=\s*"\.\/([\w-]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// --------------------------------------------------------------------------
// Stage 3 orchestration helpers (source-tree)
// --------------------------------------------------------------------------

/**
 * Find which committed stylesheet files contain a rule mentioning any of the
 * given class names. Cheap substring scan for `.<class>` — good enough to answer
 * "is there ANY committed CSS for this element?" (the binary the gap turns on).
 * @param {string[]} cssFiles  absolute paths
 * @param {string[]} classNames
 * @returns {Array<{file:string, classes:string[]}>}
 */
function cssFilesMatchingClasses(cssFiles, classNames) {
  const hits = [];
  for (const f of cssFiles) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const matched = classNames.filter((c) => src.includes('.' + c));
    if (matched.length) hits.push({ file: f, classes: matched });
  }
  return hits;
}

/**
 * Decide the stack for a source tree:
 *   1. explicit `--stack`,
 *   2. source-mapper's `detectStack` — now manifest-aware (it reads the importer
 *      `.cwv-source-manifest.json` deliveryType) and depth-tolerant, so it
 *      recognizes the deeply-nested importer layout directly.
 * Returns null only when detectStack is genuinely undecided ('generic'), leaving
 * the caller to infer aem-cs from the presence of real cq:Component dirs.
 * @param {string} sourceRoot
 * @param {{stack?:string}} opts
 * @returns {string|null}
 */
function detectStackForSource(sourceRoot, opts) {
  if (opts && opts.stack) return opts.stack;
  const det = detectStack(sourceRoot).stack;
  return det !== 'generic' ? det : null;
}

// --------------------------------------------------------------------------
// Main entry
// --------------------------------------------------------------------------

/**
 * Resolve a runtime selector to its owning component, styling trace, and a
 * recommended fix delivery, against an on-disk AEM source tree.
 *
 * @param {{selector:string, sourceRoot:string, stack?:string, project?:string}} opts
 * @returns {Promise<object>} the resolution result (see module docs / tests)
 */
async function resolveSelector(opts) {
  const { selector, sourceRoot } = opts || {};
  if (!selector || typeof selector !== 'string') throw new Error('selector (string) required');
  if (!sourceRoot || !fs.existsSync(sourceRoot)) throw new Error(`sourceRoot does not exist: ${sourceRoot}`);

  const parsed = parseRuntimeSelector(selector);
  let stack = detectStackForSource(sourceRoot, opts);
  const unsupported = (s) => ({
    selector, stack: s, parsedSelector: parsed, supported: false,
    note: `selector-resolver (G4) targets AEM CS. For "${s}", use source-mapper.js's markup mapping (EDS → block decorator; generic → grep .html).`,
  });

  // EDS is flat + unambiguous — if we already know it's EDS, skip the deep scan.
  if (stack === 'aem-eds') return unsupported('aem-eds');

  process.stderr.write(`[selector-resolver] scanning ${sourceRoot} …\n`);
  const scan = scanSource(sourceRoot);
  process.stderr.write(`[selector-resolver] ${scan.componentDirs.length} components, ${scan.htlFiles.length} HTL, ${scan.cssFiles.length} stylesheets, ${scan.javaFiles.length} java\n`);

  // Resolve an unknown stack from the scan itself: the importer layout nests the
  // project too deep for source-mapper's depth-limited fingerprint, but real
  // `cq:Component` dirs under /apps/ are an unambiguous AEM-CS signal.
  if (!stack) stack = scan.componentDirs.length > 0 ? 'aem-cs' : 'generic';

  const base = { selector, stack, parsedSelector: parsed };
  if (stack !== 'aem-cs') return unsupported(stack);

  // ---- Stage 2: identify the owning component -----------------------------
  // (a) decoration-class: a non-layout class token that names a component dir.
  const componentByName = new Map();
  for (const c of scan.componentDirs) {
    if (!componentByName.has(c.name)) componentByName.set(c.name, []);
    componentByName.get(c.name).push(c);
  }
  const authorClasses = parsed.allClasses.filter((c) => !isLayoutClass(c));
  const decorationHits = [];
  for (const cls of authorClasses) {
    const matches = componentByName.get(cls);
    if (matches) for (const c of matches) decorationHits.push({ dir: c.dir, name: c.name, via: `decoration-class:${cls}` });
  }

  // (b) HTL-class grep: which component's HTL authors the leaf's *structural*
  // class(es)? Utilities like `font-lato` are excluded — they match ~everything.
  const leafClasses = parsed.leaf ? parsed.leaf.classes : [];
  const gripClasses = structuralClasses(leafClasses.length ? leafClasses : authorClasses);
  const htlHits = [];
  for (const f of scan.htlFiles) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const matched = gripClasses.filter((c) => htlHasClass(src, c));
    if (matched.length) {
      const comp = enclosingComponent(f, scan.componentDirs);
      if (comp) htlHits.push({ dir: comp.dir, name: comp.name, via: `htl-class:${matched.join('+')}`, htl: f });
    }
  }

  const ranking = rankComponentCandidates(decorationHits, htlHits);
  if (!ranking.chosen) {
    return {
      ...base,
      component: null,
      confidence: 0,
      note: 'No owning component found by decoration-class or HTL-class strategies. The selector may not correspond to an AEM-authored component, or the source tree may be incomplete.',
      stylingTrace: [],
      baseCssOrigin: null,
      delivery: classifyDelivery({ cssFoundInGit: false, buildPackageSignals: hasBuildSignals(scan.signals) }),
    };
  }

  const chosenDir = ranking.chosen.dir;
  const chosenName = ranking.chosen.name;
  const project = opts.project || scan.componentDirs.find((c) => c.dir === chosenDir)?.project || null;

  // Locate the component's own HTL (prefer `<name>.html`, else any .html directly
  // in the component dir, else the file the HTL grep already matched).
  const compHtlFiles = scan.htlFiles.filter((f) => path.dirname(f) === chosenDir);
  let htlPath = path.join(chosenDir, `${chosenName}.html`);
  if (!fs.existsSync(htlPath)) htlPath = compHtlFiles[0] || (htlHits.find((h) => h.dir === chosenDir) || {}).htl || null;

  const resourceType = resourceTypeFromDir(chosenDir);

  // ---- Stage 3: styling trace ---------------------------------------------
  const stylingTrace = [];
  let modelDriven = false;
  let hasInlineStyle = false;
  let htlSrc = '';
  if (htlPath && fs.existsSync(htlPath)) {
    try { htlSrc = fs.readFileSync(htlPath, 'utf8'); } catch { /* ignore */ }
  }

  // inline style on the matched element
  const styleClass = (gripClasses[0]) || chosenName;
  if (htlSrc) {
    const inline = inlineStyleForClass(htlSrc, styleClass);
    if (inline.style) {
      hasInlineStyle = true;
      modelDriven = inline.modelDriven;
      stylingTrace.push({
        kind: 'inline',
        file: htlPath,
        style: inline.style,
        modelDriven: inline.modelDriven,
        note: inline.modelDriven
          ? 'Inline style on the element, with values driven by the Sling model (authored).'
          : 'Static inline style on the element.',
      });
    }

    // Sling model(s)
    const fqcns = modelFqcnsInHtl(htlSrc);
    for (const fqcn of fqcns) {
      const rels = fqcnToRelPaths(fqcn);
      if (!rels) continue;
      const iface = scan.javaFiles.find((j) => j.endsWith(path.sep + rels.interfaceRel.split('/').join(path.sep)));
      const impl = scan.javaFiles.find((j) => j.endsWith(path.sep + rels.implRel.split('/').join(path.sep)));
      stylingTrace.push({
        kind: 'sling-model',
        fqcn,
        interface: iface || null,
        impl: impl || null,
        note: impl
          ? 'Sling model emits the element\'s authored style values (source-available).'
          : 'Sling model referenced; impl not located in tree.',
      });
    }
  }

  // authored dialog
  const dialogXmlPath = path.join(chosenDir, '_cq_dialog', '.content.xml');
  let hasDialog = false;
  if (fs.existsSync(dialogXmlPath)) {
    try {
      const fields = dialogFieldNames(fs.readFileSync(dialogXmlPath, 'utf8'));
      hasDialog = fields.length > 0;
      stylingTrace.push({ kind: 'author-dialog', file: dialogXmlPath, fields, note: 'Authored properties feeding the model (content-change surface).' });
    } catch { /* ignore */ }
  }

  // clientlib / committed CSS
  const cssHits = cssFilesMatchingClasses(scan.cssFiles, gripClasses.length ? gripClasses : authorClasses);
  const cssFoundInGit = cssHits.length > 0;
  stylingTrace.push({
    kind: 'clientlib-css',
    found: cssFoundInGit,
    files: cssHits.map((h) => h.file),
    searchedClasses: gripClasses.length ? gripClasses : authorClasses,
    searchedFileCount: scan.cssFiles.length,
    note: cssFoundInGit
      ? 'Committed CSS rule(s) found for the element — source-editable.'
      : 'No committed CSS rule found for the element in any stylesheet in the repo.',
  });

  // ---- Stage 4: base-CSS origin + delivery --------------------------------
  const buildPackageSignals = hasBuildSignals(scan.signals);
  const baseCssOrigin = {
    inGit: cssFoundInGit,
    reason: cssFoundInGit ? 'source-css' : (buildPackageSignals ? 'vendor-built' : 'not-located'),
    evidence: cssFoundInGit
      ? cssHits.map((h) => `committed CSS ${path.relative(sourceRoot, h.file)} matches .${h.classes.join('/.')}`)
      : buildEvidence(scan.signals, sourceRoot, gripClasses.length ? gripClasses : authorClasses),
  };

  const delivery = classifyDelivery({ cssFoundInGit, buildPackageSignals, hasDialog, modelDriven, hasInlineStyle });
  if (delivery.recommended === 'override-clientlib') {
    const selectors = dedupe([
      ...(gripClasses.map((c) => '.' + c)),
      chosenName ? `div.${chosenName}` : null,
    ].filter(Boolean));
    delivery.scaffold = buildOverrideClientlibScaffold({ project: project || 'project', selectors });
  }

  return {
    ...base,
    component: {
      name: chosenName,
      resourceType,
      dir: chosenDir,
      htl: htlPath && fs.existsSync(htlPath) ? htlPath : null,
      project,
      matchedBy: ranking.matchedBy,
      candidates: ranking.candidates.length > 1 ? ranking.candidates.map((c) => ({ name: c.name, dir: c.dir, via: c.via })) : undefined,
    },
    confidence: ranking.confidence,
    stylingTrace,
    baseCssOrigin,
    delivery,
  };
}

function hasBuildSignals(signals) {
  return !!(signals && (signals.gitmodules || (signals.allPackages && signals.allPackages.length) || signals.vendorDir));
}

function buildEvidence(signals, sourceRoot, classes) {
  const ev = [];
  ev.push(`no committed CSS matches ${classes.map((c) => '.' + c).join(' / ')}`);
  if (signals.gitmodules) ev.push('.gitmodules present (frontend may ship via submodule)');
  if (signals.vendorDir) ev.push('vendor/ directory present');
  for (const z of (signals.allPackages || []).slice(0, 4)) ev.push(`built content package ${path.relative(sourceRoot, z)}`);
  if (signals.uiFrontend) ev.push('ui.frontend module present (compiled, output not committed under apps/)');
  return ev;
}

/**
 * `…/jcr_root/apps/<proj>/components/<group>/<name>` → resource type
 * `<proj>/components/<group>/<name>`. Greedy `.*` so the JCR `/apps/` (not the
 * Maven module's) is the anchor — matches the model's `RESOURCE_TYPE` constant.
 */
function resourceTypeFromDir(dir) {
  const norm = dir.split(path.sep).join('/');
  const m = norm.match(/^.*\/apps\/(.+)$/);
  return m ? m[1] : null;
}

function dedupe(arr) { return [...new Set(arr)]; }

// --------------------------------------------------------------------------
// Markdown rendering
// --------------------------------------------------------------------------

/**
 * Render a human-readable markdown report of a resolution.
 * @param {object} r  result of resolveSelector
 * @returns {string}
 */
function renderResolution(r) {
  const out = [];
  out.push('# Selector → source resolution');
  out.push('');
  out.push(`Selector: \`${r.selector}\``);
  out.push(`Stack: **${r.stack}**`);
  if (r.supported === false) {
    out.push('');
    out.push(`_${r.note}_`);
    return out.join('\n');
  }
  if (!r.component) {
    out.push('');
    out.push(`_${r.note}_`);
    return out.join('\n');
  }
  out.push('');
  out.push(`## Component: \`${r.component.name}\` (confidence ${r.confidence})`);
  out.push(`Resource type: \`${r.component.resourceType}\``);
  out.push(`Dir: ${r.component.dir}`);
  if (r.component.htl) out.push(`HTL: ${r.component.htl}`);
  out.push(`Matched by: ${r.component.matchedBy.join(', ')}`);
  if (r.component.candidates) {
    out.push(`Other candidates:`);
    for (const c of r.component.candidates) out.push(`  - ${c.name} (${c.via.join(', ')})`);
  }
  out.push('');
  out.push('## Styling trace');
  for (const t of r.stylingTrace) {
    if (t.kind === 'inline') out.push(`- **inline** (${path.basename(t.file)}): \`${t.style}\`${t.modelDriven ? ' — model-driven' : ''}`);
    else if (t.kind === 'sling-model') out.push(`- **sling-model** \`${t.fqcn}\` → impl ${t.impl ? path.basename(t.impl) : '(not found)'}`);
    else if (t.kind === 'author-dialog') out.push(`- **author-dialog**: fields [${t.fields.join(', ')}]`);
    else if (t.kind === 'clientlib-css') out.push(`- **clientlib-css**: ${t.found ? `FOUND in ${t.files.map((f) => path.basename(f)).join(', ')}` : `NOT FOUND (searched ${t.searchedFileCount} stylesheets for ${t.searchedClasses.map((c) => '.' + c).join(', ')})`}`);
  }
  out.push('');
  out.push(`## Base CSS origin: **${r.baseCssOrigin.reason}** (in git: ${r.baseCssOrigin.inGit})`);
  for (const e of r.baseCssOrigin.evidence) out.push(`- ${e}`);
  out.push('');
  out.push(`## Recommended delivery: **${r.delivery.recommended}**`);
  out.push(r.delivery.rationale);
  if (r.delivery.alternatives && r.delivery.alternatives.length) {
    out.push('');
    out.push('Alternatives:');
    for (const a of r.delivery.alternatives) out.push(`- **${a.kind}** — ${a.note}`);
  }
  if (r.delivery.scaffold) {
    out.push('');
    out.push(`### Override clientlib scaffold (category \`${r.delivery.scaffold.category}\`)`);
    for (const f of r.delivery.scaffold.files) {
      out.push(`\n**${f.relPath}**`);
      out.push('```');
      out.push(f.content.replace(/\n$/, ''));
      out.push('```');
    }
  }
  return out.join('\n');
}

/**
 * Write an override-clientlib scaffold to disk under `targetDir`.
 * @param {{category:string, files:Array<{relPath:string, content:string}>}} scaffold
 * @param {string} targetDir
 * @returns {string[]} written file paths
 */
function emitScaffold(scaffold, targetDir) {
  const written = [];
  for (const f of scaffold.files) {
    const full = path.join(targetDir, f.relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content);
    written.push(full);
  }
  return written;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { md: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selector') out.selector = argv[++i];
    else if (a === '--source') out.source = argv[++i];
    else if (a === '--stack') out.stack = argv[++i];
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--emit') out.emit = argv[++i];
    else if (a === '--md') out.md = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (args.help || !args.selector || !args.source) {
    process.stdout.write('Usage: node selector-resolver.js --selector <sel> --source <root> [--stack <name>] [--project <p>] [--md] [--emit <dir>]\n');
    process.exit(args.help ? 0 : 2);
  }
  const result = await resolveSelector({
    selector: args.selector,
    sourceRoot: path.resolve(args.source),
    stack: args.stack,
    project: args.project,
  });
  if (args.emit && result.delivery && result.delivery.scaffold) {
    const written = emitScaffold(result.delivery.scaffold, path.resolve(args.emit));
    for (const w of written) process.stderr.write(`emitted: ${w}\n`);
  }
  if (args.md) process.stdout.write(renderResolution(result) + '\n');
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cliMain().catch((err) => { process.stderr.write(String(err && err.stack || err) + '\n'); process.exit(1); });
}

export {
  // pure
  parseRuntimeSelector,
  isLayoutClass,
  isUtilityClass,
  structuralClasses,
  AEM_LAYOUT_CLASSES,
  fqcnToRelPaths,
  rankComponentCandidates,
  classifyDelivery,
  buildOverrideClientlibScaffold,
  htlHasClass,
  inlineStyleForClass,
  modelFqcnsInHtl,
  dialogFieldNames,
  enclosingComponent,
  cssFilesMatchingClasses,
  // source-tree
  scanSource,
  resolveSelector,
  renderResolution,
  emitScaffold,
};
