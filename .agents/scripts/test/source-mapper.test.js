
/**
 * Sanity tests for source-mapper.js. No frameworks, plain asserts.
 *
 * Strategy:
 *   - Build a temp fixture tree for each test (generic HTML).
 *   - Run mapToSource() in preview mode only (no --apply).
 *   - Assert expected edits are proposed (file + line + key substrings).
 *   - Clean up temp dirs on exit.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  mapToSource,
  detectStack,
  parseSimpleSelector,
  matchesSelector,
  applyAttrsToLine,
  buildPreloadLinkTag,
} from '../source-mapper.js';

const tempDirs = [];
function mkTempRepo(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cwv-srcmap-${name}-`));
  tempDirs.push(d);
  return d;
}
function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}
process.on('exit', () => {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ------------------------------------------------------------------
// Unit-level helpers
// ------------------------------------------------------------------

function testSelectorParse() {
  assert.deepStrictEqual(parseSimpleSelector('img'), { tag: 'img', id: null, classes: [] });
  assert.deepStrictEqual(parseSimpleSelector('.hero'), { tag: null, id: null, classes: ['hero'] });
  assert.deepStrictEqual(parseSimpleSelector('img.hero'), { tag: 'img', id: null, classes: ['hero'] });
  assert.deepStrictEqual(parseSimpleSelector('button#cta.primary'), { tag: 'button', id: 'cta', classes: ['primary'] });
  assert.strictEqual(parseSimpleSelector('div > span'), null);
  assert.strictEqual(parseSimpleSelector('[data-x]'), null);
  assert.strictEqual(parseSimpleSelector(':hover'), null);
}

function testSelectorMatch() {
  const line = '<img src="/hero.jpg" class="hero large" alt="h">';
  assert.ok(matchesSelector(line, parseSimpleSelector('img')));
  assert.ok(matchesSelector(line, parseSimpleSelector('img.hero')));
  assert.ok(matchesSelector(line, parseSimpleSelector('.hero')));
  assert.ok(!matchesSelector(line, parseSimpleSelector('img.other')));
  assert.ok(!matchesSelector(line, parseSimpleSelector('button')));
}

function testApplyAttrs() {
  const line = '<img src="/hero.jpg" class="hero" alt="h">';
  const sel = parseSimpleSelector('img.hero');
  const edited = applyAttrsToLine(line, sel, { fetchpriority: 'high', loading: 'eager' });
  assert.match(edited, /fetchpriority="high"/);
  assert.match(edited, /loading="eager"/);
  assert.match(edited, /src="\/hero\.jpg"/);
}

function testBuildPreloadTag() {
  const t = buildPreloadLinkTag({ href: '/hero.jpg', as: 'image', fetchpriority: 'high' });
  assert.strictEqual(t, '<link rel="preload" href="/hero.jpg" as="image" fetchpriority="high">');
  const t2 = buildPreloadLinkTag({ href: '/f.woff2', as: 'font', type: 'font/woff2', crossorigin: true });
  assert.match(t2, /type="font\/woff2"/);
  assert.match(t2, /crossorigin="anonymous"/);
}

// ------------------------------------------------------------------
// Stack detection
// ------------------------------------------------------------------

function testDetectGeneric() {
  const root = mkTempRepo('generic');
  writeFile(root, 'index.html', '<!doctype html><html><head></head><body></body></html>');
  const { stack } = detectStack(root);
  assert.strictEqual(stack, 'generic');
}

// ------------------------------------------------------------------
// Preload mapping
// ------------------------------------------------------------------

async function testPreloadGeneric() {
  const root = mkTempRepo('preload-generic');
  const tpl = writeFile(root, 'index.html', [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <link rel="stylesheet" href="/styles.css">',
    '</head>',
    '<body><p>hi</p></body>',
    '</html>',
  ].join('\n'));
  const patches = { preloads: [{ href: '/hero.jpg', as: 'image', fetchpriority: 'high' }] };
  const { edits, stack, warnings } = await mapToSource({ patches, repoRoot: root });
  assert.strictEqual(stack, 'generic');
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0].file, tpl);
  assert.ok(edits[0].line >= 3, `line ${edits[0].line} should be at/after <head>`);
  assert.match(edits[0].after, /rel="preload"/);
  assert.match(edits[0].after, /href="\/hero\.jpg"/);
  assert.match(edits[0].after, /fetchpriority="high"/);
  assert.strictEqual(edits[0].patchType, 'preloads');
  assert.strictEqual(edits[0].autoApplicable, true);
  assert.strictEqual(warnings.length, 0);
}

async function testPreloadGenericDedupe() {
  const root = mkTempRepo('preload-dedupe');
  writeFile(root, 'index.html', [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <link rel="preload" href="/hero.jpg" as="image">',
    '  <link rel="stylesheet" href="/styles.css">',
    '</head>',
    '<body></body>',
    '</html>',
  ].join('\n'));
  const patches = { preloads: [{ href: '/hero.jpg', as: 'image', fetchpriority: 'high' }] };
  const { edits } = await mapToSource({ patches, repoRoot: root });
  assert.strictEqual(edits.length, 0, 'existing preload for same href should dedupe');
}

// ------------------------------------------------------------------
// Markup mapping (generic)
// ------------------------------------------------------------------

async function testMarkupGeneric() {
  const root = mkTempRepo('markup-generic');
  const tpl = writeFile(root, 'templates/home.html', [
    '<!doctype html>',
    '<html><head></head><body>',
    '  <img src="/hero.jpg" class="hero" alt="h">',
    '  <img src="/other.jpg" alt="o">',
    '</body></html>',
  ].join('\n'));
  const patches = { markup: [{ selector: 'img.hero', attrs: { fetchpriority: 'high', loading: 'eager' } }] };
  const { edits } = await mapToSource({ patches, repoRoot: root });
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0].file, tpl);
  assert.strictEqual(edits[0].line, 3);
  assert.match(edits[0].after, /fetchpriority="high"/);
  assert.match(edits[0].after, /loading="eager"/);
}

// ------------------------------------------------------------------
// Block mapping (generic)
// ------------------------------------------------------------------

async function testBlockGeneric() {
  const root = mkTempRepo('block-generic');
  const tpl = writeFile(root, 'index.html', [
    '<!doctype html>',
    '<html><head>',
    '  <script src="https://www.google-analytics.com/analytics.js"></script>',
    '</head><body></body></html>',
  ].join('\n'));
  const patches = { block: ['*google-analytics.com*'] };
  const { edits } = await mapToSource({ patches, repoRoot: root });
  assert.ok(edits.length >= 1);
  const ga = edits.find((e) => e.file === tpl);
  assert.ok(ga, 'expected an edit in index.html');
  assert.match(ga.after, /removed by cwv-fix/);
}

// ------------------------------------------------------------------
// Response headers -> CDN warning only
// ------------------------------------------------------------------

async function testResponseHeadersWarnOnly() {
  const root = mkTempRepo('respheaders');
  writeFile(root, 'index.html', '<!doctype html><html><head></head><body></body></html>');
  const patches = { responseHeaders: [{ urlPattern: '*', set: { 'Cache-Control': 'public, max-age=3600' } }] };
  const { edits, warnings } = await mapToSource({ patches, repoRoot: root });
  assert.strictEqual(edits.length, 0);
  assert.ok(warnings.some((w) => w.kind === 'cdn-config'));
  const w = warnings.find((x) => x.kind === 'cdn-config');
  assert.match(w.recommendation, /vcl_deliver|Cache-Control/);
}

// ------------------------------------------------------------------
// Accepts a Finding (not just raw patches.json)
// ------------------------------------------------------------------

async function testAcceptsFinding() {
  const root = mkTempRepo('finding');
  writeFile(root, 'index.html', '<!doctype html><html><head></head><body></body></html>');
  const finding = {
    schemaVersion: '1.0',
    id: 'diagnose-lcp-1',
    confidence: 0.85,
    impactReduction: { metric: 'LCP', valueMs: 1200 },
    patches: { preloads: [{ href: '/hero.jpg', as: 'image', fetchpriority: 'high' }] },
  };
  const { edits } = await mapToSource({ patches: finding, repoRoot: root });
  assert.strictEqual(edits.length, 1);
  assert.match(edits[0].rationale, /diagnose-lcp-1/);
  assert.match(edits[0].rationale, /0\.85/);
  assert.match(edits[0].rationale, /1200/);
}

// ------------------------------------------------------------------
// Runner
// ------------------------------------------------------------------

async function main() {
  const tests = [
    ['parseSimpleSelector', testSelectorParse],
    ['matchesSelector', testSelectorMatch],
    ['applyAttrsToLine', testApplyAttrs],
    ['buildPreloadLinkTag', testBuildPreloadTag],
    ['detectStack/generic', testDetectGeneric],
    ['preload/generic', testPreloadGeneric],
    ['preload/generic dedupe', testPreloadGenericDedupe],
    ['markup/generic', testMarkupGeneric],
    ['block/generic', testBlockGeneric],
    ['responseHeaders warn-only', testResponseHeadersWarnOnly],
    ['accepts Finding', testAcceptsFinding],
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      process.stdout.write(`ok  ${name}\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`FAIL ${name}\n${err && err.stack || err}\n`);
    }
  }
  if (failed > 0) {
    process.stdout.write(`\n${failed} test(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write(`\nall ${tests.length} tests passed\n`);
}

main().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
