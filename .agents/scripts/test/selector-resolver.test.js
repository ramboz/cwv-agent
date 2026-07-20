#!/usr/bin/env node

/**
 * Tests for .agents/scripts/selector-resolver.js — the runtime-selector → source
 * component resolver (ROADMAP G4).
 *
 * Strategy (repo convention — no network, no 1.7 GB tree in the unit suite):
 *   - Pure helpers tested directly with literals.
 *   - The source-tree orchestrator `resolveSelector` is tested against a small
 *     synthetic AEM-CS fixture built in a temp dir, faithfully mirroring the
 *     otempo golden case in miniature: the deep double-`/apps/` importer nesting,
 *     a `t004-cookie` component (inline model-driven style, Sling model, authored
 *     dialog) whose `.cookies__container` CSS is NOT in git (a `.font-lato`
 *     utility IS — the decoy), plus a second component whose structural CSS IS
 *     committed (the direct-edit branch), build-package + submodule signals.
 *   - A final integration test runs against the real pulled source IF present
 *     (gitignored, absent in CI) and is skipped otherwise.
 */

import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseRuntimeSelector,
  isLayoutClass,
  isUtilityClass,
  structuralClasses,
  fqcnToRelPaths,
  rankComponentCandidates,
  classifyDelivery,
  buildOverrideClientlibScaffold,
  htlHasClass,
  inlineStyleForClass,
  modelFqcnsInHtl,
  dialogFieldNames,
  enclosingComponent,
  scanSource,
  resolveSelector,
  emitScaffold,
} from '../selector-resolver.js';

// ---------------------------------------------------------------------------
// Temp-dir plumbing
// ---------------------------------------------------------------------------

const tempDirs = [];
function mkTemp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cwv-selres-${name}-`));
  tempDirs.push(d);
  return d;
}
function writeFile(root, rel, content) {
  const full = path.join(root, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// ---------------------------------------------------------------------------
// Synthetic AEM-CS fixture (the otempo golden case, in miniature)
// ---------------------------------------------------------------------------

// Mirror the importer's deep nesting so the "last /apps/" path parsing is exercised.
const APPS = 'portais/otempo/apps/src/main/content/jcr_root/apps/otempo';
const CORE = 'portais/otempo/core/src/main/java/gruposada/otempo/core/models';

function buildOtempoLikeFixture() {
  const root = mkTemp('otempo');

  // --- t004-cookie: CSS NOT in git (vendor-built) ---
  writeFile(root, `${APPS}/components/content/otempo/t004-cookie/.content.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>\n<jcr:root xmlns:jcr="http://www.jcp.org/jcr/1.0" xmlns:cq="http://www.day.com/jcr/cq/1.0"\n    jcr:primaryType="cq:Component"\n    jcr:title="T004 - Cookie"/>\n`);
  writeFile(root, `${APPS}/components/content/otempo/t004-cookie/t004-cookie.html`,
    `<sly data-sly-use.templates="core/wcm/components/commons/v1/templates.html">\n` +
    `  <section class="cookies__container font-lato"\n` +
    `    data-sly-use.model="gruposada.otempo.core.models.T004Cookie"\n` +
    `    style="position: fixed; \${model.positionLeft @ context='styleString'} \${model.position @ context='styleString'}">\n` +
    `    <div class="cookies__wrapper">consent</div>\n` +
    `  </section>\n</sly>\n`);
  writeFile(root, `${APPS}/components/content/otempo/t004-cookie/_cq_dialog/.content.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>\n<jcr:root xmlns:jcr="http://www.jcp.org/jcr/1.0"\n    jcr:primaryType="nt:unstructured">\n` +
    `  <positionProperty name="./positionProperty"/>\n` +
    `  <marginValue name="./marginValue"/>\n` +
    `  <marginLeft name="./marginLeft"/>\n` +
    `  <marginRight name="./marginRight"/>\n</jcr:root>\n`);
  writeFile(root, `${CORE}/T004Cookie.java`,
    `package gruposada.otempo.core.models;\npublic interface T004Cookie { String getPosition(); }\n`);
  writeFile(root, `${CORE}/impl/T004CookieImpl.java`,
    `package gruposada.otempo.core.models.impl;\npublic class T004CookieImpl implements T004Cookie {}\n`);

  // The decoy: a committed utility stylesheet that DOES style `.font-lato`.
  writeFile(root, `${APPS}/clientlibs/clientlib-fonts/css/fonts.css`,
    `.font-lato { font-family: Lato, sans-serif; }\n`);

  // --- cp001-breaking-news: structural CSS IS committed (direct-edit branch) ---
  writeFile(root, `${APPS}/components/content/otempo/cp001-breaking-news/.content.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>\n<jcr:root xmlns:jcr="http://www.jcp.org/jcr/1.0"\n    jcr:primaryType="cq:Component"/>\n`);
  writeFile(root, `${APPS}/components/content/otempo/cp001-breaking-news/cp001-breaking-news.html`,
    `<h2 class="breaking-news__title font-lato">\${model.title}</h2>\n`);
  writeFile(root, `${APPS}/clientlibs/clientlib-components/css/cp001.css`,
    `.breaking-news__title { font-size: 2rem; margin-bottom: 8px; }\n`);

  // --- build-origin signals: submodule + built .all package + vendor/ ---
  writeFile(root, '.gitmodules',
    `[submodule "vendor/netbiis/install"]\n\tpath = vendor/netbiis/install\n\turl = https://git.example.test/netbiis\n\tbranch = master\n`);
  writeFile(root, 'vendor/netbiis/src/main/content/jcr_root/apps/netbiis-vendor-packages/install/wizard.all-6.0.0.zip', 'PK (dummy built package)\n');

  return root;
}

