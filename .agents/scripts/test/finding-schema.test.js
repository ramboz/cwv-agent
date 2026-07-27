#!/usr/bin/env node

/**
 * Tests for finding-schema.js — focused on the `patches.markup` shape
 * contract. The canonical shape is `{ selector, attrs: { k: v } }`. The
 * legacy analyzer shapes (`action: 'set-attr' | 'setAttribute'` with
 * `attr` / `name` / `value` fields) must be rejected so silent no-ops
 * like the one that caused CLS baseline==treatment on 2026-04-17 fail
 * fast instead of producing misleading results.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateEnvelope, validateFinding } from '../finding-schema.js';

/** Build a minimal schema-valid finding. Patches are attached by the caller. */
function baseFinding(patches) {
  return {
    schemaVersion: '1.0',
    id: 'diagnose-lcp-1',
    timestamp: '2026-04-17T00:00:00.000Z',
    url: 'https://example.com/',
    skill: 'cwv-diagnose',
    source: 'html',
    metric: ['LCP'],
    type: 'opportunity',
    severity: 'medium',
    rootCause: false,
    cause: 'hero image lacks fetchpriority=high',
    evidence: [{ kind: 'rule-violation', data: { ruleId: 'x' } }],
    recommendation: 'set fetchpriority=high on hero image',
    confidence: 0.7,
    impactReduction: { metric: 'LCP', valueMs: 400 },
    status: 'proposed',
    patches,
  };
}

test('canonical markup patch shape passes', () => {
  const f = baseFinding({
    markup: [{ selector: "img[src='/hero.jpg']", attrs: { fetchpriority: 'high' } }],
  });
  const res = validateFinding(f);
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
});

test('canonical attrs may use null to remove an attribute', () => {
  const f = baseFinding({
    markup: [{ selector: 'img.hero', attrs: { loading: null } }],
  });
  const res = validateFinding(f);
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
});

test('rejects legacy action:set-attr + attr/value shape', () => {
  const f = baseFinding({
    markup: [{ selector: 'img.hero', action: 'set-attr', attr: 'fetchpriority', value: 'high' }],
  });
  const res = validateFinding(f);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /action is not part of the canonical shape/i.test(e)));
  assert.ok(res.errors.some((e) => /attr is not part of the canonical shape/i.test(e)));
});

test('rejects legacy action:setAttribute + name/value shape', () => {
  const f = baseFinding({
    markup: [{ selector: "script[src='/a.js']", action: 'setAttribute', name: 'defer', value: '' }],
  });
  const res = validateFinding(f);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /action is not part of the canonical shape/i.test(e)));
  assert.ok(res.errors.some((e) => /name is not part of the canonical shape/i.test(e)));
});

test('rejects markup entry missing attrs', () => {
  const f = baseFinding({
    markup: [{ selector: 'img.hero' }],
  });
  const res = validateFinding(f);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /must include attrs/i.test(e)));
});

test('rejects markup attrs value of invalid type', () => {
  const f = baseFinding({
    markup: [{ selector: 'img.hero', attrs: { fetchpriority: { nested: 'object' } } }],
  });
  const res = validateFinding(f);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /attrs\.fetchpriority/.test(e)));
});

test('rejects markup not being an array', () => {
  const f = baseFinding({ markup: { selector: 'img.hero', attrs: {} } });
  const res = validateFinding(f);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /patches\.markup must be an array/.test(e)));
});

// ---------------------------------------------------------------------------
// `no_op` lifecycle status (oracle NO_OP verdict)
// ---------------------------------------------------------------------------

/** A minimal cwv-validate finding with measurement-delta evidence. */
function validateFindingObj(status) {
  return {
    schemaVersion: '1.0',
    id: 'validate-lcp-1',
    timestamp: '2026-04-17T00:00:00.000Z',
    url: 'https://example.com/',
    skill: 'cwv-validate',
    source: 'har',
    metric: ['LCP'],
    type: 'opportunity',
    severity: 'low',
    rootCause: false,
    cause: 'hero image lacks fetchpriority=high',
    evidence: [{ kind: 'measurement-delta', data: { metric: 'LCP', baseline: 2500, treatment: 2500, deltaMs: 0, runs: 15 } }],
    recommendation: 'set fetchpriority=high on hero image',
    confidence: 0.8,
    impactReduction: { metric: 'LCP', valueMs: 0 },
    status,
  };
}

test('accepts cwv-validate finding with status=no_op', () => {
  const res = validateFinding(validateFindingObj('no_op'));
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
  // no_op findings should not trigger the MIN_ACTIONABLE_IMPACT warning —
  // by definition the patch was a no-op, so "below floor" is expected.
  assert.ok(
    !res.warnings.some((w) => /below MIN_ACTIONABLE_IMPACT/.test(w)),
    `unexpected min-impact warning: ${JSON.stringify(res.warnings)}`,
  );
});

test('allows lifecycle transition applied → no_op', () => {
  const res = validateFinding(validateFindingObj('no_op'), { prevStatus: 'applied' });
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
});

