
/**
 * Sanity tests for html-parse.js. Exits 0 on success, non-zero on failure.
 * No test framework — plain asserts, to stay zero-dependency.
 */

import assert from 'node:assert';
import { analyzeHtml, _internal } from '../html-parse.js';
import { validateFinding } from '../../finding-schema.js';
const {
  decodeHtmlEntities,
  cssEscapeAttrValue,
  parseAttrs,
  buildErrorEnvelope,
} = _internal;

const URL = 'https://example.com/';

function ruleIds(findings) {
  const ids = new Set();
  for (const f of findings) {
    for (const e of f.evidence || []) {
      if (e.kind === 'rule-violation' && e.data && e.data.ruleId) ids.add(e.data.ruleId);
    }
  }
  return ids;
}

function assertFindingsValid(findings, label) {
  for (const f of findings) {
    const r = validateFinding(f);
    assert.ok(r.valid, `[${label}] finding ${f.id} invalid: ${r.errors.join('; ')}`);
  }
}

async function test1_blockingScriptAndViewportAndFavicon() {
  // Missing viewport, favicon before stylesheet, blocking script without defer.
  const html = `<!doctype html>
<html><head>
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/styles.css">
<script src="/app.js"></script>
</head><body><p>hi</p></body></html>`;

  const { findings } = await analyzeHtml(html, { url: URL, fromString: true });
  assertFindingsValid(findings, 'test1');
  const ids = ruleIds(findings);
  assert.ok(ids.has('html/missing-viewport-meta'), 'expected viewport-meta rule');
  assert.ok(ids.has('html/favicon-before-stylesheet'), 'expected favicon-before-stylesheet rule');
  assert.ok(ids.has('html/blocking-script-in-head'), 'expected blocking-script rule');
}

async function test2_imgDimensionsAndLcpFetchPriority() {
  // Large hero <img> without fetchpriority + missing dimensions.
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css">
</head><body>
<img src="/hero.jpg" alt="hero">
<img src="/other.jpg" alt="other" width="200" height="150">
</body></html>`;

  const { findings } = await analyzeHtml(html, { url: URL, fromString: true });
  assertFindingsValid(findings, 'test2');
  const ids = ruleIds(findings);
  assert.ok(ids.has('html/img-missing-dimensions'), 'expected img-missing-dimensions rule');
  assert.ok(ids.has('html/lcp-candidate-missing-fetchpriority'), 'expected lcp-candidate-missing-fetchpriority rule');
  // G3: static element guesses are HYPOTHESES, never confirmed root causes.
  const dimsFinding = findings.find((f) => f.evidence.some(
    (e) => e.data && e.data.ruleId === 'html/img-missing-dimensions',
  ));
  assert.strictEqual(dimsFinding.rootCause, false, 'img-missing-dimensions must not be rootCause (static guess)');
  assert.ok(dimsFinding.confidence <= 0.5, `static CLS guess confidence should be low, got ${dimsFinding.confidence}`);
}

async function test2b_trackingPixelNotFlaggedAsClsSource() {
  // G3: a Comscore-style tracking beacon with no width/height is invisible and
  // causes no CLS — it must NOT be flagged as a CLS source (otempo false positive).
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css">
</head><body>
<img src="https://sb.scorecardresearch.com/p?c1=2&c2=12345">
<img src="/real-hero.jpg" alt="hero">
</body></html>`;

  const { findings } = await analyzeHtml(html, { url: URL, fromString: true });
  assertFindingsValid(findings, 'test2b');
  const dimsFindings = findings.filter((f) => f.evidence.some(
    (e) => e.data && e.data.ruleId === 'html/img-missing-dimensions',
  ));
  // Exactly one — the real hero — and never the tracking pixel.
  assert.strictEqual(dimsFindings.length, 1, `expected only the real img flagged, got ${dimsFindings.length}`);
  const matched = dimsFindings[0].evidence.find((e) => e.data && e.data.ruleId === 'html/img-missing-dimensions');
  assert.ok(/real-hero/.test(matched.data.match), 'the flagged img should be the real hero, not the beacon');
}