// ---------------------------------------------------------------------------
// Pure: selector parsing + class classification
// ---------------------------------------------------------------------------

test('parseRuntimeSelector: descendant chain → ordered tokens + leaf', () => {
  const r = parseRuntimeSelector('div#container-32e9>div.aem-Grid>div.t004-cookie>section.cookies__container.font-lato');
  assert.equal(r.tokens.length, 4);
  assert.deepEqual(r.leaf.classes, ['cookies__container', 'font-lato']);
  assert.equal(r.leaf.tag, 'section');
  assert.ok(r.allClasses.includes('t004-cookie'));
  assert.ok(r.allClasses.includes('cookies__container'));
});

test('parseRuntimeSelector: bare leaf + empty input', () => {
  const bare = parseRuntimeSelector('.cookies__container');
  assert.equal(bare.tokens.length, 1);
  assert.deepEqual(bare.leaf.classes, ['cookies__container']);
  const empty = parseRuntimeSelector('');
  assert.equal(empty.tokens.length, 0);
  assert.equal(empty.leaf, null);
});

test('parseRuntimeSelector: splits on combinators and descendant whitespace', () => {
  const r = parseRuntimeSelector('div.a > span.b   p.c');
  assert.deepEqual(r.tokens.map((t) => t.raw), ['div.a', 'span.b', 'p.c']);
});

test('isLayoutClass: AEM grid chrome vs author classes', () => {
  assert.equal(isLayoutClass('aem-Grid'), true);
  assert.equal(isLayoutClass('aem-GridColumn--phone--12'), true);
  assert.equal(isLayoutClass('cookies__container'), false);
  assert.equal(isLayoutClass('t004-cookie'), false);
});

test('isUtilityClass: typography utilities vs structural', () => {
  assert.equal(isUtilityClass('font-lato'), true);
  assert.equal(isUtilityClass('text-center'), true);
  assert.equal(isUtilityClass('bg-dark'), true);
  assert.equal(isUtilityClass('cookies__container'), false);
});

