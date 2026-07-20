
import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as a from '../attribution.js';
import { validateFinding, OWNERS } from '../finding-schema.js';

const PLAYBOOKS_DIR = path.join(__dirname, '..', '..', 'references', 'playbooks');
const FIXTURE = path.join(__dirname, 'fixtures', 'attribution-findings.json');

function loadFixtureEnvelope() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}
function bannerFinding() {
  return loadFixtureEnvelope().findings.find((f) => f.id === 'diagnose-cls-c6-1');
}
function gtagFinding() {
  return loadFixtureEnvelope().findings.find((f) => f.id === 'diagnose-lcp-c2-2');
}

// ---------------------------------------------------------------------------
// Playbook front-matter parser
// ---------------------------------------------------------------------------

test('parsePlaybookFrontmatter parses every vendored playbook coherently', () => {
  const files = fs.readdirSync(PLAYBOOKS_DIR)
    .filter((f) => f.endsWith('.md') && f !== '_FORMAT.md' && f !== 'README.md');
  assert.ok(files.length >= 19, `expected the vendored playbooks, found ${files.length}`);
  for (const file of files) {
    const text = fs.readFileSync(path.join(PLAYBOOKS_DIR, file), 'utf8');
    const fm = a.parsePlaybookFrontmatter(text);
    assert.ok(fm, `${file}: front matter must parse`);
    assert.equal(fm.issueType, file.replace(/\.md$/, ''), `${file}: issue_type must match filename`);
    assert.ok(Array.isArray(fm.applicableFlavors) && fm.applicableFlavors.length > 0,
      `${file}: applicable_flavors must be a non-empty list`);
    for (const fl of fm.applicableFlavors) {
      assert.ok(a.FLAVORS.includes(fl), `${file}: "${fl}" is not a known flavor`);
    }
    assert.ok(['low', 'medium', 'high'].includes(fm.riskTier), `${file}: risk_tier must be low|medium|high`);
    for (const ft of fm.forbiddenTechniques) {
      assert.ok(ft && typeof ft.pattern === 'string' && ft.pattern, `${file}: forbidden_techniques needs a pattern`);
      assert.ok(typeof ft.reason === 'string' && ft.reason, `${file}: forbidden_techniques needs a reason`);
    }
  }
});

test('parsePlaybookFrontmatter reads the layout-shift contract exactly', () => {
  const text = fs.readFileSync(path.join(PLAYBOOKS_DIR, 'layout-shift.md'), 'utf8');
  const fm = a.parsePlaybookFrontmatter(text);
  assert.deepEqual(fm.applicableFlavors, ['eds', 'cs']);
  assert.equal(fm.riskTier, 'medium');
  assert.deepEqual(fm.requiredValidation, ['cls_element_attribution_available', 'shifting_element_classified']);
  assert.equal(fm.forbiddenTechniques.length, 2);
  assert.match(fm.forbiddenTechniques[0].pattern, /font-display/);
});

test('parsePlaybookFrontmatter handles nested flavor_overrides + on_flavors + comments', () => {
  const text = [
    '---',
    'issue_type: demo',
    'applicable_flavors: [eds, cs, ams]   # inline comment ignored',
    'risk_tier: medium',
    'required_validation:',
    '  - first_check',
    '  - second_check',
    'forbidden_techniques:',
    "  - pattern: 'rel\\s*=\\s*\"preload\"'  # quoted # stays",
    '    reason: "no preload"',
    '    on_flavors: [eds]',
    '  # standalone comment line',
    "  - pattern: 'media=\"print\"'",
    '    reason: "no print hack"',
    'flavor_overrides:',
    '  cs:',
    '    extra_validation:',
    '      - cs_only_check',
    '  ams:',
    '    extra_validation:',
    '      - ams_only_check',
    '---',
    '# body starts here',
  ].join('\n');
  const fm = a.parsePlaybookFrontmatter(text);
  assert.deepEqual(fm.applicableFlavors, ['eds', 'cs', 'ams']);
  assert.deepEqual(fm.requiredValidation, ['first_check', 'second_check']);
  assert.equal(fm.forbiddenTechniques.length, 2);
  assert.deepEqual(fm.forbiddenTechniques[0].on_flavors, ['eds']);
  assert.match(fm.forbiddenTechniques[0].pattern, /preload/);
  assert.deepEqual(fm.flavorOverrides.cs.extra_validation, ['cs_only_check']);
  assert.deepEqual(fm.flavorOverrides.ams.extra_validation, ['ams_only_check']);
});

