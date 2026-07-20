#!/usr/bin/env node

/**
 * Tests for cls-variance.js (ROADMAP V4).
 *
 * Acceptance (real the news-site case fixture, 10 pooled no-patch runs):
 *   - `.cookies__container` classifies STABLE and is the recommended --cls-source
 *     (mean clsShare ~0.14 under oracle substring-sum semantics).
 *   - `list__wrapper` and `cmp-template-grid>article` classify VOLATILE.
 *   - the page is flagged total-CLS noise-dominated (total-CLS range >> MIN_IMPACT.CLS).
 *
 * Plus synthetic unit cases isolating each gate (presence, spread, sample-count),
 * the noise-dominated threshold, the oracle-token re-validation guard, and
 * empty/malformed-input safety.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeClsVariance,
  clsSourceSig,
  oracleToken,
  PRESENCE_MIN,
} from '../cls-variance.js';
import { MIN_IMPACT } from '../finding-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'cls-baseline-10run.json');

const close = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// Build a launcher-shaped JSON from a list of runs, each run = array of
// [node, clsShare] source pairs. Total cls.value defaults to the source sum.
function launcher(runs, { url = 'https://x.test', profile = 'mobile-slow4g-4xcpu' } = {}) {
  return {
    url,
    profile,
    runs: runs.map((sources) => {
      const shiftSources = sources.map(([node, clsShare]) => ({ node, clsShare }));
      const value = shiftSources.reduce((a, s) => a + s.clsShare, 0);
      return { cwv: { cls: { value: Number(value.toFixed(4)), shiftSources } } };
    }),
  };
}

// -- helpers ---------------------------------------------------------------

test('clsSourceSig normalizes a node to a stable cross-run signature', () => {
  assert.strictEqual(
    clsSourceSig(
      'div#container-32e9778d0f > div.grid.grid--12 > div.t004-cookie.grid-column > section.cookies__container.font-lato',
    ),
    't004-cookie>cookies__container',
  );
  assert.strictEqual(
    clsSourceSig(
      'div.template-container > div.has-desktop-width > div > section.cmp-template-grid.cmp-template-grid__container__column-4x4x4 > article',
    ),
    'cmp-template-grid>article',
  );
  // Utility/layout/font/grid-spec classes are dropped; tag is the fallback.
  assert.strictEqual(clsSourceSig('div.grid > div.font-bold'), 'div>div');
});

test('oracleToken derives the leaf-most class token from a sig', () => {
  assert.strictEqual(oracleToken('t004-cookie>cookies__container'), 'cookies__container');
  assert.strictEqual(oracleToken('cmp-template-grid>article'), 'article');
  assert.strictEqual(oracleToken('hero>banner'), 'banner');
});

// -- acceptance: real the news-site case pooled baseline -------------------------------

test('the news-site case acceptance — banner stable & recommended, content volatile, noise-dominated', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const r = analyzeClsVariance([fixture]);

  assert.strictEqual(r.runs, 10, 'pools all 10 runs');

  // Total-CLS noise floor is the run-to-run range; the news-site case ~0.198 >> 0.03 floor.
  assert.ok(close(r.noiseFloor, 0.1981, 0.01), `noiseFloor ${r.noiseFloor} ~ 0.198`);
  assert.strictEqual(r.noiseDominated, true, 'total CLS is noise-dominated');
  assert.strictEqual(r.minActionableImpact, MIN_IMPACT.CLS.delta);

  const bySig = (needle) => r.sources.find((s) => s.sig.includes(needle));

  // The consent banner: present every run, tight spread → STABLE.
  const cookies = bySig('cookies__container');
  assert.ok(cookies, 'cookies__container source present');
  assert.strictEqual(cookies.stable, true, 'cookies__container is stable');
  assert.strictEqual(cookies.present, 10);

  // The editorial content sources swing 0 → ~0.22 across runs → VOLATILE.
  const list = bySig('list__wrapper');
  assert.ok(list, 'list__wrapper source present');
  assert.strictEqual(list.stable, false, 'list__wrapper is volatile');

  const grid = bySig('cmp-template-grid');
  assert.ok(grid, 'cmp-template-grid source present');
  assert.strictEqual(grid.stable, false, 'cmp-template-grid>article is volatile (presence gate)');

  // Recommended --cls-source must (a) exist, (b) be an oracle substring that
  // captures the banner, (c) measure as the stable ~0.14 contribution.
  assert.ok(r.recommendedClsSource, 'a stable target is recommended');
  assert.ok(
    'div.t004-cookie.grid-column > section.cookies__container.font-lato'.includes(
      r.recommendedClsSource,
    ),
    `recommended token "${r.recommendedClsSource}" matches the banner node`,
  );
  assert.ok(r.recommendation, 'recommendation block present');
  assert.ok(
    close(r.recommendation.mean, 0.14, 0.01),
    `recommendation mean ${r.recommendation.mean} ~ 0.14 (oracle substring-sum)`,
  );
  assert.strictEqual(r.recommendation.stable, true);
});

// -- synthetic gate isolation ---------------------------------------------

test('a tight, ever-present source is stable, recommended, and not noise-dominated', () => {
  const lj = launcher([
    [['div.hero > img.lcp', 0.05]],
    [['div.hero > img.lcp', 0.05]],
    [['div.hero > img.lcp', 0.051]],
    [['div.hero > img.lcp', 0.049]],
    [['div.hero > img.lcp', 0.05]],
  ]);
  const r = analyzeClsVariance([lj]);
  const src = r.sources.find((s) => s.sig.includes('lcp'));
  assert.strictEqual(src.stable, true);
  assert.strictEqual(r.noiseDominated, false, 'total CLS range < 0.03');
  assert.ok(r.recommendedClsSource && 'img.lcp'.includes(r.recommendedClsSource));
});

test('presence gate: an intermittent source is volatile even with tight when-present spread', () => {
  // Identical 0.05 when present, but absent in 2 of 5 runs → present 3/5 = 0.6 < 0.8.
  // IQR over [0,0,0.05,0.05,0.05] is below the 0.1 CLS floor, so only the
  // presence gate can catch it.
  const lj = launcher([
    [['ul.list > li.card', 0.05]],
    [['ul.list > li.card', 0.05]],
    [['ul.list > li.card', 0.05]],
    [['div.other > p.x', 0.01]],
    [['div.other > p.x', 0.01]],
  ]);
  const r = analyzeClsVariance([lj]);
  const card = r.sources.find((s) => s.sig.includes('card'));
  assert.ok(card.present / card.n < PRESENCE_MIN, 'card present below threshold');
  assert.strictEqual(card.stable, false, 'intermittent source is volatile');
});

test('sample-count gate: fewer than 3 runs cannot be classified stable', () => {
  const lj = launcher([
    [['div.a > b.c', 0.05]],
    [['div.a > b.c', 0.05]],
  ]);
  const r = analyzeClsVariance([lj]);
  assert.strictEqual(r.runs, 2);
  assert.ok(r.sources.every((s) => s.stable === false), 'no stable source on <3 runs');
  assert.strictEqual(r.recommendedClsSource, null, 'nothing recommended on too-few runs');
  assert.strictEqual(r.insufficientRuns, true);
});

test('noise-dominated flag keys off MIN_IMPACT.CLS.delta', () => {
  // Same single stable source, but total CLS swings via an unattributed remainder
  // pushing the run-to-run range past 0.03.
  const big = {
    url: 'https://x.test',
    profile: 'mobile-slow4g-4xcpu',
    runs: [
      { cwv: { cls: { value: 0.20, shiftSources: [{ node: 'div.x > i.y', clsShare: 0.05 }] } } },
      { cwv: { cls: { value: 0.05, shiftSources: [{ node: 'div.x > i.y', clsShare: 0.05 }] } } },
      { cwv: { cls: { value: 0.21, shiftSources: [{ node: 'div.x > i.y', clsShare: 0.05 }] } } },
      { cwv: { cls: { value: 0.06, shiftSources: [{ node: 'div.x > i.y', clsShare: 0.05 }] } } },
      { cwv: { cls: { value: 0.20, shiftSources: [{ node: 'div.x > i.y', clsShare: 0.05 }] } } },
    ],
  };
  const r = analyzeClsVariance([big]);
  assert.ok(r.noiseFloor > MIN_IMPACT.CLS.delta);
  assert.strictEqual(r.noiseDominated, true);
});

test('oracle-token re-validation guard: never recommend a token whose substring-sum is volatile', () => {
  // Source A ("foo-card") is itself ever-present & tight, but a VOLATILE sibling
  // B ("foo-wrap") shares the "foo" substring. A naive leaf token of "foo-card"
  // is fine; but if the analyzer recommended the broader "foo", oracle's
  // substring-sum would pull in B and be volatile. Invariant: whatever is
  // recommended must measure stable under oracle substring-sum.
  const lj = launcher([
    [['div.foo-card', 0.05], ['section.foo-wrap', 0.20]],
    [['div.foo-card', 0.05], ['section.foo-wrap', 0.00]],
    [['div.foo-card', 0.05], ['section.foo-wrap', 0.18]],
    [['div.foo-card', 0.05], ['section.foo-wrap', 0.00]],
    [['div.foo-card', 0.051], ['section.foo-wrap', 0.19]],
  ]);
  const r = analyzeClsVariance([lj]);
  if (r.recommendedClsSource) {
    // Recompute oracle substring-sum for the recommended token across runs.
    const samples = lj.runs.map((run) =>
      run.cwv.cls.shiftSources
        .filter((s) => s.node.includes(r.recommendedClsSource))
        .reduce((a, s) => a + s.clsShare, 0),
    );
    const span = Math.max(...samples) - Math.min(...samples);
    assert.ok(span <= 0.1, `recommended token substring-sum must be stable (span ${span})`);
  }
});

test('pools runs across multiple launcher files', () => {
  const a = launcher([[['div.a > b.c', 0.05]], [['div.a > b.c', 0.05]]]);
  const b = launcher([[['div.a > b.c', 0.05]], [['div.a > b.c', 0.05]], [['div.a > b.c', 0.05]]]);
  const r = analyzeClsVariance([a, b]);
  assert.strictEqual(r.runs, 5, 'pools 2 + 3 runs');
  const src = r.sources.find((s) => s.sig.includes('c'));
  assert.strictEqual(src.stable, true);
});

test('empty and malformed inputs degrade safely (no throw)', () => {
  for (const input of [[], [{}], [{ runs: [] }], [{ runs: [{ cwv: {} }] }], null]) {
    const r = analyzeClsVariance(input);
    assert.strictEqual(r.recommendedClsSource, null);
    assert.strictEqual(r.noiseDominated, false);
    assert.ok(Array.isArray(r.sources));
  }
});