test('structuralClasses: drops layout + utility, keeps structural; falls back when emptied', () => {
  assert.deepEqual(structuralClasses(['cookies__container', 'font-lato']), ['cookies__container']);
  assert.deepEqual(structuralClasses(['aem-Grid', 'cookies__container']), ['cookies__container']);
  // All utilities → keep them rather than lose the only signal.
  assert.deepEqual(structuralClasses(['font-lato']), ['font-lato']);
});

// ---------------------------------------------------------------------------
// Pure: FQCN mapping
// ---------------------------------------------------------------------------

test('fqcnToRelPaths: interface + impl paths by convention', () => {
  const r = fqcnToRelPaths('gruposada.otempo.core.models.T004Cookie');
  assert.equal(r.name, 'T004Cookie');
  assert.equal(r.interfaceRel, 'gruposada/otempo/core/models/T004Cookie.java');
  assert.equal(r.implRel, 'gruposada/otempo/core/models/impl/T004CookieImpl.java');
});

test('fqcnToRelPaths: rejects non-FQCN values (HTL template paths, bare packages)', () => {
  assert.equal(fqcnToRelPaths('core/wcm/components/commons/v1/templates.html'), null);
  assert.equal(fqcnToRelPaths('all.lowercase.segments'), null);
  assert.equal(fqcnToRelPaths(''), null);
});

// ---------------------------------------------------------------------------
// Pure: component-candidate reconciliation
// ---------------------------------------------------------------------------

test('rankComponentCandidates: convergence (deco + htl) → 0.85', () => {
  const r = rankComponentCandidates(
    [{ dir: '/a/t004-cookie', name: 't004-cookie', via: 'decoration-class:t004-cookie' }],
    [{ dir: '/a/t004-cookie', name: 't004-cookie', via: 'htl-class:cookies__container' }],
  );
  assert.equal(r.chosen.name, 't004-cookie');
  assert.equal(r.confidence, 0.85);
  assert.equal(r.matchedBy.length, 2);
});

test('rankComponentCandidates: decoration-only 0.7, htl-only 0.55', () => {
  const deco = rankComponentCandidates([{ dir: '/a/x', name: 'x', via: 'decoration-class:x' }], []);
  assert.equal(deco.confidence, 0.7);
  const htl = rankComponentCandidates([], [{ dir: '/a/y', name: 'y', via: 'htl-class:y' }]);
  assert.equal(htl.confidence, 0.55);
});

test('rankComponentCandidates: tied top → ambiguity capped at 0.5, all candidates surfaced', () => {
  const r = rankComponentCandidates([], [
    { dir: '/a/one', name: 'one', via: 'htl-class:shared' },
    { dir: '/a/two', name: 'two', via: 'htl-class:shared' },
  ]);
  assert.ok(r.confidence <= 0.5);
  assert.equal(r.candidates.length, 2);
});

test('rankComponentCandidates: no hits → null', () => {
  const r = rankComponentCandidates([], []);
  assert.equal(r.chosen, null);
  assert.equal(r.confidence, 0);
});

// ---------------------------------------------------------------------------
// Pure: delivery classification
// ---------------------------------------------------------------------------

test('classifyDelivery: committed CSS → direct-source-edit', () => {
  const d = classifyDelivery({ cssFoundInGit: true, buildPackageSignals: true, hasDialog: true });
  assert.equal(d.recommended, 'direct-source-edit');
  assert.ok(d.alternatives.some((a) => a.kind === 'override-clientlib'));
});

test('classifyDelivery: no CSS + build signals → override-clientlib with dialog + direct-edit alternatives', () => {
  const d = classifyDelivery({ cssFoundInGit: false, buildPackageSignals: true, hasDialog: true, modelDriven: true, hasInlineStyle: true });
  assert.equal(d.recommended, 'override-clientlib');
  assert.match(d.rationale, /vendor-built|not in the repo/i);
  assert.ok(d.alternatives.some((a) => a.kind === 'content-dialog'));
  assert.ok(d.alternatives.some((a) => a.kind === 'direct-source-edit'));
});