async function test3_preconnectDeferrableAndInlineScript() {
  const bigInline = 'var x = "' + 'A'.repeat(6 * 1024) + '";';
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://www.google-analytics.com">
<link rel="dns-prefetch" href="https://connect.facebook.net">
<script>${bigInline}</script>
<link rel="stylesheet" href="/styles.css">
</head><body><p>ok</p></body></html>`;

  const { findings } = await analyzeHtml(html, { url: URL, fromString: true });
  assertFindingsValid(findings, 'test3');
  const ids = ruleIds(findings);
  assert.ok(ids.has('html/preconnect-to-deferrable'), 'expected preconnect-to-deferrable rule');
  assert.ok(ids.has('html/large-inline-script-in-head'), 'expected large-inline-script rule');
  // Should have two preconnect findings (GA + FB).
  const preconnects = findings.filter((f) => f.evidence.some(
    (e) => e.data && e.data.ruleId === 'html/preconnect-to-deferrable',
  ));
  assert.strictEqual(preconnects.length, 2, 'expected 2 preconnect-deferrable findings');
}

async function test3b_inlineSvgPayload() {
  const largePath = 'M0 0 ' + 'L1 1 '.repeat(450);
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css">
</head><body>
<svg viewBox="0 0 100 100" aria-hidden="true"><path d="${largePath}"></path></svg>
</body></html>`;

  const { findings } = await analyzeHtml(html, { url: URL, fromString: true });
  assertFindingsValid(findings, 'test3b');
  const svg = findings.find((f) => f.evidence.some(
    (e) => e.data && e.data.ruleId === 'html/inline-svg-in-body',
  ));
  assert.ok(svg, 'expected inline-svg-in-body finding');
  assert.deepStrictEqual(svg.metric, ['FCP', 'LCP', 'TBT'], 'inline SVG should map to paint + main-thread metrics');
  assert.strictEqual(svg.rootCause, false, 'static inline SVG rule is a hypothesis');
  assert.strictEqual(svg.confidence, 0.55, 'inline SVG confidence should match static heuristic calibration');
}

async function test3bb_inlineSvgPayloadCrossingEarlyWindow() {
  const largePath = 'M0 0 ' + 'L1 1 '.repeat(7000);
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css">
</head><body>
<svg viewBox="0 0 100 100" aria-hidden="true"><path d="${largePath}"></path></svg>
</body></html>`;

  const { findings } = await analyzeHtml(html, { url: URL, fromString: true });
  assertFindingsValid(findings, 'test3bb');
  const svg = findings.find((f) => f.evidence.some(
    (e) => e.data && e.data.ruleId === 'html/inline-svg-in-body',
  ));
  assert.ok(svg, 'expected oversized early inline SVG to fire even when closing tag is after scan window');
  const evidence = svg.evidence.find((e) => e.data && e.data.ruleId === 'html/inline-svg-in-body');
  assert.ok(evidence.data.context.largestBytes > 30 * 1024, 'regression fixture should cross the early scan window');
}

async function test3bc_inlineSvgPayloadAggregateThreshold() {
  const iconPath = 'M0 0 ' + 'L1 1 '.repeat(300);
  const icons = Array.from({ length: 4 }, (_, index) => (
    `<svg viewBox="0 0 100 100" aria-hidden="true" data-i="${index}"><path d="${iconPath}"></path></svg>`
  )).join('');
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css">
</head><body>
${icons}
</body></html>`;

  const { findings } = await analyzeHtml(html, { url: URL, fromString: true });
  assertFindingsValid(findings, 'test3bc');
  const svg = findings.find((f) => f.evidence.some(
    (e) => e.data && e.data.ruleId === 'html/inline-svg-in-body',
  ));
  assert.ok(svg, 'expected aggregate inline SVG payload to fire');
  const evidence = svg.evidence.find((e) => e.data && e.data.ruleId === 'html/inline-svg-in-body');
  assert.ok(evidence.data.context.largestBytes < 2 * 1024, 'fixture should stay below per-SVG threshold');
  assert.ok(evidence.data.context.totalBytes >= 6 * 1024, 'fixture should cross aggregate threshold');
}

