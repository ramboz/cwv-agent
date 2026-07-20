#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiagnoseReport,
  buildDiagnoseSpaceCatDraft,
} from '../diagnose-draft.js';

function mkEnvelope() {
  return {
    schemaVersion: '1.0',
    skill: 'cwv-diagnose',
    url: 'https://example.com/product',
    profile: 'mobile-slow4g-4xcpu',
    timestamp: '2026-06-21T00:00:00.000Z',
    findings: [{
      schemaVersion: '1.0',
      id: 'diagnose-lcp-1',
      timestamp: '2026-06-21T00:00:00.000Z',
      url: 'https://example.com/product',
      skill: 'cwv-diagnose',
      source: 'har',
      metric: ['LCP'],
      type: 'opportunity',
      severity: 'high',
      rootCause: true,
      cause: 'Hero image discovery is delayed by a render-blocking clientlib.',
      recommendation: 'Preload the hero image and defer the non-critical clientlib.',
      evidence: [
        { kind: 'cwv-attribution', data: { target: 'img.hero', artifact: 'baseline.json' } },
        { kind: 'resource-timing', data: { url: 'https://cdn.example.com/clientlib.js', path: 'baseline.json' } },
      ],
      owner: 'customer-code',
      ownership: {
        owner: 'customer-code',
        rationale: 'The blocking clientlib is in the customer theme.',
      },
      confidence: 0.82,
      impactReduction: { metric: 'LCP', valueMs: 900 },
      patches: { preloads: [{ href: '/hero.webp', as: 'image', fetchpriority: 'high' }] },
      status: 'proposed',
    }, {
      schemaVersion: '1.0',
      id: 'diagnose-cls-1',
      timestamp: '2026-06-21T00:00:00.000Z',
      url: 'https://example.com/product',
      skill: 'cwv-diagnose',
      source: 'perf_observer',
      metric: ['CLS'],
      type: 'opportunity',
      severity: 'medium',
      rootCause: false,
      cause: 'Cookie banner enters after load.',
      recommendation: 'Reserve banner space or avoid the entrance animation.',
      evidence: [{ kind: 'cwv-attribution', data: { target: '.cookie-banner' } }],
      owner: 'third-party',
      confidence: 0.64,
      impactReduction: { metric: 'CLS', score: 0.05 },
      status: 'proposed',
    }],
  };
}

test('buildDiagnoseSpaceCatDraft emits a non-mutating SpaceCat-shaped diagnosis draft', () => {
  const draft = buildDiagnoseSpaceCatDraft(mkEnvelope(), { metric: 'LCP' });

  assert.equal(draft.kind, 'diagnose-spacecat-draft');
  assert.equal(draft.publishState, 'draft');
  assert.equal(draft.mutatesBackend, false);
  assert.equal(draft.selectedUrl, 'https://example.com/product');
  assert.equal(draft.metric, 'lcp');
  assert.equal(draft.aggregationKey, 'https://example.com/product|lcp');
  assert.deepEqual(draft.dedupIdentity, {
    url: 'https://example.com/product',
    metric: 'lcp',
    aggregationKey: 'https://example.com/product|lcp',
  });
  assert.equal(draft.dedupPlan, null, 'publish read-probe owns the actual dedup plan');
  assert.ok(!JSON.stringify(draft).includes('OUTDATED'), 'draft does not claim backend state transitions');

  assert.equal(draft.suggestion.type, 'CODE_CHANGE');
  assert.equal(draft.suggestion.data.aggregationKey, draft.aggregationKey);
  assert.equal(draft.suggestion.data.isCodeChangeAvailable, false);
  assert.equal(draft.suggestion.data.issues.length, 1);

  const issue = draft.suggestion.data.issues[0];
  assert.equal(issue.findingId, 'diagnose-lcp-1');
  assert.equal(issue.type, 'lcp');
  assert.equal(issue.status, 'DRAFT');
  assert.equal(issue.problem, 'Hero image discovery is delayed by a render-blocking clientlib.');
  assert.equal(issue.mechanism, 'Hero image discovery is delayed by a render-blocking clientlib.');
  assert.deepEqual(issue.affected.selectors, ['img.hero']);
  assert.deepEqual(issue.affected.resources, ['https://cdn.example.com/clientlib.js']);
  assert.deepEqual(issue.evidence.map((entry) => entry.path), ['baseline.json', 'baseline.json']);
  assert.equal(issue.owner, 'customer-code');
  assert.equal(issue.confidence.value, 0.82);
  assert.match(issue.value, /^## /, 'draft carries SpaceCat issue-value markdown for review');
});

test('buildDiagnoseReport renders the AEM expert review sections', () => {
  const envelope = mkEnvelope();
  envelope.findings[1].metric = ['LCP'];
  const draft = buildDiagnoseSpaceCatDraft(envelope);
  const report = buildDiagnoseReport(draft);

  for (const heading of [
    '## Selected URL',
    '## Failing Metrics',
    '## Root Cause',
    '## Evidence',
    '## Ownership',
    '## Risks',
    '## Recommended Next Remediation Path',
  ]) {
    assert.match(report, new RegExp(`^${heading}$`, 'm'));
  }
  assert.match(report, /https:\/\/example\.com\/product/);
  assert.match(report, /diagnose-lcp-1/);
  assert.match(report, /diagnose-cls-1: Cookie banner enters after load\./);
  assert.match(report, /resource-timing.*baseline\.json.*Hero image discovery is delayed/s);
  assert.match(report, /customer-code/);
});