test('classifyDelivery: no CSS + no build signals → override-clientlib (safe default)', () => {
  const d = classifyDelivery({ cssFoundInGit: false, buildPackageSignals: false });
  assert.equal(d.recommended, 'override-clientlib');
  assert.match(d.rationale, /safe default/i);
});

// ---------------------------------------------------------------------------
// Pure: override-clientlib scaffold builder
// ---------------------------------------------------------------------------

test('buildOverrideClientlibScaffold: matches the shipped exemplar shape', () => {
  const s = buildOverrideClientlibScaffold({ project: 'otempo', selectors: ['.cookies__container', 'div.t004-cookie'] });
  assert.equal(s.category, 'otempo.cwv-fixes');
  assert.equal(s.files.length, 3);
  const byName = Object.fromEntries(s.files.map((f) => [f.relPath, f.content]));
  assert.match(byName['.content.xml'], /jcr:primaryType="cq:ClientLibraryFolder"/);
  assert.match(byName['.content.xml'], /categories="\[otempo\.cwv-fixes\]"/);
  assert.match(byName['.content.xml'], /allowProxy="\{Boolean\}true"/);
  assert.match(byName['css.txt'], /^#base=css/m);
  assert.match(byName['css/cwv-cls.css'], /\.cookies__container/);
  assert.match(byName['css/cwv-cls.css'], /div\.t004-cookie/);
  assert.match(byName['css/cwv-cls.css'], /!important/);
});

// ---------------------------------------------------------------------------
// Pure: HTL inspection helpers
// ---------------------------------------------------------------------------

test('htlHasClass / inlineStyleForClass: finds the element + model-driven inline style', () => {
  const src = `<section class="cookies__container font-lato" style="position: fixed; \${model.positionLeft}">x</section>`;
  assert.equal(htlHasClass(src, 'cookies__container'), true);
  assert.equal(htlHasClass(src, 'nope'), false);
  const inline = inlineStyleForClass(src, 'cookies__container');
  assert.match(inline.style, /position: fixed/);
  assert.equal(inline.modelDriven, true);
});

test('inlineStyleForClass: static inline style is not model-driven', () => {
  const src = `<div class="banner" style="height: 50px">x</div>`;
  const inline = inlineStyleForClass(src, 'banner');
  assert.equal(inline.modelDriven, false);
  assert.match(inline.style, /height: 50px/);
});

test('modelFqcnsInHtl: keeps model FQCNs, ignores HTL template includes', () => {
  const src = `<sly data-sly-use.templates="core/wcm/x/templates.html" data-sly-use.model="a.b.core.models.T004Cookie"></sly>`;
  assert.deepEqual(modelFqcnsInHtl(src), ['a.b.core.models.T004Cookie']);
});

test('dialogFieldNames: extracts authored property names', () => {
  const xml = `<root><a name="./positionProperty"/><b name="./marginValue"/><c name="./marginLeft"/></root>`;
  assert.deepEqual(dialogFieldNames(xml), ['positionProperty', 'marginValue', 'marginLeft']);
});

test('enclosingComponent: longest matching component dir wins', () => {
  const comps = [
    { dir: '/x/apps/p/components/a', name: 'a' },
    { dir: '/x/apps/p/components/a/nested', name: 'nested' },
  ];
  const r = enclosingComponent('/x/apps/p/components/a/nested/file.html', comps);
  assert.equal(r.name, 'nested');
});

// ---------------------------------------------------------------------------
// Source-tree: scanSource over the synthetic fixture
// ---------------------------------------------------------------------------

test('scanSource: collects components, HTL, CSS, java + build signals', () => {
  const root = buildOtempoLikeFixture();
  const scan = scanSource(root);
  const names = scan.componentDirs.map((c) => c.name).sort();
  assert.deepEqual(names, ['cp001-breaking-news', 't004-cookie']);
  assert.ok(scan.htlFiles.some((f) => f.endsWith('t004-cookie.html')));
  assert.ok(scan.cssFiles.some((f) => f.endsWith('fonts.css')));
  assert.ok(scan.javaFiles.some((f) => f.endsWith('T004CookieImpl.java')));
  assert.equal(scan.signals.gitmodules, true);
  assert.equal(scan.signals.vendorDir, true);
  assert.ok(scan.signals.allPackages.length >= 1);
  // project derived from the JCR /apps/<proj>/, not the Maven module dir.
  assert.equal(scan.componentDirs.find((c) => c.name === 't004-cookie').project, 'otempo');
});

// ---------------------------------------------------------------------------
// Source-tree: resolveSelector — the golden case (in miniature)
// ---------------------------------------------------------------------------

test('resolveSelector: full path → t004-cookie, full styling trace, vendor-built, override-clientlib', async () => {
  const root = buildOtempoLikeFixture();
  const r = await resolveSelector({
    selector: 'div#container-x>div.aem-Grid>div.t004-cookie>section.cookies__container.font-lato',
    sourceRoot: root,
  });
  assert.equal(r.stack, 'aem-cs');
  // component
  assert.equal(r.component.name, 't004-cookie');
  assert.equal(r.component.resourceType, 'otempo/components/content/otempo/t004-cookie');
  assert.equal(r.confidence, 0.85);
  assert.ok(r.component.matchedBy.some((m) => m.startsWith('decoration-class')));
  assert.ok(r.component.matchedBy.some((m) => m.startsWith('htl-class')));
  // styling trace
  const kinds = r.stylingTrace.map((t) => t.kind);
  assert.ok(kinds.includes('inline'));
  assert.ok(kinds.includes('sling-model'));
  assert.ok(kinds.includes('author-dialog'));
  assert.ok(kinds.includes('clientlib-css'));
  const inline = r.stylingTrace.find((t) => t.kind === 'inline');
  assert.equal(inline.modelDriven, true);
  const model = r.stylingTrace.find((t) => t.kind === 'sling-model');
  assert.equal(model.fqcn, 'gruposada.otempo.core.models.T004Cookie');
  assert.ok(model.impl && model.impl.endsWith('T004CookieImpl.java'));
  const dialog = r.stylingTrace.find((t) => t.kind === 'author-dialog');
  assert.deepEqual(dialog.fields, ['positionProperty', 'marginValue', 'marginLeft', 'marginRight']);
  const css = r.stylingTrace.find((t) => t.kind === 'clientlib-css');
  assert.equal(css.found, false); // .cookies__container is NOT in git (the .font-lato decoy is ignored)
  // base CSS origin + delivery
  assert.equal(r.baseCssOrigin.inGit, false);
  assert.equal(r.baseCssOrigin.reason, 'vendor-built');
  assert.equal(r.delivery.recommended, 'override-clientlib');
  assert.equal(r.delivery.scaffold.category, 'otempo.cwv-fixes');
});

test('resolveSelector: bare leaf selector degrades to HTL-only (0.55) but still resolves', async () => {
  const root = buildOtempoLikeFixture();
  const r = await resolveSelector({ selector: '.cookies__container', sourceRoot: root });
  assert.equal(r.component.name, 't004-cookie');
  assert.equal(r.confidence, 0.55);
  assert.equal(r.delivery.recommended, 'override-clientlib');
});

test('resolveSelector: structural CSS committed → direct-source-edit (the other branch)', async () => {
  const root = buildOtempoLikeFixture();
  const r = await resolveSelector({ selector: '.breaking-news__title', sourceRoot: root });
  assert.equal(r.component.name, 'cp001-breaking-news');
  const css = r.stylingTrace.find((t) => t.kind === 'clientlib-css');
  assert.equal(css.found, true);
  assert.equal(r.baseCssOrigin.reason, 'source-css');
  assert.equal(r.delivery.recommended, 'direct-source-edit');
});

test('resolveSelector: the .font-lato utility never poisons a structural resolution', async () => {
  const root = buildOtempoLikeFixture();
  // `.font-lato` IS committed (fonts.css) — but on a structural selector the CSS
  // search must trace ONLY the structural class, so the committed utility CSS
  // never flips the recommendation to a (wrong) direct edit of fonts.css.
  const r = await resolveSelector({
    selector: 'div.t004-cookie>section.cookies__container.font-lato',
    sourceRoot: root,
  });
  const css = r.stylingTrace.find((t) => t.kind === 'clientlib-css');
  assert.deepEqual(css.searchedClasses, ['cookies__container']); // font-lato excluded
  assert.equal(css.found, false);
  assert.equal(r.delivery.recommended, 'override-clientlib');
});

test('resolveSelector: unknown class → no component, override-clientlib safe default', async () => {
  const root = buildOtempoLikeFixture();
  const r = await resolveSelector({ selector: '.totally-unknown-xyz', sourceRoot: root });
  assert.equal(r.component, null);
  assert.equal(r.delivery.recommended, 'override-clientlib');
});

test('resolveSelector: manifest deliveryType is authoritative for stack', async () => {
  const root = buildOtempoLikeFixture();
  writeFile(root, '.cwv-source-manifest.json', JSON.stringify({ deliveryType: 'aem_cs', baseURL: 'https://example.test' }));
  const r = await resolveSelector({ selector: '.cookies__container', sourceRoot: root });
  assert.equal(r.stack, 'aem-cs');
  assert.equal(r.component.name, 't004-cookie');
});

// ---------------------------------------------------------------------------
// Source-tree: non-AEM-CS degrades gracefully
// ---------------------------------------------------------------------------

test('resolveSelector: EDS repo → unsupported pointer (no deep scan, no wrong guess)', async () => {
  const root = mkTemp('eds');
  writeFile(root, 'scripts/scripts.js', '// eds');
  writeFile(root, 'head.html', '<meta charset="utf-8">');
  writeFile(root, 'blocks/hero/hero.js', 'export default function decorate(){}');
  const r = await resolveSelector({ selector: '.hero', sourceRoot: root });
  assert.equal(r.supported, false);
  assert.equal(r.stack, 'aem-eds');
  assert.match(r.note, /source-mapper/);
});

// ---------------------------------------------------------------------------
// emitScaffold: writes the file set to disk
// ---------------------------------------------------------------------------

test('emitScaffold: writes .content.xml + css.txt + css/<file>.css', () => {
  const root = mkTemp('emit');
  const scaffold = buildOverrideClientlibScaffold({ project: 'otempo', selectors: ['.cookies__container'] });
  const written = emitScaffold(scaffold, root);
  assert.equal(written.length, 3);
  assert.ok(fs.existsSync(path.join(root, '.content.xml')));
  assert.ok(fs.existsSync(path.join(root, 'css.txt')));
  assert.ok(fs.existsSync(path.join(root, 'css', 'cwv-cls.css')));
});

// ---------------------------------------------------------------------------
// Integration: the REAL pulled otempo source, if present (skipped in CI)
// ---------------------------------------------------------------------------

// Repo-root-relative (`<root>/progress/...`); overridable for worktrees where
// the gitignored progress/ tree lives in the main checkout, not here.
const REAL_SOURCE = process.env.CWV_OTEMPO_SOURCE
  || path.resolve(__dirname, '../../../progress/otempo-com-br/source');

test('integration: real otempo source → t004-cookie + override-clientlib', { skip: !fs.existsSync(REAL_SOURCE) }, async () => {
  const r = await resolveSelector({
    selector: 'div#container-32e9778d0f>div.aem-Grid>div.t004-cookie>section.cookies__container.font-lato',
    sourceRoot: REAL_SOURCE,
  });
  assert.equal(r.stack, 'aem-cs');
  assert.equal(r.component.name, 't004-cookie');
  // resource type must equal the model's RESOURCE_TYPE constant.
  assert.equal(r.component.resourceType, 'otempo/components/content/otempo/t004-cookie');
  assert.equal(r.baseCssOrigin.inGit, false);
  assert.equal(r.delivery.recommended, 'override-clientlib');
  assert.equal(r.delivery.scaffold.category, 'otempo.cwv-fixes');
});