async function test3c_tinyInlineSvgIgnored() {
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css">
</head><body>
<svg width="16" height="16" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"></path></svg>
</body></html>`;

  const { findings } = await analyzeHtml(html, { url: URL, fromString: true });
  assertFindingsValid(findings, 'test3c');
  const ids = ruleIds(findings);
  assert.ok(!ids.has('html/inline-svg-in-body'), 'tiny inline icon should not fire inline-svg rule');
}

async function test3d_edsStructuralContractFailure() {
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/eds/styles/styles.css">
<script src="/eds/scripts/scripts.js" type="module"></script>
<style>
header { position: fixed; z-index: 1000; }
main { padding-top: 0; }
main .section-block___viewblock { display: block !important; }
body.appear main { display: block; }
</style>
</head><body>
<header class="global-header overlay"><nav>Navigation</nav></header>
<main>
  <div class="section css-block"><style>.foo { color: red; }</style></div>
  <div class="section spacer-and-divider spacer large"></div>
  <div class="section spacer-and-divider spacer medium"></div>
  <div class="section promo-banner"><p>Explore savings options</p></div>
  <div class="section tabs"><p>Commercial insurance</p><p>Cash option</p></div>
  <div id="select-your-insurance" class="section">
    <h1>Select your insurance type to see available savings options</h1>
    <picture><img src="/hero.jpg" width="1200" height="600" fetchpriority="high"></picture>
    <p>This decision section is the first real above-the-fold content, but it
    appears only after placeholder, spacer, and tab-shell sections.</p>
  </div>
</main>
</body></html>`;

  const { findings, meta } = await analyzeHtml(html, { url: 'https://zepbound.lilly.com/savings', fromString: true });
  assertFindingsValid(findings, 'test3d');
  assert.strictEqual(meta.stack && meta.stack.eds, true, 'expected EDS stack detection in meta');
  const structural = findings.find((f) => f.evidence.some(
    (e) => e.data && e.data.ruleId === 'html/eds-structural-contract',
  ));
  assert.ok(structural, 'expected EDS structural contract finding');
  assert.deepStrictEqual(structural.metric, ['CLS', 'LCP']);
  assert.strictEqual(structural.rootCause, true);
  assert.strictEqual(structural.structuralGate.result, 'fail');
  assert.ok(
    structural.structuralGate.reasons.some((reason) => /meaningful section/i.test(reason)),
    `expected meaningful-section depth reason, got ${JSON.stringify(structural.structuralGate.reasons)}`,
  );
  const evidence = structural.evidence.find((e) => e.data && e.data.ruleId === 'html/eds-structural-contract');
  assert.strictEqual(evidence.data.context.sectionCount, 6);
  assert.strictEqual(evidence.data.context.firstMeaningfulSection.index, 6);
  assert.ok(evidence.data.context.placeholderSectionsBeforeMeaningful >= 3);
  assert.ok(evidence.data.context.tabShellSectionsBeforeMeaningful >= 1);
  assert.ok(evidence.data.context.revealRuleSignals.viewblockDisplayBlock);
  assert.ok(evidence.data.context.headerOverlayHints.overlayLikely);
  assert.ok(
    structural.structuralGate.reasons.some((reason) => /Header HTML\/CSS/i.test(reason)),
    `expected header overlay reason, got ${JSON.stringify(structural.structuralGate.reasons)}`,
  );
}