test('loadPlaybook returns null for an unknown issue type, parsed for a known one', () => {
  assert.equal(a.loadPlaybook('does-not-exist'), null);
  const pb = a.loadPlaybook('lcp-image');
  assert.ok(pb && pb.frontmatter);
  assert.deepEqual(pb.frontmatter.applicableFlavors, ['eds', 'cs', 'ams']);
});

// ---------------------------------------------------------------------------
// Flavor normalization
// ---------------------------------------------------------------------------

test('normalizeFlavor maps SpaceCat deliveryType + stack-doc names', () => {
  assert.equal(a.normalizeFlavor('aem_cs'), 'cs');
  assert.equal(a.normalizeFlavor('aem-cs'), 'cs');
  assert.equal(a.normalizeFlavor('cs'), 'cs');
  assert.equal(a.normalizeFlavor('cloud_service'), 'cs');
  assert.equal(a.normalizeFlavor('aem_edge'), 'eds');
  assert.equal(a.normalizeFlavor('aem_eds'), 'eds');
  assert.equal(a.normalizeFlavor('eds'), 'eds');
  assert.equal(a.normalizeFlavor('franklin'), 'eds');
  assert.equal(a.normalizeFlavor('aem_ams'), 'ams');
  assert.equal(a.normalizeFlavor('ams'), 'ams');
  assert.equal(a.normalizeFlavor('headless'), 'headless');
  assert.equal(a.normalizeFlavor('wordpress'), null);
  assert.equal(a.normalizeFlavor(''), null);
  assert.equal(a.normalizeFlavor(null), null);
});

// ---------------------------------------------------------------------------
// Playbook-guided diagnosis: which playbooks apply to a metric
// ---------------------------------------------------------------------------

test('playbooksForMetric returns CLS router with layout-shift first', () => {
  const pbs = a.playbooksForMetric('CLS', 'cs');
  assert.equal(pbs[0].issueType, 'layout-shift');
  assert.equal(pbs[0].applicable, true, 'layout-shift applies to cs');
  const onAms = a.playbooksForMetric('CLS', 'ams');
  assert.equal(onAms[0].applicable, false, 'layout-shift is recommend-only/N-A on ams');
});

test('playbooksForMetric flags EDS-excluded TTFB types', () => {
  const pbs = a.playbooksForMetric('TTFB', 'eds');
  // ttfb + compression both exclude eds (platform-managed)
  for (const p of pbs) assert.equal(p.applicable, false, `${p.issueType} should be N/A on eds`);
});

// ---------------------------------------------------------------------------
// Issue-type inference
// ---------------------------------------------------------------------------

test('classifyFindingIssueType routes the banner CLS finding to layout-shift', () => {
  assert.equal(a.classifyFindingIssueType(bannerFinding()), 'layout-shift');
});

test('classifyFindingIssueType distinguishes image-sizing and font CLS', () => {
  const imgCls = {
    metric: ['CLS'], cause: 'image missing width and height attributes',
    evidence: [{ kind: 'cwv-attribution', data: { target: 'img.hero' } }],
    patches: { markup: [{ selector: 'img.hero', attrs: { width: '800', height: '600' } }] },
  };
  assert.equal(a.classifyFindingIssueType(imgCls), 'image-sizing');
  const fontCls = {
    metric: ['CLS'], cause: 'web-font swap reflow (FOUT) on the heading',
    evidence: [{ kind: 'cwv-attribution', data: { target: 'h1.title' } }],
    patches: { markup: [{ selector: 'h1', attrs: { style: 'font-display:optional' } }] },
  };
  assert.equal(a.classifyFindingIssueType(fontCls), 'font-fallback');
});

// ---------------------------------------------------------------------------
// Owner classification — the five owners
// ---------------------------------------------------------------------------

test('ACCEPTANCE: otempo cookie-banner CLS on AEM CS is customer-implementation, not platform', () => {
  const r = a.classifyOwner(bannerFinding(), { flavor: 'aem_cs' });
  // The literal customer question: it is the customer's own component, not AEM.
  assert.equal(r.owner, 'customer-code');
  assert.notEqual(r.owner, 'platform-default');
  assert.notEqual(r.owner, 'dispatcher-cdn');
  assert.notEqual(r.owner, 'third-party');
  assert.equal(r.flavor, 'cs');
  // The CLS path consulted layout-shift.md.
  assert.equal(r.issueType, 'layout-shift');
  assert.ok(r.signals.some((s) => /consulted playbook "layout-shift"/.test(s)),
    `expected a layout-shift playbook signal, got: ${JSON.stringify(r.signals)}`);
  assert.ok(r.signals.some((s) => /applies to "cs"/.test(s)));
  assert.match(r.rationale, /customer/i);
});