test('rejects lifecycle transition no_op → anything (terminal)', () => {
  const res = validateFinding(validateFindingObj('validated'), { prevStatus: 'no_op' });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /invalid lifecycle transition: no_op/.test(e)));
});

test('does not warn for cwv-fix status=regression', () => {
  const f = {
    ...baseFinding({ markup: [{ selector: 'img.hero', attrs: { fetchpriority: 'high' } }] }),
    id: 'fix-cls-1',
    skill: 'cwv-fix',
    source: 'perf_observer',
    metric: ['CLS'],
    evidence: [{ kind: 'measurement-delta', data: { metric: 'CLS', baseline: 0.2, treatment: 0.1, deltaScore: -0.1, runs: 3, guard: 'load-only-lcp', verdict: 'confirmed-regression' } }],
    impactReduction: { metric: 'CLS', score: 0.1 },
    status: 'regression',
  };
  const res = validateFinding(f);
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
  assert.ok(
    !res.warnings.some((w) => /cwv-fix typically emits/.test(w)),
    `unexpected cwv-fix status warning: ${JSON.stringify(res.warnings)}`,
  );
});

test('accepts cwv-triage envelope with selectedTop handoff contract', () => {
  const env = {
    schemaVersion: '1.0',
    skill: 'cwv-triage',
    url: 'https://example.com/',
    timestamp: '2026-06-20T00:00:00.000Z',
    recommendedProfile: 'mobile-slow4g-4xcpu',
    selectedTop: {
      url: 'https://example.com/load-bearing',
      canonicalUrl: 'https://example.com/load-bearing',
      source: 'rum',
      rank: 2,
      bundleCount: 125,
      sampleCount: 125,
      traffic: { bundleCount: 125 },
      sampleConfidence: 'load-bearing',
      failingMetrics: ['LCP'],
      pressure: 1.28,
      recommendedFormFactor: 'PHONE',
      recommendedProfile: 'mobile-slow4g-4xcpu',
      selectionReason: 'Selected because it is the highest-pressure load-bearing URL.',
    },
    nearMisses: [{
      url: 'https://example.com/outlier',
      canonicalUrl: 'https://example.com/outlier',
      source: 'rum',
      rank: 1,
      bundleCount: 2,
      traffic: { bundleCount: 2 },
      failingMetrics: ['CLS'],
      pressure: 9,
      selectionReason: 'Near miss with directional sample count.',
    }],
    findings: [],
  };
  const res = validateEnvelope(env);
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
});

test('rejects malformed selectedTop handoff contract', () => {
  const env = {
    schemaVersion: '1.0',
    skill: 'cwv-triage',
    url: 'https://example.com/',
    timestamp: '2026-06-20T00:00:00.000Z',
    selectedTop: {
      url: '/relative',
      source: 'rum',
      rank: 0,
      pressure: -1,
      failingMetrics: ['LCP'],
      selectionReason: '',
    },
    findings: [],
  };
  const res = validateEnvelope(env);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /selectedTop\.url/.test(e)));
  assert.ok(res.errors.some((e) => /selectedTop\.rank/.test(e)));
  assert.ok(res.errors.some((e) => /selectionReason/.test(e)));
});

test('rejects selectedTop with empty traffic evidence', () => {
  const env = {
    schemaVersion: '1.0',
    skill: 'cwv-triage',
    url: 'https://example.com/',
    timestamp: '2026-06-20T00:00:00.000Z',
    selectedTop: {
      url: 'https://example.com/load-bearing',
      source: 'rum',
      rank: 1,
      pressure: 1.2,
      traffic: {},
      failingMetrics: ['LCP'],
      recommendedFormFactor: 'PHONE',
      recommendedProfile: 'mobile-slow4g-4xcpu',
      selectionReason: 'Selected because it is the highest-pressure load-bearing URL.',
    },
    findings: [],
  };
  const res = validateEnvelope(env);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /must include traffic, sampleCount, or bundleCount/.test(e)));
});

test('rejects selectedTop with zero-count traffic evidence', () => {
  const env = {
    schemaVersion: '1.0',
    skill: 'cwv-triage',
    url: 'https://example.com/',
    timestamp: '2026-06-20T00:00:00.000Z',
    selectedTop: {
      url: 'https://example.com/load-bearing',
      source: 'rum',
      rank: 1,
      pressure: 1.2,
      traffic: { bundleCount: 0 },
      failingMetrics: ['LCP'],
      recommendedFormFactor: 'PHONE',
      recommendedProfile: 'mobile-slow4g-4xcpu',
      selectionReason: 'Selected because it is the highest-pressure load-bearing URL.',
    },
    findings: [],
  };
  const res = validateEnvelope(env);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /must include traffic, sampleCount, or bundleCount/.test(e)));
});

test('rejects non-passing cwv-triage envelope without selectedTop', () => {
  const env = {
    schemaVersion: '1.0',
    skill: 'cwv-triage',
    url: 'https://example.com/',
    timestamp: '2026-06-20T00:00:00.000Z',
    findings: [],
  };
  const res = validateEnvelope(env);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /selectedTop is required/.test(e)));
});