async function test3e_cleanEdsStructureDoesNotFireGate() {
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles/styles.css">
<script src="/scripts/scripts.js" type="module"></script>
<style>body:not(.appear) main { display: none; }</style>
</head><body>
<main>
  <div class="section hero">
    <h1>Real hero content</h1>
    <picture><img src="/hero.jpg" width="1200" height="600" fetchpriority="high"></picture>
    <p>The first section contains the content users see first, with enough copy
    to be considered meaningful by the static analyzer.</p>
  </div>
  <div class="section"><p>Below fold supporting content.</p></div>
</main>
</body></html>`;

  const { findings, meta } = await analyzeHtml(html, { url: 'https://example.com/', fromString: true });
  assertFindingsValid(findings, 'test3e');
  assert.strictEqual(meta.stack && meta.stack.eds, true, 'expected EDS stack detection in meta');
  const ids = ruleIds(findings);
  assert.ok(!ids.has('html/eds-structural-contract'), 'clean EDS page should not fail structural gate');
}

async function test3f_preventFoucCommentDoesNotImplyRemovedGate() {
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="/scripts/scripts.js" type="module"></script>
<style>
/* keep body:not(.appear) main hidden to prevent FOUC */
body:not(.appear) main { display: none; }
</style>
</head><body>
<main>
  <div class="section hero">
    <h1>Real hero content</h1>
    <picture><img src="/hero.jpg" width="1200" height="600" fetchpriority="high"></picture>
    <p>The first section contains meaningful content and the comment only
    documents why the standard EDS reveal gate exists.</p>
  </div>
</main>
</body></html>`;

  const { findings, meta } = await analyzeHtml(html, { url: 'https://example.com/', fromString: true });
  assertFindingsValid(findings, 'test3f');
  assert.strictEqual(meta.structuralGate.result, 'pass');
  assert.strictEqual(meta.structuralGate.reasons.length, 0);
  const ids = ruleIds(findings);
  assert.ok(!ids.has('html/eds-structural-contract'), 'benign prevent-FOUC comment should not fail structural gate');
}

