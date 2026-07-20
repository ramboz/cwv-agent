#!/usr/bin/env node

/**
 * Tests for the fix→publish contract (spec slice 003-04).
 *
 * `fix-findings.json` is the Finding-native hand-off that `cwv-publish`
 * (003-02) consumes. This suite proves two things:
 *
 *  1. The schema persists `source-mapper`'s structured source-edit records
 *     (`sourceEdits: [{ file, before, after, line? }]`) — the raw material the
 *     publish step formats into a unified diff. (`patches` is CDP/DOM runtime
 *     mutations, NOT a diff, so it cannot serve this role.)
 *
 *  2. A finished, validated `fix-findings.json` round-trips into a SpaceCat
 *     suggestion payload: every payload field in spacecat-api.md is present or
 *     derivable from the Finding via the documented field→payload mapping —
 *     INCLUDING that a unified diff is derivable from `sourceEdits`.
 *
 * The full publish/POST flow (kpiDeltas keying, issue.value Markdown assembly,
 * the API client) is 003-02's job — NOT exercised here. We only assert
 * derivability with the minimum scaffolding the mapping table promises.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { validateFinding } from '../finding-schema.js';
import { editsToUnifiedDiff } from '../source-edits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'fix-findings.example.json');

/** Load the example envelope and return its single validated finding. */
function loadExampleFinding() {
  const env = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const findings = Array.isArray(env.findings) ? env.findings : [env];
  return { env, finding: findings[0] };
}

// ---------------------------------------------------------------------------
// AC#3a — the example fixture is schema-valid.
// ---------------------------------------------------------------------------

test('fix-findings.example.json passes validateFinding', () => {
  const { finding } = loadExampleFinding();
  const res = validateFinding(finding);
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
});

test('the example finding is a terminal validated fix with the publish-handoff fields', () => {
  const { finding } = loadExampleFinding();
  assert.equal(finding.status, 'validated', 'fixture must be a validated finding');
  // recommendation -> suggestion title; cause -> description; both required for patch publish.
  assert.ok(typeof finding.recommendation === 'string' && finding.recommendation.length > 0);
  assert.ok(typeof finding.cause === 'string' && finding.cause.length > 0);
  // measurement-delta evidence carries baseline/treatment for kpiDeltas keying.
  const md = (finding.evidence || []).find((e) => e.kind === 'measurement-delta');
  assert.ok(md, 'fixture must carry a measurement-delta evidence entry');
  assert.equal(typeof md.data.baseline, 'number');
  assert.equal(typeof md.data.treatment, 'number');
});

// ---------------------------------------------------------------------------
// `sourceEdits` schema validation (the crux of this slice).
// ---------------------------------------------------------------------------

/** Minimal schema-valid validated finding; sourceEdits supplied by caller. */
function baseValidatedFinding(sourceEdits) {
  const f = {
    schemaVersion: '1.0',
    id: 'validate-cls-1',
    timestamp: '2026-06-11T00:00:00.000Z',
    url: 'https://example.com/',
    skill: 'cwv-validate',
    source: 'perf_observer',
    metric: ['CLS'],
    type: 'opportunity',
    severity: 'high',
    rootCause: true,
    cause: 'late banner reveal shifts main content',
    evidence: [
      { kind: 'measurement-delta', data: { metric: 'CLS', baseline: 0.144, treatment: 0.025, deltaScore: -0.119, runs: 15 } },
    ],
    recommendation: 'make the header position:sticky so it reserves its own space',
    confidence: 0.85,
    impactReduction: { metric: 'CLS', score: 0.119 },
    status: 'validated',
  };
  if (sourceEdits !== undefined) f.sourceEdits = sourceEdits;
  return f;
}

test('sourceEdits is OPTIONAL — a validated finding without it still validates', () => {
  const res = validateFinding(baseValidatedFinding(undefined));
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
  assert.ok(
    res.warnings.some((w) => /validated finding has no sourceEdits/.test(w)),
    `warnings: ${JSON.stringify(res.warnings)}`,
  );
});

test('valid sourceEdits (the source-mapper subset) passes', () => {
  const f = baseValidatedFinding([
    { file: 'styles/header.css', before: 'position: fixed;', after: 'position: sticky;', line: 42 },
    { file: 'blocks/header/header.js', before: 'el.show(300);', after: 'el.show();' },
  ]);
  const res = validateFinding(f);
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
});