test('attributeFinding tags the banner finding and stays schema-valid', () => {
  const out = a.attributeFinding(bannerFinding(), { flavor: 'aem_cs' });
  assert.equal(out.owner, 'customer-code');
  assert.equal(out.ownership.owner, 'customer-code');
  assert.equal(out.ownership.playbook, 'layout-shift');
  assert.equal(out.ownership.flavor, 'cs');
  assert.ok(typeof out.ownership.confidence === 'number');
  const v = validateFinding(out);
  assert.ok(v.valid, `attributed finding must validate: ${v.errors.join('; ')}`);
});

test('third-party resource in evidence → third-party owner', () => {
  const r = a.classifyOwner(gtagFinding(), { flavor: 'cs' });
  assert.equal(r.owner, 'third-party');
  assert.ok(r.signals.some((s) => /googletagmanager\.com/.test(s)));
});

test('Adobe Launch/DTM resource → third-party with requires-launch-rule', () => {
  const f = {
    metric: ['INP'], cause: 'tag manager bootstrap on the main thread',
    recommendation: 'defer analytics',
    evidence: [{ kind: 'resource-timing', data: { url: 'https://assets.adobedtm.com/launch-EN1234.min.js', type: 'script' } }],
  };
  const r = a.classifyOwner(f, { flavor: 'cs' });
  assert.equal(r.owner, 'third-party');
  assert.equal(r.deliveryConstraint, 'requires-launch-rule');
});

test('platform-default: playbook excludes the flavor (compression on EDS)', () => {
  const f = {
    metric: ['TTFB'], cause: 'response is not compressed',
    recommendation: 'enable brotli',
    evidence: [{ kind: 'resource-timing', data: { url: 'https://main--site--owner.hlx.live/styles.css' } }],
  };
  const r = a.classifyOwner(f, { flavor: 'eds', issueType: 'compression' });
  assert.equal(r.owner, 'platform-default');
  assert.equal(r.deliveryConstraint, 'requires-operator');
  assert.ok(r.signals.some((s) => /does not list flavor "eds"/.test(s)));
});

test('platform-default: EDS finding naming head.html / auto Link preload', () => {
  const f = {
    metric: ['LCP'], cause: 'LCP image discovered late',
    recommendation: 'EDS emits a Link: rel=preload header automatically; the head.html is fixed and cannot take a per-page preload',
    evidence: [{ kind: 'cwv-attribution', metric: 'LCP', data: { target: 'img.hero' } }],
  };
  const r = a.classifyOwner(f, { flavor: 'eds' }); // issueType infers lcp-image (applies to eds, so S3a won't fire) → S3b fires
  assert.equal(r.owner, 'platform-default');
});

test('dispatcher-cdn: TTFB on AMS with X-Cache MISS, requires operator', () => {
  const f = {
    metric: ['TTFB'], cause: 'Dispatcher cache miss; publish tier render dominates TTFB',
    recommendation: 'tune dispatcher cache rules',
    evidence: [{ kind: 'har-entry', data: { url: 'https://www.example.com/page.html' } }],
  };
  const r = a.classifyOwner(f, { flavor: 'ams', responseHeaders: { 'X-Cache': 'MISS', 'X-Dispatcher': 'miss' } });
  assert.equal(r.owner, 'dispatcher-cdn');
  assert.equal(r.deliveryConstraint, 'requires-operator');
  assert.ok(r.signals.some((s) => /caching-layer signal|caching & edge/.test(s)));
});

test('customer-content: authored DAM image missing dimensions', () => {
  const f = {
    metric: ['CLS'], cause: 'image missing width/height attributes',
    recommendation: 'set explicit width and height on the authored image',
    evidence: [
      { kind: 'cwv-attribution', metric: 'CLS', data: { target: 'img.article-hero' } },
      { kind: 'resource-timing', data: { url: 'https://www.example.com/content/dam/site/hero.jpg', type: 'img' } },
    ],
    patches: { markup: [{ selector: 'img.article-hero', attrs: { width: '1200', height: '630' } }] },
  };
  const r = a.classifyOwner(f, { flavor: 'cs' });
  assert.equal(r.owner, 'customer-content');
  assert.ok(r.signals.some((s) => /content\/dam|authoring/.test(s)));
});

test('unknown flavor still classifies (degraded confidence, no crash)', () => {
  const r = a.classifyOwner(bannerFinding(), {});
  assert.ok(OWNERS.includes(r.owner));
  assert.equal(r.flavor, null);
});

// ---------------------------------------------------------------------------
// Envelope-level attribution
// ---------------------------------------------------------------------------