async function test4_cleanPageFiresFewRules() {
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preload" as="style" href="/styles.css">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/favicon.ico">
<script src="/app.js" defer></script>
</head><body>
<img src="/hero.jpg" width="1200" height="600" fetchpriority="high" alt="hero">
</body></html>`;

  const { findings } = await analyzeHtml(html, { url: URL, fromString: true });
  assertFindingsValid(findings, 'test4');
  const ids = ruleIds(findings);
  assert.ok(!ids.has('html/blocking-script-in-head'), 'deferred script should not fire blocking-script rule');
  assert.ok(!ids.has('html/missing-viewport-meta'), 'viewport present, should not fire');
  assert.ok(!ids.has('html/img-missing-dimensions'), 'dimensions present, should not fire');
  assert.ok(!ids.has('html/lcp-candidate-missing-fetchpriority'), 'fetchpriority present, should not fire');
  assert.ok(!ids.has('html/stylesheet-not-preloaded'), 'preload link present, should not fire');
  assert.ok(!ids.has('html/favicon-before-stylesheet'), 'favicon after css, should not fire');
}

// --------------------------------------------------------------------------
// Regression tests for HTML entity decoding + CSS selector escaping.
// Bug: attribute values containing `&amp;` (and similar entities) were used
// verbatim in CSS selectors and in evidence URLs, so downstream URL-to-URL
// comparisons (e.g. matching a finding's patched image against a real
// network request) never matched. Fix: decode entities centrally in
// parseAttrs, and escape `"`/`\` when interpolating into attribute
// selectors.
// --------------------------------------------------------------------------

function test5_decodeHtmlEntitiesUnit() {
  assert.strictEqual(decodeHtmlEntities('/p?a=1&amp;b=2'), '/p?a=1&b=2', 'named &amp;');
  assert.strictEqual(decodeHtmlEntities('a&lt;b&gt;c'), 'a<b>c', 'named &lt;/&gt;');
  assert.strictEqual(decodeHtmlEntities('&#64;'), '@', 'decimal numeric ref');
  assert.strictEqual(decodeHtmlEntities('&#x2F;path'), '/path', 'hex numeric ref');
  assert.strictEqual(decodeHtmlEntities('nothing here'), 'nothing here', 'no-entity pass-through');
  // Unknown entity left intact (no crash).
  assert.strictEqual(decodeHtmlEntities('&notAnEntity;'), '&notAnEntity;', 'unknown entity preserved');
  // Chained: entity-in-middle-of-URL.
  assert.strictEqual(
    decodeHtmlEntities('https://cdn.example.com/img?w=200&amp;h=100&amp;fit=crop'),
    'https://cdn.example.com/img?w=200&h=100&fit=crop',
    'multiple &amp; in URL',
  );
}

function test6_cssEscapeAttrValueUnit() {
  assert.strictEqual(cssEscapeAttrValue('/plain.jpg'), '/plain.jpg', 'no special chars untouched');
  assert.strictEqual(cssEscapeAttrValue('/p?a=1&b=2'), '/p?a=1&b=2', '& is safe inside "..."');
  assert.strictEqual(cssEscapeAttrValue('a"b'), 'a\\"b', 'quote must be escaped');
  assert.strictEqual(cssEscapeAttrValue('a\\b'), 'a\\\\b', 'backslash must be escaped');
  // Order matters: backslash escaped first, then quote (no double-escape).
  assert.strictEqual(cssEscapeAttrValue('a\\"b'), 'a\\\\\\"b', 'combined \\ and " escaped in order');
}

async function test7_imgSrcWithAmpInPatchSelector() {
  // Source HTML has `&amp;` in the img src query string. After the fix,
  // the patch selector should carry the DECODED `&`, matching what a real
  // browser sees in the DOM.
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/s.css">
</head><body>
<img src="/hero.jpg?w=1200&amp;h=600" alt="hero">
</body></html>`;

  const { findings } = await analyzeHtml(html, { url: URL, fromString: true });
  assertFindingsValid(findings, 'test7');
  const lcp = findings.find((f) => f.evidence.some(
    (e) => e.data && e.data.ruleId === 'html/lcp-candidate-missing-fetchpriority',
  ));
  assert.ok(lcp, 'expected lcp-candidate finding');
  const selector = lcp.patches.markup[0].selector;
  assert.ok(
    selector.includes('/hero.jpg?w=1200&h=600'),
    `patch selector should carry decoded '&', got: ${selector}`,
  );
  assert.ok(
    !selector.includes('&amp;'),
    `patch selector must not contain raw '&amp;', got: ${selector}`,
  );
  // Evidence URL must also be decoded (so it matches real network URLs).
  const resourceTiming = lcp.evidence.find((e) => e.kind === 'resource-timing');
  assert.ok(resourceTiming, 'expected resource-timing evidence');
  assert.ok(
    !resourceTiming.data.url.includes('&amp;'),
    `evidence URL must be decoded, got: ${resourceTiming.data.url}`,
  );
  assert.ok(
    resourceTiming.data.url.includes('w=1200&h=600'),
    `evidence URL should have decoded query, got: ${resourceTiming.data.url}`,
  );
}

async function test8_preconnectSelectorWithAmpInHref() {
  // DEFERRABLE host reached via a tracker URL with `&amp;` in it.
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://www.google-analytics.com/?id=1&amp;v=2">
<link rel="stylesheet" href="/s.css">
</head><body><p>ok</p></body></html>`;

  const { findings } = await analyzeHtml(html, { url: URL, fromString: true });
  assertFindingsValid(findings, 'test8');
  const pc = findings.find((f) => f.evidence.some(
    (e) => e.data && e.data.ruleId === 'html/preconnect-to-deferrable',
  ));
  assert.ok(pc, 'expected preconnect-to-deferrable finding');
  const selector = pc.patches.markup[0].selector;
  assert.ok(
    !selector.includes('&amp;'),
    `preconnect patch selector must not contain raw '&amp;', got: ${selector}`,
  );
  assert.ok(
    selector.includes('id=1&v=2'),
    `preconnect patch selector should have decoded '&', got: ${selector}`,
  );
}

async function test9_scriptSrcSelectorWithEntityEscapedQuote() {
  // Pathological but legal: the blocking-script src attribute encodes
  // a literal quote via `&quot;`. After decode the value contains `"`,
  // which MUST be backslash-escaped in the CSS selector to stay valid.
  const html = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="/weird&quot;name.js"></script>
</head><body><p>ok</p></body></html>`;

  const { findings } = await analyzeHtml(html, { url: URL, fromString: true });
  assertFindingsValid(findings, 'test9');
  const blocking = findings.find((f) => f.evidence.some(
    (e) => e.data && e.data.ruleId === 'html/blocking-script-in-head',
  ));
  assert.ok(blocking, 'expected blocking-script finding');
  const selector = blocking.patches.markup[0].selector;
  // The decoded value contains a `"`, which must be backslash-escaped.
  assert.ok(
    selector.includes('\\"'),
    `selector must backslash-escape '"', got: ${selector}`,
  );
  // Selector should still parse to a valid attribute selector pattern.
  assert.ok(
    /^script\[src=".*"\]$/.test(selector),
    `selector should match script[src="..."] shape, got: ${selector}`,
  );
}

function test10_parseAttrsDecodesInline() {
  // End-to-end via parseAttrs: decoded value is what downstream code reads.
  const attrs = parseAttrs(' href="/p?a=1&amp;b=2" data-label="A&amp;B"');
  assert.strictEqual(attrs.href, '/p?a=1&b=2', 'parseAttrs should decode href');
  assert.strictEqual(attrs['data-label'], 'A&B', 'parseAttrs should decode data-label');
}

function test11_buildErrorEnvelopeForFetchFailure() {
  const err = new Error('fetch failed: 403 Forbidden');
  const envelope = buildErrorEnvelope({ url: 'https://blocked.example/page' }, err);
  assert.strictEqual(envelope.schemaVersion, '1.0');
  assert.strictEqual(envelope.skill, 'cwv-diagnose');
  assert.strictEqual(envelope.url, 'https://blocked.example/page');
  assert.deepStrictEqual(envelope.findings, []);
  assert.ok(envelope.summary.includes('html-parse failed'), `summary=${envelope.summary}`);
  assert.strictEqual(envelope.meta.error.message, 'fetch failed: 403 Forbidden');
  assert.strictEqual(envelope.meta.fetchedFrom, 'https://blocked.example/page');
}

async function run() {
  const tests = [
    test1_blockingScriptAndViewportAndFavicon,
    test2_imgDimensionsAndLcpFetchPriority,
    test2b_trackingPixelNotFlaggedAsClsSource,
    test3_preconnectDeferrableAndInlineScript,
    test3b_inlineSvgPayload,
    test3bb_inlineSvgPayloadCrossingEarlyWindow,
    test3bc_inlineSvgPayloadAggregateThreshold,
    test3c_tinyInlineSvgIgnored,
    test3d_edsStructuralContractFailure,
    test3e_cleanEdsStructureDoesNotFireGate,
    test3f_preventFoucCommentDoesNotImplyRemovedGate,
    test4_cleanPageFiresFewRules,
    test5_decodeHtmlEntitiesUnit,
    test6_cssEscapeAttrValueUnit,
    test7_imgSrcWithAmpInPatchSelector,
    test8_preconnectSelectorWithAmpInHref,
    test9_scriptSrcSelectorWithEntityEscapedQuote,
    test10_parseAttrsDecodesInline,
    test11_buildErrorEnvelopeForFetchFailure,
  ];
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      process.stdout.write(`ok - ${t.name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`not ok - ${t.name}: ${err.message}\n`);
      if (err.stack) process.stderr.write(err.stack + '\n');
    }
  }
  if (failed > 0) {
    process.stderr.write(`${failed} test(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write('all html-parse tests passed\n');
}

run();
