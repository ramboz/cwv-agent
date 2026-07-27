
import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
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
    assert.ok(Array.isArray(fm.applicableFlavors),
      `${file}: applicableFlavors must be an array (may be empty — applies everywhere)`);
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
  assert.deepEqual(fm.applicableFlavors, [], 'no stack restriction — applies everywhere');
  assert.equal(fm.riskTier, 'medium');
  assert.deepEqual(fm.requiredValidation, ['cls_element_attribution_available', 'shifting_element_classified']);
  assert.equal(fm.forbiddenTechniques.length, 2);
  assert.match(fm.forbiddenTechniques[0].pattern, /font-display/);
});

test('parsePlaybookFrontmatter handles applicable_stacks + on_stacks + comments', () => {
  const text = [
    '---',
    'issue_type: demo',
    'applicable_stacks: [wordpress, generic]   # inline comment ignored',
    'risk_tier: medium',
    'required_validation:',
    '  - first_check',
    '  - second_check',
    'forbidden_techniques:',
    "  - pattern: 'rel\\s*=\\s*\"preload\"'  # quoted # stays",
    '    reason: "no preload"',
    '  # standalone comment line',
    "  - pattern: 'media=\"print\"'",
    '    reason: "no print hack"',
    '---',
    '# body starts here',
  ].join('\n');
  const fm = a.parsePlaybookFrontmatter(text);
  assert.deepEqual(fm.applicableFlavors, ['wordpress', 'generic']);
  assert.deepEqual(fm.requiredValidation, ['first_check', 'second_check']);
  assert.equal(fm.forbiddenTechniques.length, 2);
  assert.match(fm.forbiddenTechniques[0].pattern, /preload/);
});

test('loadPlaybook returns null for an unknown issue type, parsed for a known one', () => {
  assert.equal(a.loadPlaybook('does-not-exist'), null);
  const pb = a.loadPlaybook('lcp-image');
  assert.ok(pb && pb.frontmatter);
  assert.equal(pb.frontmatter.issueType, 'lcp-image');
});

// ---------------------------------------------------------------------------
// Flavor normalization
// ---------------------------------------------------------------------------

test('normalizeFlavor passes stack names through lower-cased; empty → null', () => {
  assert.equal(a.normalizeFlavor('Generic'), 'generic');
  assert.equal(a.normalizeFlavor('wordpress'), 'wordpress');
  assert.equal(a.normalizeFlavor('  '), null);
  assert.equal(a.normalizeFlavor(''), null);
  assert.equal(a.normalizeFlavor(null), null);
});

test('resolveFlavor: explicit label wins; absent → null', () => {
  assert.equal(a.resolveFlavor({ flavor: 'Generic' }), 'generic');
  assert.equal(a.resolveFlavor({}), null);
});

// ---------------------------------------------------------------------------
// Playbook-guided diagnosis: which playbooks apply to a metric
// ---------------------------------------------------------------------------