test('sourceAvailability records source-s3 handoff status', () => {
  const f = baseValidatedFinding([
    { file: 'styles/header.css', before: 'position: fixed;', after: 'position: sticky;', line: 42 },
  ]);
  f.sourceAvailability = {
    status: 'fetched',
    siteId: '90abcb83-bbfb-4bbd-8313-a0adc2986ce2',
    deliveryType: 'aem_cs',
    manifestPath: 'progress/example/source-manifest.json',
    sourceRoot: 'progress/example/source',
    s3Key: 'code/90abcb83-bbfb-4bbd-8313-a0adc2986ce2/standard/owner/repo/ref/repository.zip',
    checkedAt: '2026-06-20T12:34:56.000Z',
  };
  const res = validateFinding(f);
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
});

test('sourceAvailability rejects unknown status', () => {
  const f = baseValidatedFinding(undefined);
  f.sourceAvailability = { status: 'maybe_later' };
  const res = validateFinding(f);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /sourceAvailability\.status/.test(e)));
});

test('validated finding with fetched source but no sourceEdits warns to map source', () => {
  const f = baseValidatedFinding(undefined);
  f.sourceAvailability = { status: 'fetched' };
  const res = validateFinding(f);
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
  assert.ok(res.warnings.some((w) => /fetched.*no sourceEdits/.test(w)));
});

test('sourceEdits must be an array', () => {
  const res = validateFinding(baseValidatedFinding({ file: 'a.css', before: 'x', after: 'y' }));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /sourceEdits must be an array/.test(e)));
});

test('sourceEdits entry must be an object', () => {
  const res = validateFinding(baseValidatedFinding(['not-an-object']));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /sourceEdits\[0\] must be an object/.test(e)));
});

test('sourceEdits entry requires a non-empty file', () => {
  const res = validateFinding(baseValidatedFinding([{ file: '', before: 'x', after: 'y' }]));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /sourceEdits\[0\]\.file must be a non-empty string/.test(e)));
});

test('sourceEdits entry requires before/after strings', () => {
  const res = validateFinding(baseValidatedFinding([{ file: 'a.css', before: 1, after: 'y' }]));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /sourceEdits\[0\]\.before must be a string/.test(e)));
});

test('sourceEdits entry line, when present, must be a number', () => {
  const res = validateFinding(baseValidatedFinding([{ file: 'a.css', before: 'x', after: 'y', line: 'top' }]));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => /sourceEdits\[0\]\.line must be a number/.test(e)));
});

test('sourceEdits entry line is optional (the EDS decorator case has line: null)', () => {
  const res = validateFinding(baseValidatedFinding([{ file: 'blocks/x/x.js', before: 'a', after: 'b', line: null }]));
  assert.equal(res.valid, true, `errors: ${JSON.stringify(res.errors)}`);
});

// ---------------------------------------------------------------------------
// editsToUnifiedDiff — the tiny pure formatter that proves diff derivability.
// (003-02 consumes this against real source; here it only proves AC#3.)
// ---------------------------------------------------------------------------

test('editsToUnifiedDiff turns sourceEdits into a clean unified diff', () => {
  const diff = editsToUnifiedDiff([
    { file: 'styles/header.css', before: 'position: fixed;', after: 'position: sticky;', line: 42 },
  ]);
  // unified-diff anatomy: ---/+++ file headers, an @@ hunk, - before, + after.
  assert.match(diff, /^--- a\/styles\/header\.css$/m);
  assert.match(diff, /^\+\+\+ b\/styles\/header\.css$/m);
  assert.match(diff, /^@@ /m);
  assert.match(diff, /^-position: fixed;$/m);
  assert.match(diff, /^\+position: sticky;$/m);
  // no prose leaks into the diff
  assert.ok(!/Rationale|Auto-applicable/.test(diff));
});

// ---------------------------------------------------------------------------
// AC#3 — the documented field→payload mapping round-trips into a valid
// SpaceCat suggestion payload (spacecat-api.md "data shape (CWV)" + issue object).
// ---------------------------------------------------------------------------

/**
 * Apply the documented mapping (finding-schema.md "fix-findings → suggestion
 * payload" table) to build the SpaceCat suggestion `data`/`kpiDeltas`. This is
 * the minimal stand-in for what cwv-publish (003-02) does at upload — exercised
 * here only to prove every payload field is present or derivable.
 */