test('attributeEnvelope tags all findings and does not mutate the input', () => {
  const env = loadFixtureEnvelope();
  const before = JSON.stringify(env);
  const out = a.attributeEnvelope(env, { flavor: 'aem_cs' });
  assert.equal(JSON.stringify(env), before, 'input envelope must not be mutated');
  assert.equal(out.findings.length, env.findings.length);
  for (const f of out.findings) assert.ok(OWNERS.includes(f.owner));
  const banner = out.findings.find((f) => f.id === 'diagnose-cls-c6-1');
  assert.equal(banner.owner, 'customer-code');
  const gtag = out.findings.find((f) => f.id === 'diagnose-lcp-c2-2');
  assert.equal(gtag.owner, 'third-party');
});

// ---------------------------------------------------------------------------
// End-to-end: the correlator (C6) attributes the banner shift when given a flavor
// ---------------------------------------------------------------------------

import { correlateChains } from '../analyzers/chain-rum-correlator.js';

function bannerLauncherOutput() {
  return {
    url: 'https://www.otempo.com.br/',
    runs: [{
      cwv: {
        cls: {
          value: 0.30,
          attribution: { loadState: 'complete' },
          shifts: [{
            value: 0.25,
            startTime: 1180,
            hadRecentInput: false,
            sources: [{
              target: '.cookies__container',
              previousRect: { x: 0, y: 560, width: 360, height: 0 },
              currentRect: { x: 0, y: 220, width: 360, height: 340 },
            }],
          }],
        },
      },
      resources: { preLCP: [], postLCP: [], byType: { img: [] } },
    }],
  };
}

test('correlateChains tags C6 banner shift as customer-code when flavor=aem_cs', () => {
  const out = correlateChains({ launcherOutput: bannerLauncherOutput() }, { flavor: 'aem_cs' });
  const c6 = out.findings.find((f) => f.id.includes('-c6-'));
  assert.ok(c6, 'C6 should emit a finding for the banner shift');
  assert.equal(c6.evidence[0].data.target, '.cookies__container');
  assert.equal(c6.owner, 'customer-code');
  assert.equal(c6.ownership.playbook, 'layout-shift');
  assert.match(out.summary, /owner \(cs\):/);
});

test('correlateChains leaves findings unattributed when no flavor is given (backwards-compatible)', () => {
  const out = correlateChains({ launcherOutput: bannerLauncherOutput() });
  const c6 = out.findings.find((f) => f.id.includes('-c6-'));
  assert.ok(c6);
  assert.equal(c6.owner, undefined, 'no owner without a flavor');
  assert.equal(c6.ownership, undefined);
});

// ---------------------------------------------------------------------------
// flavorFromManifest / resolveFlavor — channel-aware flavor (XWalk)
// ---------------------------------------------------------------------------
const _attrTmp = [];
function mkManifestDir(manifest) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cwv-attr-'));
  _attrTmp.push(d);
  if (manifest) fs.writeFileSync(path.join(d, '.cwv-source-manifest.json'), JSON.stringify(manifest));
  return d;
}
process.on('exit', () => { for (const d of _attrTmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

test('flavorFromManifest: aemy channel resolves eds even when deliveryType is aem_cs (XWalk)', () => {
  assert.equal(a.flavorFromManifest(mkManifestDir({ deliveryType: 'aem_cs', channel: 'aemy' })), 'eds');
});

test('flavorFromManifest: cm channel falls back to the deliveryType mapping', () => {
  assert.equal(a.flavorFromManifest(mkManifestDir({ deliveryType: 'aem_cs', channel: 'cm' })), 'cs');
  assert.equal(a.flavorFromManifest(mkManifestDir({ deliveryType: 'aem_edge', channel: 'cm' })), 'eds');
});

test('flavorFromManifest: null with no dir or no manifest', () => {
  assert.equal(a.flavorFromManifest(null), null);
  assert.equal(a.flavorFromManifest(mkManifestDir(null)), null);
});

test('resolveFlavor: an explicit bare flavor wins over the source manifest', () => {
  assert.equal(a.resolveFlavor({ flavor: 'cs', source: mkManifestDir({ deliveryType: 'aem_cs', channel: 'aemy' }) }), 'cs');
});

test('resolveFlavor: a raw deliveryType label loses to the channel-aware manifest (XWalk)', () => {
  assert.equal(a.resolveFlavor({ flavor: 'aem_cs', source: mkManifestDir({ deliveryType: 'aem_cs', channel: 'aemy' }) }), 'eds');
});

test('resolveFlavor: deliveryType honored when no source (back-compat)', () => {
  assert.equal(a.resolveFlavor({ flavor: 'aem_cs', source: null }), 'cs');
  assert.equal(a.resolveFlavor({ flavor: 'aem_edge' }), 'eds');
  assert.equal(a.resolveFlavor({}), null);
});