test('playbooksForMetric returns CLS router with layout-shift first, all applicable', () => {
  const pbs = a.playbooksForMetric('CLS', null);
  assert.equal(pbs[0].issueType, 'layout-shift');
  assert.equal(pbs[0].applicable, true);
  // With no stack restriction in front matter, every candidate is applicable on any stack.
  for (const p of a.playbooksForMetric('CLS', 'anystack')) {
    assert.equal(p.applicable, true, `${p.issueType} applies everywhere without applicable_stacks`);
  }
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

test('ACCEPTANCE: cookie-banner CLS is site-implementation, not platform', () => {
  const r = a.classifyOwner(bannerFinding(), { flavor: 'generic' });
  // The literal question: it is the site's own component, not the platform.
  assert.equal(r.owner, 'customer-code');
  assert.notEqual(r.owner, 'platform-default');
  assert.notEqual(r.owner, 'cdn-edge');
  assert.notEqual(r.owner, 'third-party');
  assert.equal(r.flavor, 'generic');
  // The CLS path consulted layout-shift.md.
  assert.equal(r.issueType, 'layout-shift');
  assert.ok(r.signals.some((s) => /consulted playbook "layout-shift"/.test(s)),
    `expected a layout-shift playbook signal, got: ${JSON.stringify(r.signals)}`);
  assert.match(r.rationale, /site/i);
});

test('attributeFinding tags the banner finding and stays schema-valid', () => {
  const out = a.attributeFinding(bannerFinding(), { flavor: 'generic' });
  assert.equal(out.owner, 'customer-code');
  assert.equal(out.ownership.owner, 'customer-code');
  assert.equal(out.ownership.playbook, 'layout-shift');
  assert.equal(out.ownership.flavor, 'generic');
  assert.ok(typeof out.ownership.confidence === 'number');
  const v = validateFinding(out);
  assert.ok(v.valid, `attributed finding must validate: ${v.errors.join('; ')}`);
});

test('third-party resource in evidence → third-party owner', () => {
  const r = a.classifyOwner(gtagFinding(), { flavor: 'cs' });
  assert.equal(r.owner, 'third-party');
  assert.ok(r.signals.some((s) => /googletagmanager\.com/.test(s)));
});

test('tag-manager-injected resource → third-party with requires-tag-manager-rule', () => {
  const f = {
    metric: ['INP'], cause: 'tag manager bootstrap on the main thread',
    recommendation: 'defer analytics',
    evidence: [{ kind: 'resource-timing', data: { url: 'https://assets.adobedtm.com/launch-EN1234.min.js', type: 'script' } }],
  };
  const r = a.classifyOwner(f, { flavor: 'cs' });
  assert.equal(r.owner, 'third-party');
  assert.equal(r.deliveryConstraint, 'requires-tag-manager-rule');
});

test('platform-default: playbook applicable_stacks excludes the current stack', () => {
  const f = {
    metric: ['CLS'], cause: 'font swap reflow', recommendation: 'use font-display swap',
    evidence: [{ kind: 'cwv-attribution', data: { target: 'h1.title' } }],
  };
  const r = a.classifyOwner(f, {
    flavor: 'lockedcms',
    issueType: 'font-fallback',
    playbook: { issueType: 'font-fallback', applicableFlavors: ['generic'], riskTier: 'low' },
  });
  assert.equal(r.owner, 'platform-default');
  assert.equal(r.deliveryConstraint, 'requires-operator');
  assert.ok(r.signals.some((s) => /does not list stack "lockedcms"/.test(s)));
});

test('cdn-edge: TTFB with X-Cache MISS is a caching/edge concern', () => {
  const f = {
    metric: ['TTFB'], cause: 'cache miss; origin render dominates TTFB',
    recommendation: 'tune cache rules',
    evidence: [{ kind: 'har-entry', data: { url: 'https://www.example.com/page.html' } }],
  };
  const r = a.classifyOwner(f, { responseHeaders: { 'X-Cache': 'MISS' } });
  assert.equal(r.owner, 'cdn-edge');
  assert.ok(r.signals.some((s) => /caching-layer signal|caching & edge/.test(s)));
});

test('customer-content: authored image missing dimensions', () => {
  const f = {
    metric: ['CLS'], cause: 'image missing width/height attributes',
    recommendation: 'set explicit width and height on the authored image',
    evidence: [
      { kind: 'cwv-attribution', metric: 'CLS', data: { target: 'img.article-hero' } },
      { kind: 'resource-timing', data: { url: 'https://www.example.com/content/dam/site/hero.jpg', type: 'img' } },
    ],
    patches: { markup: [{ selector: 'img.article-hero', attrs: { width: '1200', height: '630' } }] },
  };
  const r = a.classifyOwner(f, { flavor: 'generic' });
  assert.equal(r.owner, 'customer-content');
  assert.ok(r.signals.some((s) => /authoring/.test(s)));
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
  const out = a.attributeEnvelope(env, { flavor: 'generic' });
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
    url: 'https://news.example.com/',
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

test('correlateChains tags C6 banner shift as customer-code when a stack is given', () => {
  const out = correlateChains({ launcherOutput: bannerLauncherOutput() }, { flavor: 'generic' });
  const c6 = out.findings.find((f) => f.id.includes('-c6-'));
  assert.ok(c6, 'C6 should emit a finding for the banner shift');
  assert.equal(c6.evidence[0].data.target, '.cookies__container');
  assert.equal(c6.owner, 'customer-code');
  assert.equal(c6.ownership.playbook, 'layout-shift');
  assert.match(out.summary, /owner \(generic\):/);
});

test('correlateChains leaves findings unattributed when no flavor is given (backwards-compatible)', () => {
  const out = correlateChains({ launcherOutput: bannerLauncherOutput() });
  const c6 = out.findings.find((f) => f.id.includes('-c6-'));
  assert.ok(c6);
  assert.equal(c6.owner, undefined, 'no owner without a flavor');
  assert.equal(c6.ownership, undefined);
});