function findingToSuggestion(finding, envelope) {
  const md = finding.evidence.find((e) => e.kind === 'measurement-delta');
  const metric = (finding.metric[0] || md.data.metric).toLowerCase();
  const before = md.data.baseline;
  const after = md.data.treatment;
  const delta = md.data.deltaMs !== undefined ? md.data.deltaMs : md.data.deltaScore;
  const deviceType = profileToDeviceType(envelope.profile || finding.profile);

  return {
    type: 'CODE_CHANGE',
    rank: 1,
    kpiDeltas: { [metric]: { before, after, delta, deviceType } },
    data: {
      url: finding.url,
      type: 'url',
      metrics: [{ deviceType, [metric]: before }],
      issues: [
        {
          type: metric,
          status: 'NEW',
          // issue.value Markdown is assembled by cwv-publish; the formal diff
          // lives only in patchContent.
          value: `## ${finding.recommendation}\n\n### Description\n${finding.cause}\n\n_A ready-to-apply unified diff is provided as the code patch for this issue._`,
          patchContent: editsToUnifiedDiff(finding.sourceEdits),
        },
      ],
    },
  };
}

function profileToDeviceType(profile) {
  if (!profile) return 'mobile';
  return /desktop/i.test(profile) ? 'desktop' : 'mobile';
}

test('a validated fix-findings.json round-trips into a valid SpaceCat suggestion payload', () => {
  const { env, finding } = loadExampleFinding();
  const sugg = findingToSuggestion(finding, env);

  // Suggestion-level required fields (spacecat-api.md suggestion table).
  assert.equal(sugg.type, 'CODE_CHANGE');
  assert.equal(typeof sugg.rank, 'number');
  assert.ok(sugg.data && typeof sugg.data === 'object' && Object.keys(sugg.data).length > 0, 'data must be a non-empty object');

  // CWV `data` projection fields ['url','type','metrics','issues'].
  assert.ok(/^https?:\/\//.test(sugg.data.url), 'data.url must be http(s)');
  assert.equal(sugg.data.type, 'url');
  assert.ok(Array.isArray(sugg.data.metrics) && sugg.data.metrics.length >= 1, 'data.metrics[]');
  assert.ok(typeof sugg.data.metrics[0].deviceType === 'string');
  assert.equal(sugg.data.metrics[0].cls, 0.144, 'data.metrics[0] carries the keyed metric value (the before measurement)');

  // Exactly one issue object with the lean 4-key shape {type,value,status,patchContent}.
  assert.equal(sugg.data.issues.length, 1, 'one issue object = one fix');
  const issue = sugg.data.issues[0];
  assert.equal(issue.type, 'cls', 'issue.type is the lowercase metric label');
  assert.ok(typeof issue.value === 'string' && issue.value.startsWith('## '), 'value starts at the title heading');
  assert.ok(typeof issue.status === 'string' && issue.status.length > 0);
  // patchContent is a clean unified diff derived from sourceEdits — the crux.
  assert.match(issue.patchContent, /^--- a\//m);
  assert.match(issue.patchContent, /^\+\+\+ b\//m);
  assert.match(issue.patchContent, /^@@ /m);

  // kpiDeltas keyed by metric, carrying before/after/delta/deviceType.
  const kpi = sugg.kpiDeltas.cls;
  assert.ok(kpi, 'kpiDeltas keyed by the metric (cls)');
  assert.equal(typeof kpi.before, 'number');
  assert.equal(typeof kpi.after, 'number');
  assert.equal(typeof kpi.delta, 'number');
  assert.equal(typeof kpi.deviceType, 'string');
});

test('the round-trip diff is derivable purely from sourceEdits (no patches needed)', () => {
  const { finding } = loadExampleFinding();
  // sourceEdits is the basis for the publish diff — assert it is present & shaped.
  assert.ok(Array.isArray(finding.sourceEdits) && finding.sourceEdits.length >= 1);
  for (const e of finding.sourceEdits) {
    assert.ok(typeof e.file === 'string' && e.file.length > 0);
    assert.equal(typeof e.before, 'string');
    assert.equal(typeof e.after, 'string');
  }
  const diff = editsToUnifiedDiff(finding.sourceEdits);
  assert.ok(diff.length > 0 && diff.includes('@@'));
});
