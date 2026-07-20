#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildManifest,
  isGitRepo,
  makeBranchName,
  makePatchRelativePath,
  sanitizeSegment,
  sourceEditsToGitPatch,
  writeJson,
} from '../local-artifacts.js';

const LOCAL_ARTIFACTS_CLI = fileURLToPath(new URL('../local-artifacts.js', import.meta.url));

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cwv-local-artifacts-'));
}

function assertSpawnOk(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
}

function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function mkDiagnoseFinding(overrides = {}) {
  return {
    schemaVersion: '1.0',
    id: 'diagnose-lcp-hero',
    timestamp: '2026-06-17T00:00:00.000Z',
    url: 'https://example.com/',
    skill: 'cwv-diagnose',
    source: 'har',
    metric: ['LCP'],
    type: 'opportunity',
    severity: 'high',
    rootCause: true,
    cause: 'hero image starts late',
    evidence: [{ kind: 'cwv-attribution', data: { target: 'img.hero' } }],
    recommendation: 'preload the hero image',
    patches: { preloads: [{ href: '/hero.jpg', as: 'image', fetchpriority: 'high' }] },
    confidence: 0.85,
    impactReduction: { metric: 'LCP', valueMs: 500 },
    status: 'proposed',
    ...overrides,
  };
}

function mkValidatedFinding(overrides = {}) {
  return {
    schemaVersion: '1.0',
    id: 'validate-cls-banner',
    timestamp: '2026-06-17T00:00:00.000Z',
    url: 'https://example.com/',
    skill: 'cwv-validate',
    source: 'perf_observer',
    metric: ['CLS'],
    type: 'opportunity',
    severity: 'high',
    rootCause: true,
    cause: 'animated consent banner reveal shifts content',
    evidence: [
      { kind: 'measurement-delta', data: { metric: 'CLS', baseline: 0.14, treatment: 0, deltaScore: -0.14, runs: 15 } },
      { kind: 'screenshot', data: { path: 'screenshots/treatment.png', phase: 'treatment' } },
    ],
    recommendation: 'remove the banner reveal animation',
    patches: { rewriteBody: [{ urlPattern: '*theme.js*', replacements: [{ find: '.show(e)', replace: '.show()' }] }] },
    sourceEdits: [
      { file: 'scripts/theme.js', before: '.show(e)', after: '.show()', line: 42 },
    ],
    confidence: 0.85,
    impactReduction: { metric: 'CLS', score: 0.14 },
    status: 'validated',
    ...overrides,
  };
}

function mkEnvelope(skill, findings) {
  return {
    schemaVersion: '1.0',
    skill,
    url: 'https://example.com/',
    timestamp: '2026-06-17T00:00:00.000Z',
    profile: 'mobile-slow4g-4xcpu',
    findings,
  };
}

function mkStructuralFinding(overrides = {}) {
  return mkDiagnoseFinding({
    id: 'diagnose-eds-structure',
    source: 'html',
    metric: ['CLS', 'LCP'],
    type: 'bottleneck',
    rootCause: true,
    cause: 'EDS reveal/page-shape contract is broken',
    evidence: [{
      kind: 'rule-violation',
      data: {
        ruleId: 'html/eds-structural-contract',
        context: {
          gateResult: 'fail',
          reasons: ['first meaningful section is section 6'],
        },
      },
    }],
    recommendation: 'Restore EDS reveal/eager-section/header-flow behavior.',
    patches: undefined,
    confidence: 0.7,
    impactReduction: { metric: 'CLS', score: 0.1 },
    structuralGate: {
      name: 'eds-structural-contract',
      result: 'fail',
      reasons: ['first meaningful section is section 6'],
    },
    ...overrides,
  });
}

function seedProgressFixture(root) {
  const progress = path.join(root, 'progress', 'example-com');
  const sourceRepo = path.join(root, 'source');
  fs.mkdirSync(sourceRepo, { recursive: true });
  assertSpawnOk(spawnSync('git', ['-C', sourceRepo, 'init'], { encoding: 'utf8' }), 'git init');
  fs.mkdirSync(path.join(sourceRepo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(sourceRepo, 'scripts', 'theme.js'), 'function reveal($el, e) {\n  return $el.show(e);\n}\n', 'utf8');
  fs.writeFileSync(path.join(sourceRepo, 'head.html'), '<html>\n<head>\n</head>\n<body></body>\n</html>\n', 'utf8');
  assertSpawnOk(spawnSync('git', ['-C', sourceRepo, 'add', '.'], { encoding: 'utf8' }), 'git add');
  assertSpawnOk(spawnSync('git', [
    '-C',
    sourceRepo,
    '-c',
    'user.name=CWV Test',
    '-c',
    'user.email=cwv@example.test',
    'commit',
    '-m',
    'fixture source',
  ], { encoding: 'utf8' }), 'git commit');

  writeJsonFile(path.join(progress, 'session.json'), {
    schemaVersion: '1.0',
    slug: 'example-com',
    url: 'https://example.com/',
    status: 'complete',
  });
  writeJsonFile(path.join(progress, 'baseline.json'), {
    url: 'https://example.com/',
    profile: 'mobile-slow4g-4xcpu',
    runs: [],
  });
  writeJsonFile(path.join(progress, 'diagnose-findings.json'), mkEnvelope('cwv-diagnose', [mkDiagnoseFinding()]));
  writeJsonFile(path.join(progress, 'diagnose-spacecat-draft.json'), {
    schemaVersion: '1.0',
    kind: 'diagnose-spacecat-draft',
    publishState: 'draft',
    mutatesBackend: false,
    selectedUrl: 'https://example.com/',
    metric: 'lcp',
    aggregationKey: 'https://example.com/|lcp',
    suggestion: { type: 'CODE_CHANGE', data: { issues: [] } },
  });
  fs.writeFileSync(path.join(progress, 'diagnose-report.md'), '# Diagnose Report\n');
  writeJsonFile(path.join(progress, 'remediation-payload.json'), {
    schemaVersion: '1.0',
    kind: 'remediation-payload',
    remediationType: 'CODE_CHANGE',
    selectedUrl: 'https://example.com/',
    metric: 'cls',
    aggregationKey: 'https://example.com/|cls',
    issues: [],
    suggestion: { type: 'CODE_CHANGE', data: { issues: [] } },
  });
  fs.writeFileSync(path.join(progress, 'remediation-report.md'), '# Remediation Report\n');
  writeJsonFile(path.join(progress, 'publish-plan.json'), {
    schemaVersion: '1.0',
    kind: 'publish-plan',
    mutatesBackend: false,
    confirmBeforeWriteRequired: true,
    siteId: 'site-123',
    url: 'https://example.com/',
    metric: 'cls',
    aggregationKey: 'https://example.com/|cls',
    suggestion: { action: 'PATCH', targetSuggestionId: 'suggestion-1', advisory: false },
    writePayload: { suggestion: { type: 'CODE_CHANGE', data: { issues: [] } } },
  });
  writeJsonFile(path.join(progress, 'ranked_patches.json'), {
    schemaVersion: '1.0',
    url: 'https://example.com/',
    candidates: [{ id: 'diagnose-lcp-hero' }],
  });
  writeJsonFile(path.join(progress, 'validate-findings.json'), mkEnvelope('cwv-validate', [mkValidatedFinding()]));
  writeJsonFile(path.join(progress, 'experiments', 'exp-001', 'patch.json'), { preloads: [{ href: '/hero.jpg', as: 'image' }] });
  writeJsonFile(path.join(progress, 'experiments', 'exp-001', 'result.json'), { url: 'https://example.com/', runs: [] });
  writeJsonFile(path.join(progress, 'experiments', 'exp-001', 'verdict.json'), { verdict: 'VALIDATED' });
  fs.mkdirSync(path.join(progress, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(progress, 'screenshots', 'treatment.png'), 'not really a png');
  fs.writeFileSync(path.join(progress, 'SUMMARY.md'), '# Summary\n');

  return { progress, sourceRepo };
}

test('buildManifest indexes a runtime-only validation handoff without requiring optional providers', () => {
  const root = mkTempDir();
  const progress = path.join(root, 'progress', 'runtime-only');
  writeJsonFile(path.join(progress, 'session.json'), {
    schemaVersion: '1.0',
    slug: 'runtime-only',
    url: 'https://example.com/',
    status: 'complete',
  });
  writeJsonFile(path.join(progress, 'baseline.json'), {
    url: 'https://example.com/',
    profile: 'mobile-slow4g-4xcpu',
    runs: [],
  });
  writeJsonFile(path.join(progress, 'validate-findings.json'), mkEnvelope('cwv-validate', [
    mkValidatedFinding(),
  ]));
  writeJsonFile(path.join(progress, 'experiments', 'exp-001', 'result.json'), {
    url: 'https://example.com/',
    runs: [],
  });
  writeJsonFile(path.join(progress, 'experiments', 'exp-001', 'verdict.json'), {
    verdict: 'VALIDATED',
  });

  const manifest = buildManifest({ progressDir: progress });

  assert.equal(manifest.validationLayers.layers.runtime.status, 'passed');
  assert.equal(manifest.validationLayers.layers.sourceBuild.status, 'missing');
  assert.equal(manifest.validationLayers.layers.aso.status, 'missing');
  assert.ok(manifest.validationArtifactIndex.some((entry) => (
    entry.provider === 'cwv-validate'
    && entry.validationLayer === 'runtime'
    && entry.path === 'validate-findings.json'
    && entry.exists === true
    && entry.summary.status === 'valid'
  )));
  assert.ok(manifest.validationArtifactIndex.some((entry) => (
    entry.validationLayer === 'sourceBuild'
    && entry.path === 'aem-clientlib-build-result.json'
    && entry.exists === false
    && entry.status === 'missing'
  )));
  assert.ok(manifest.validationArtifactIndex.some((entry) => (
    entry.validationLayer === 'aso'
    && entry.path === 'aso-validation/summary.json'
    && entry.exists === false
    && entry.status === 'skipped'
  )));
  assert.ok(manifest.validationArtifactIndex.some((entry) => (
    entry.validationLayer === 'publishing'
    && entry.path === 'publish-plan.json'
    && entry.exists === false
    && entry.status === 'skipped'
  )));
});

test('buildManifest indexes local artifacts, validates findings, and writes per-fix source patches', () => {
  const root = mkTempDir();
  const { progress, sourceRepo } = seedProgressFixture(root);

  const manifest = buildManifest({
    progressDir: progress,
    sourceRepo,
    branchMode: 'per-fix',
    branchPrefix: 'perf',
  });

  assert.equal(manifest.kind, 'cwv-local-artifact-manifest');
  assert.equal(manifest.profile, 'local');
  assert.equal(manifest.slug, 'example-com');
  assert.equal(manifest.integrationProviders.fieldData.status, 'not-used');
  assert.deepEqual(manifest.integrationProviders.source.profiles, ['local']);
  assert.deepEqual(manifest.integrationProviders.source.providers, ['local-source-repo']);
  assert.deepEqual(manifest.integrationProviders.diagnosis.providers, ['cwv-agent']);
  assert.deepEqual(manifest.integrationProviders.validation.providers, ['cwv-validate', 'oracle']);
  assert.equal(manifest.integrationProviders.publishing.status, 'planned');
  assert.deepEqual(manifest.integrationProviders.publishing.artifacts, ['publish-plan.json']);
  assert.equal(manifest.validationLayers.layers.runtime.status, 'passed');
  assert.equal(manifest.validationLayers.layers.sourceBuild.status, 'missing');
  assert.equal(manifest.validationLayers.layers.aso.status, 'missing');
  assert.equal(manifest.validationLayers.layers.aemDeployment.status, 'missing');
  assert.deepEqual(
    manifest.validationLayers.warnings.map((warning) => warning.code),
    ['aem-cs-source-builder-missing', 'aem-deployment-revalidation-missing'],
  );
  assert.equal(manifest.localCompletion.publishRequired, false);
  assert.equal(manifest.structuralGate.result, 'not-run');
  assert.equal(manifest.localCompletion.status, 'complete');
  assert.equal(manifest.localCompletion.findingValidationPassed, true);
  assert.equal(manifest.localCompletion.branchOutputPassed, true);
  assert.equal(manifest.localCompletion.branchCreationPassed, true);
  assert.equal(manifest.localCompletion.branchPatchGenerationPassed, true);
  assert.equal(manifest.findingValidation.length, 2);
  assert.ok(manifest.findingValidation.every((entry) => entry.valid), 'all Finding envelopes validate');

  assert.deepEqual(manifest.artifacts.baselineFiles.map((item) => item.path), ['baseline.json']);
  assert.deepEqual(manifest.artifacts.diagnoseFindings.map((item) => item.path), ['diagnose-findings.json']);
  assert.deepEqual(manifest.artifacts.diagnoseDrafts.map((item) => item.path), ['diagnose-spacecat-draft.json']);
  assert.deepEqual(manifest.artifacts.diagnoseReports.map((item) => item.path), ['diagnose-report.md']);
  assert.deepEqual(manifest.artifacts.remediationPayloads.map((item) => item.path), ['remediation-payload.json']);
  assert.deepEqual(manifest.artifacts.remediationReports.map((item) => item.path), ['remediation-report.md']);
  assert.deepEqual(manifest.artifacts.publishPlans.map((item) => item.path), ['publish-plan.json']);
  assert.ok(manifest.artifacts.patchCandidates.some((item) => item.path === 'ranked_patches.json'));
  assert.ok(manifest.artifacts.patchCandidates.some((item) => item.path === 'experiments/exp-001/patch.json'));
  assert.deepEqual(manifest.artifacts.treatmentMeasurements.map((item) => item.path), ['experiments/exp-001/result.json']);
  assert.deepEqual(manifest.artifacts.verdicts.map((item) => item.path), ['experiments/exp-001/verdict.json']);
  assert.deepEqual(manifest.artifacts.validatedFindings.map((item) => item.id), ['validate-cls-banner']);
  assert.deepEqual(manifest.artifacts.sourceEdits.map((item) => item.findingId), ['validate-cls-banner']);
  assert.ok(manifest.artifacts.screenshots.some((item) => item.path === 'screenshots/treatment.png'));

  assert.equal(manifest.branchOutput.mode, 'per-fix');
  assert.equal(manifest.branchOutput.sourceRepo.isGitRepo, true);
  assert.equal(manifest.branchOutput.branches.length, 1);
  const branch = manifest.branchOutput.branches[0];
  assert.equal(branch.branch, 'perf/example-com-validate-cls-banner');
  assert.equal(branch.patchFile, 'source-patches/validate-cls-banner.diff');
  assert.deepEqual(branch.sourceEdits.files, ['scripts/theme.js']);
  const patchPath = path.join(progress, branch.patchFile);
  assert.ok(fs.readFileSync(patchPath, 'utf8').includes('-  return $el.show(e);'));
  const check = spawnSync('git', ['-C', sourceRepo, 'apply', '--check', patchPath], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  assert.ok(manifest.validationArtifactIndex.some((entry) => (
    entry.provider === 'local-artifacts'
    && entry.validationLayer === 'sourcePatch'
    && entry.path === 'source-patches/validate-cls-banner.diff'
    && entry.exists === true
  )));
  assert.ok(manifest.validationArtifactIndex.some((entry) => (
    entry.provider === 'cwv-publish'
    && entry.validationLayer === 'publishing'
    && entry.path === 'publish-plan.json'
    && entry.exists === true
    && entry.summary.confirmBeforeWriteRequired === true
  )));
});

test('buildManifest does not mark runtime validation passed for non-VALIDATED oracle verdicts', () => {
  const root = mkTempDir();
  const { progress } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'validate-findings.json'), mkEnvelope('cwv-validate', [
    mkValidatedFinding({ status: 'proposed' }),
  ]));
  writeJsonFile(path.join(progress, 'experiments', 'exp-001', 'verdict.json'), {
    verdict: 'REGRESSION',
    exitCode: 1,
  });

  const manifest = buildManifest({ progressDir: progress });

  assert.equal(manifest.validationLayers.layers.runtime.status, 'failed');
  assert.ok(
    manifest.validationLayers.layers.runtime.artifacts.includes('experiments/exp-001/verdict.json'),
    'failing verdict remains visible as evidence without being treated as a pass',
  );
  assert.equal(manifest.localCompletion.status, 'complete');
});

test('buildManifest surfaces EDS structural gate findings and ranked probe-only candidates', () => {
  const root = mkTempDir();
  const { progress } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'diagnose-findings.json'), mkEnvelope('cwv-diagnose', [
    mkStructuralFinding(),
    mkDiagnoseFinding({
      id: 'diagnose-cls-shim',
      metric: ['CLS'],
      impactReduction: { metric: 'CLS', score: 0.2 },
      patches: { markup: [{ selector: '.tabs', attrs: { style: 'min-height: 900px' } }] },
    }),
  ]));
  writeJsonFile(path.join(progress, 'ranked_patches.json'), {
    schemaVersion: '1.0',
    url: 'https://example.com/',
    structuralGate: {
      name: 'eds-structural-contract',
      result: 'fail',
      sourceFindingIds: ['diagnose-eds-structure'],
      reasons: ['first meaningful section is section 6'],
    },
    candidates: [{
      id: 'diagnose-cls-shim',
      metric: 'CLS',
      probeOnly: true,
      promotionBlocked: true,
      promotionBlockReason: 'EDS structural gate failed',
    }],
  });

  const manifest = buildManifest({ progressDir: progress });

  assert.equal(manifest.structuralGate.result, 'fail');
  assert.deepEqual(manifest.structuralGate.sourceFindingIds, ['diagnose-eds-structure']);
  assert.equal(manifest.structuralGate.findings.length, 1);
  assert.equal(manifest.structuralGate.probeOnlyCandidates.length, 1);
  assert.equal(manifest.structuralGate.probeOnlyCandidates[0].id, 'diagnose-cls-shim');
  assert.equal(manifest.localCompletion.structuralGateResult, 'fail');
});

test('buildManifest preserves EDS structural pass from finding-file metadata', () => {
  const root = mkTempDir();
  const { progress } = seedProgressFixture(root);
  const envelope = mkEnvelope('cwv-diagnose', [mkDiagnoseFinding()]);
  envelope.meta = {
    structuralGate: {
      name: 'eds-structural-contract',
      result: 'pass',
      reasons: [],
    },
  };
  writeJsonFile(path.join(progress, 'diagnose-findings.json'), envelope);
  writeJsonFile(path.join(progress, 'ranked_patches.json'), {
    schemaVersion: '1.0',
    url: 'https://example.com/',
    candidates: [{ id: 'diagnose-lcp-hero' }],
  });

  const manifest = buildManifest({ progressDir: progress });

  assert.equal(manifest.structuralGate.result, 'pass');
  assert.deepEqual(manifest.structuralGate.sourceFiles, ['diagnose-findings.json']);
  assert.equal(manifest.localCompletion.structuralGateResult, 'pass');
});

test('buildManifest preserves explicit integration provider metadata from the session', () => {
  const root = mkTempDir();
  const { progress } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'triage-findings.json'), mkEnvelope('cwv-triage', [
    mkDiagnoseFinding({
      id: 'triage-lcp-1',
      skill: 'cwv-triage',
      source: 'rum',
      status: 'draft',
      patches: undefined,
    }),
  ]));
  writeJsonFile(path.join(progress, 'session.json'), {
    schemaVersion: '1.0',
    slug: 'example-com',
    url: 'https://example.com/',
    status: 'complete',
    integrationProviders: {
      fieldData: {
        status: 'used',
        profiles: ['field-aem-rum'],
        providers: ['rum-fetch'],
        artifacts: ['triage-findings.json', 'rum.json'],
      },
      source: {
        status: 'used',
        profiles: ['source-s3'],
        providers: ['source-fetch'],
        artifacts: ['source/.cwv-source-manifest.json'],
      },
      diagnosis: {
        status: 'used',
        profiles: ['diagnose-cwv-agent'],
        providers: ['hosted-cwv-diagnoser'],
        notes: ['fixture adapter'],
      },
      validation: {
        status: 'used',
        profiles: ['validate-aso'],
        providers: ['aso-shallow-validator'],
      },
      publishing: {
        status: 'not-used',
        profiles: ['publish-spacecat'],
        providers: ['cwv-publish'],
        spaceCatApiCalls: [],
      },
    },
  });

  const manifest = buildManifest({ progressDir: progress });

  assert.deepEqual(manifest.integrationProviders.fieldData.profiles, ['field-aem-rum']);
  assert.deepEqual(manifest.integrationProviders.fieldData.providers, ['rum-fetch']);
  assert.deepEqual(manifest.integrationProviders.source.profiles, ['source-s3']);
  assert.deepEqual(manifest.integrationProviders.diagnosis.providers, ['hosted-cwv-diagnoser']);
  assert.deepEqual(manifest.integrationProviders.diagnosis.notes, ['fixture adapter']);
  assert.deepEqual(manifest.integrationProviders.validation.profiles, ['validate-aso']);
  assert.deepEqual(manifest.integrationProviders.publishing.spaceCatApiCalls, []);
});

test('buildManifest indexes ASO validation artifacts and provider metadata when present', () => {
  const root = mkTempDir();
  const { progress } = seedProgressFixture(root);
  fs.mkdirSync(path.join(progress, 'aem-clientlib-builder-logs'), { recursive: true });
  fs.mkdirSync(path.join(progress, 'aem-clientlib-builder-dist'), { recursive: true });
  writeJsonFile(path.join(progress, 'aem-clientlib-build-result.json'), {
    schemaVersion: '1.0',
    tool: 'aem-clientlib-build.js',
    provider: 'aem-clientlib-builder',
    logsDir: path.join(progress, 'aem-clientlib-builder-logs'),
    distDir: path.join(progress, 'aem-clientlib-builder-dist'),
    success: true,
    steps: [
      {
        goal: 'npm build',
        exitCode: 0,
        stderrLogFile: path.join(progress, 'aem-clientlib-builder-logs', 'npm-build.stderr.log'),
      },
      {
        goal: 'clientlib',
        exitCode: 0,
      },
    ],
  });
  writeJsonFile(path.join(progress, 'aso-validation', 'request.json'), { requestId: 'req-1' });
  writeJsonFile(path.join(progress, 'aso-validation', 'submit-response.json'), { status: 202, body: { jobId: 'job-1' } });
  writeJsonFile(path.join(progress, 'aso-validation', 'poll-trail.json'), []);
  writeJsonFile(path.join(progress, 'aso-validation', 'final-verdict.json'), { verdict: 'PASS', reasonCodes: [] });
  writeJsonFile(path.join(progress, 'aso-validation', 'summary.json'), {
    schemaVersion: '1.0',
    kind: 'aso-validation-summary',
    provider: 'aso-shallow-validator',
    jobId: 'job-1',
    verdict: 'PASS',
  });

  const manifest = buildManifest({ progressDir: progress });

  assert.deepEqual(manifest.artifacts.asoValidation.map((item) => item.path).sort(), [
    'aso-validation/final-verdict.json',
    'aso-validation/poll-trail.json',
    'aso-validation/request.json',
    'aso-validation/submit-response.json',
    'aso-validation/summary.json',
  ]);
  assert.deepEqual(manifest.artifacts.sourceBuilds.map((item) => item.path), ['aem-clientlib-build-result.json']);
  assert.deepEqual(manifest.artifacts.sourceBuildLogs.map((item) => item.path), ['aem-clientlib-builder-logs']);
  assert.deepEqual(manifest.artifacts.sourceBuildDists.map((item) => item.path), ['aem-clientlib-builder-dist']);
  assert.deepEqual(manifest.integrationProviders.validation.profiles, ['local', 'validate-aso']);
  assert.deepEqual(manifest.integrationProviders.validation.providers, ['cwv-validate', 'oracle', 'aso-shallow-validator']);
  assert.ok(manifest.integrationProviders.validation.artifacts.includes('aso-validation/summary.json'));
  assert.equal(manifest.validationLayers.layers.runtime.status, 'passed');
  assert.equal(manifest.validationLayers.layers.sourceBuild.status, 'passed');
  assert.equal(manifest.validationLayers.layers.aso.status, 'passed');
  assert.equal(manifest.validationLayers.layers.aemDeployment.status, 'missing');
  assert.deepEqual(
    manifest.validationLayers.warnings.map((warning) => warning.code),
    ['aem-deployment-revalidation-missing'],
  );
  const builderEntry = manifest.validationArtifactIndex.find((entry) => (
    entry.validationLayer === 'sourceBuild'
    && entry.path === 'aem-clientlib-build-result.json'
  ));
  assert.equal(builderEntry.summary.status, 'passed');
  assert.equal(builderEntry.summary.stderrLogCount, 1);
  assert.ok(manifest.validationArtifactIndex.some((entry) => (
    entry.validationLayer === 'sourceBuild'
    && entry.kind === 'aem-clientlib-builder-logs'
    && entry.exists === true
    && entry.type === 'directory'
  )));
  assert.ok(manifest.validationArtifactIndex.some((entry) => (
    entry.validationLayer === 'aso'
    && entry.path === 'aso-validation/summary.json'
    && entry.summary.status === 'passed'
  )));
});

test('buildManifest treats zero-exit builder steps as source-build success without requiring a success flag', () => {
  const root = mkTempDir();
  const { progress } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'aem-clientlib-build-result.json'), {
    schemaVersion: '1.0',
    tool: 'aem-clientlib-build.js',
    provider: 'aem-clientlib-builder',
    steps: [
      { goal: 'npm install', exitCode: 0 },
      { goal: 'npm build', exitCode: 0, stderrLogFile: 'aem-clientlib-builder-logs/npm-build.stderr.log' },
    ],
  });

  const manifest = buildManifest({ progressDir: progress });
  const builderEntry = manifest.validationArtifactIndex.find((entry) => (
    entry.validationLayer === 'sourceBuild'
    && entry.path === 'aem-clientlib-build-result.json'
  ));

  assert.equal(manifest.validationLayers.layers.sourceBuild.status, 'passed');
  assert.equal(builderEntry.summary.status, 'passed');
  assert.equal(builderEntry.summary.stderrLogCount, 1);
});

test('buildManifest infers source-s3 only from source-fetch manifests', () => {
  const root = mkTempDir();
  const { progress } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'source', '.cwv-source-manifest.json'), {
    schemaVersion: '1.0',
    tool: 'source-fetch',
    siteId: 'site-123',
    localPath: path.join(progress, 'source'),
  });

  const manifest = buildManifest({ progressDir: progress });

  assert.equal(manifest.integrationProviders.source.status, 'used');
  assert.deepEqual(manifest.integrationProviders.source.profiles, ['source-s3']);
  assert.deepEqual(manifest.integrationProviders.source.providers, ['source-fetch']);
  assert.deepEqual(manifest.integrationProviders.source.artifacts, ['source/.cwv-source-manifest.json']);
});

test('buildManifest does not mislabel eds-source-fetch manifests as source-s3', () => {
  const root = mkTempDir();
  const { progress } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'source', '.cwv-source-manifest.json'), {
    schemaVersion: '1.0',
    tool: 'eds-source-fetch',
    source: 'prod-reconstruction',
    localPath: path.join(progress, 'source'),
  });

  const manifest = buildManifest({ progressDir: progress });

  assert.equal(manifest.integrationProviders.source.status, 'used');
  assert.deepEqual(manifest.integrationProviders.source.profiles, ['local']);
  assert.deepEqual(manifest.integrationProviders.source.providers, ['eds-source-fetch']);
  assert.deepEqual(manifest.integrationProviders.source.artifacts, ['source/.cwv-source-manifest.json']);
  assert.deepEqual(manifest.integrationProviders.source.notes, ['prod-reconstruction']);
});

test('buildManifest reports unknown source manifests without inventing a profile', () => {
  const root = mkTempDir();
  const { progress } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'source', '.cwv-source-manifest.json'), {
    schemaVersion: '1.0',
    tool: 'third-party-source-fetch',
    localPath: path.join(progress, 'source'),
  });

  const manifest = buildManifest({ progressDir: progress });

  assert.equal(manifest.integrationProviders.source.status, 'used');
  assert.deepEqual(manifest.integrationProviders.source.profiles, []);
  assert.deepEqual(manifest.integrationProviders.source.providers, ['third-party-source-fetch']);
  assert.deepEqual(manifest.integrationProviders.source.notes, ['unmapped source manifest tool']);
});

test('buildManifest accepts source-mapper absolute source edit paths under the source repo', () => {
  const root = mkTempDir();
  const { progress, sourceRepo } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'validate-findings.json'), mkEnvelope('cwv-validate', [
    mkValidatedFinding({
      sourceEdits: [
        { file: path.join(sourceRepo, 'scripts', 'theme.js'), before: '.show(e)', after: '.show()', line: 42 },
      ],
    }),
  ]));

  const manifest = buildManifest({
    progressDir: progress,
    sourceRepo,
    branchMode: 'per-fix',
    branchPrefix: 'perf',
  });

  assert.equal(manifest.localCompletion.status, 'complete');
  assert.equal(manifest.localCompletion.branchOutputPassed, true);
  const branch = manifest.branchOutput.branches[0];
  assert.deepEqual(branch.sourceEdits.files, ['scripts/theme.js']);
  const patchPath = path.join(progress, branch.patchFile);
  assert.match(fs.readFileSync(patchPath, 'utf8'), /diff --git a\/scripts\/theme\.js b\/scripts\/theme\.js/);
  const check = spawnSync('git', ['-C', sourceRepo, 'apply', '--check', patchPath], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});

test('buildManifest creates requested local branch refs and records branch success', () => {
  const root = mkTempDir();
  const { progress, sourceRepo } = seedProgressFixture(root);

  const manifest = buildManifest({
    progressDir: progress,
    sourceRepo,
    branchMode: 'per-fix',
    branchPrefix: 'perf',
    createBranches: true,
  });

  assert.equal(manifest.localCompletion.status, 'complete');
  assert.equal(manifest.localCompletion.branchOutputPassed, true);
  assert.equal(manifest.localCompletion.branchCreationPassed, true);
  assert.equal(manifest.localCompletion.branchPatchGenerationPassed, true);
  assert.deepEqual(manifest.localCompletion.branchCreationFailures, []);
  const branch = manifest.branchOutput.branches[0];
  assert.equal(branch.git.status, 'created');
  assert.equal(branch.git.created, true);

  const showRef = spawnSync('git', ['-C', sourceRepo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch.branch}`], { encoding: 'utf8' });
  assert.equal(showRef.status, 0, showRef.stderr || showRef.stdout);
});

test('buildManifest blocks local completion when requested branch creation fails', () => {
  const root = mkTempDir();
  const { progress, sourceRepo } = seedProgressFixture(root);

  const manifest = buildManifest({
    progressDir: progress,
    sourceRepo,
    branchMode: 'per-fix',
    branchPrefix: 'bad prefix',
    createBranches: true,
  });

  assert.equal(manifest.localCompletion.status, 'blocked');
  assert.equal(manifest.localCompletion.findingValidationPassed, true);
  assert.equal(manifest.localCompletion.branchOutputPassed, false);
  assert.equal(manifest.localCompletion.branchCreationPassed, false);
  assert.deepEqual(manifest.localCompletion.blockedReasons, ['branch-creation-failed']);
  assert.equal(manifest.localCompletion.branchCreationFailures.length, 1);
  assert.equal(manifest.localCompletion.branchCreationFailures[0].branch, 'bad prefix/example-com-validate-cls-banner');
  assert.equal(manifest.branchOutput.branches[0].git.status, 'failed');
});

test('buildManifest records stale source-edit anchors as blocked patch output without aborting', () => {
  const root = mkTempDir();
  const { progress, sourceRepo } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'validate-findings.json'), mkEnvelope('cwv-validate', [
    mkValidatedFinding({
      sourceEdits: [
        { file: 'scripts/theme.js', before: '.missing(e)', after: '.show()', line: 42 },
      ],
    }),
  ]));

  const manifest = buildManifest({
    progressDir: progress,
    sourceRepo,
    branchMode: 'per-fix',
    branchPrefix: 'perf',
  });

  assert.equal(manifest.localCompletion.status, 'blocked');
  assert.equal(manifest.localCompletion.findingValidationPassed, true);
  assert.equal(manifest.localCompletion.branchOutputPassed, false);
  assert.equal(manifest.localCompletion.branchPatchGenerationPassed, false);
  assert.deepEqual(manifest.localCompletion.blockedReasons, ['branch-patch-generation-failed']);
  assert.equal(manifest.localCompletion.branchPatchGenerationFailures.length, 1);
  assert.match(manifest.localCompletion.branchPatchGenerationFailures[0].error, /anchor not found/);
  assert.equal(manifest.branchOutput.branches[0].patch.status, 'failed');
});

test('buildManifest blocks local completion when source edits produce an empty patch', () => {
  const root = mkTempDir();
  const { progress, sourceRepo } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'validate-findings.json'), mkEnvelope('cwv-validate', [
    mkValidatedFinding({
      sourceEdits: [
        { file: 'scripts/theme.js', before: '.show(e)', after: '.show(e)', line: 42 },
      ],
    }),
  ]));

  const manifest = buildManifest({
    progressDir: progress,
    sourceRepo,
    branchMode: 'per-fix',
    branchPrefix: 'perf',
  });

  assert.equal(manifest.localCompletion.status, 'blocked');
  assert.equal(manifest.localCompletion.branchOutputPassed, false);
  assert.equal(manifest.localCompletion.branchPatchGenerationPassed, false);
  assert.match(manifest.localCompletion.branchPatchGenerationFailures[0].error, /empty patch/);
  const branch = manifest.branchOutput.branches[0];
  assert.equal(branch.patch.status, 'failed');
  assert.equal(fs.existsSync(path.join(progress, branch.patchFile)), false);
});

test('buildManifest can aggregate validated edits into one cumulative branch plan', () => {
  const root = mkTempDir();
  const { progress, sourceRepo } = seedProgressFixture(root);
  const env = mkEnvelope('cwv-validate', [
    mkValidatedFinding({ id: 'validate-cls-banner' }),
    mkValidatedFinding({
      id: 'validate-lcp-hero',
      metric: ['LCP'],
      impactReduction: { metric: 'LCP', valueMs: 600 },
      sourceEdits: [{ file: 'head.html', before: '</head>', after: '<link rel="preload" href="/hero.jpg" as="image">\n</head>', line: 8 }],
    }),
  ]);
  writeJsonFile(path.join(progress, 'validate-findings.json'), env);

  const manifest = buildManifest({
    progressDir: progress,
    sourceRepo,
    branchMode: 'cumulative',
    branchPrefix: 'perf',
  });

  assert.equal(manifest.branchOutput.branches.length, 1);
  const branch = manifest.branchOutput.branches[0];
  assert.equal(branch.branch, 'perf/example-com-cumulative');
  assert.deepEqual(branch.findingIds, ['validate-cls-banner', 'validate-lcp-hero']);
  assert.equal(branch.sourceEdits.count, 2);
  assert.equal(branch.patchFile, 'source-patches/cumulative.diff');
  const check = spawnSync('git', ['-C', sourceRepo, 'apply', '--check', path.join(progress, branch.patchFile)], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});

test('sourceEditsToGitPatch emits git-applicable insertion and deletion hunks', () => {
  const root = mkTempDir();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['-C', repo, 'init'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'style.css'), '.old {\n  color: red;\n}\n.keep {}\n', 'utf8');

  const diff = sourceEditsToGitPatch([
    { file: 'style.css', before: '', after: '/* inserted */\n', line: 1 },
    { file: 'style.css', before: '.old {\n  color: red;\n}\n', after: '', line: 2 },
  ], repo);
  const patch = path.join(root, 'patch.diff');
  fs.writeFileSync(patch, `${diff}\n`, 'utf8');
  const check = spawnSync('git', ['-C', repo, 'apply', '--check', patch], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});

test('sourceEditsToGitPatch preserves header-like content lines in git-applicable hunks', () => {
  const root = mkTempDir();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['-C', repo, 'init'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'copy.txt'), [
    '--- keep this literal line',
    '+++ keep this literal line',
    'target: old',
    'tail',
    '',
  ].join('\n'), 'utf8');

  const diff = sourceEditsToGitPatch([
    { file: 'copy.txt', before: 'target: old', after: 'target: new', line: 3 },
  ], repo);
  assert.match(diff, /\n --- keep this literal line\n/);
  assert.match(diff, /\n \+\+\+ keep this literal line\n/);
  const patch = path.join(root, 'patch.diff');
  fs.writeFileSync(patch, `${diff}\n`, 'utf8');
  const check = spawnSync('git', ['-C', repo, 'apply', '--check', patch], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});

test('sourceEditsToGitPatch rejects absolute source edit paths outside the source repo', () => {
  const root = mkTempDir();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  assert.throws(
    () => sourceEditsToGitPatch([
      { file: path.join(root, 'outside.js'), before: 'x', after: 'y' },
    ], repo),
    /escapes source repo/,
  );
});

test('buildManifest blocks local completion when a Finding envelope is invalid', () => {
  const root = mkTempDir();
  const { progress } = seedProgressFixture(root);
  const invalid = mkEnvelope('cwv-diagnose', [
    mkDiagnoseFinding({ confidence: 5 }),
  ]);
  writeJsonFile(path.join(progress, 'diagnose-findings.json'), invalid);

  const manifest = buildManifest({ progressDir: progress });

  assert.equal(manifest.localCompletion.status, 'blocked');
  assert.equal(manifest.localCompletion.findingValidationPassed, false);
  assert.deepEqual(manifest.localCompletion.invalidFindingFiles, ['diagnose-findings.json']);
  const diagnoseValidation = manifest.findingValidation.find((entry) => entry.file === 'diagnose-findings.json');
  assert.ok(diagnoseValidation.errors.some((error) => /confidence/.test(error)));
});

test('buildManifest does not generate branch artifacts from invalid Finding envelopes', () => {
  const root = mkTempDir();
  const { progress, sourceRepo } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'validate-findings.json'), mkEnvelope('cwv-validate', [
    mkValidatedFinding({ confidence: 5 }),
  ]));

  const manifest = buildManifest({
    progressDir: progress,
    sourceRepo,
    branchMode: 'per-fix',
    branchPrefix: 'perf',
    createBranches: true,
  });

  assert.equal(manifest.localCompletion.status, 'blocked');
  assert.equal(manifest.localCompletion.findingValidationPassed, false);
  assert.equal(manifest.localCompletion.branchOutputPassed, true);
  assert.deepEqual(manifest.localCompletion.blockedReasons, ['finding-validation-failed']);
  assert.deepEqual(manifest.branchOutput.branches, []);
  assert.deepEqual(manifest.artifacts.validatedFindings, []);
  assert.equal(manifest.artifacts.sourceEdits.some((item) => item.findingId === 'validate-cls-banner'), false);
  assert.equal(fs.existsSync(path.join(progress, 'source-patches', 'validate-cls-banner.diff')), false);

  const showRef = spawnSync('git', ['-C', sourceRepo, 'show-ref', '--verify', '--quiet', 'refs/heads/perf/example-com-validate-cls-banner'], { encoding: 'utf8' });
  assert.notEqual(showRef.status, 0);
});

test('buildManifest suppresses branch side effects when any Finding file is invalid', () => {
  const root = mkTempDir();
  const { progress, sourceRepo } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'diagnose-findings.json'), mkEnvelope('cwv-diagnose', [
    mkDiagnoseFinding({ confidence: 5 }),
  ]));

  const manifest = buildManifest({
    progressDir: progress,
    sourceRepo,
    branchMode: 'per-fix',
    branchPrefix: 'perf',
    createBranches: true,
  });

  assert.equal(manifest.localCompletion.status, 'blocked');
  assert.equal(manifest.localCompletion.findingValidationPassed, false);
  assert.deepEqual(manifest.localCompletion.blockedReasons, ['finding-validation-failed']);
  assert.deepEqual(manifest.branchOutput.branches, []);
  assert.equal(fs.existsSync(path.join(progress, 'source-patches', 'validate-cls-banner.diff')), false);

  const showRef = spawnSync('git', ['-C', sourceRepo, 'show-ref', '--verify', '--quiet', 'refs/heads/perf/example-com-validate-cls-banner'], { encoding: 'utf8' });
  assert.notEqual(showRef.status, 0);
});

test('buildManifest suppresses empty cumulative branch side effects when validation fails', () => {
  const root = mkTempDir();
  const { progress, sourceRepo } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'diagnose-findings.json'), mkEnvelope('cwv-diagnose', [
    mkDiagnoseFinding({ confidence: 5 }),
  ]));

  const manifest = buildManifest({
    progressDir: progress,
    sourceRepo,
    branchMode: 'cumulative',
    branchPrefix: 'perf',
    createBranches: true,
    writePatches: false,
  });

  assert.equal(manifest.localCompletion.status, 'blocked');
  assert.equal(manifest.localCompletion.findingValidationPassed, false);
  assert.deepEqual(manifest.localCompletion.blockedReasons, ['finding-validation-failed']);
  assert.deepEqual(manifest.branchOutput.branches, []);

  const showRef = spawnSync('git', ['-C', sourceRepo, 'show-ref', '--verify', '--quiet', 'refs/heads/perf/example-com-cumulative'], { encoding: 'utf8' });
  assert.notEqual(showRef.status, 0);
});

test('buildManifest ignores screenshot evidence paths that escape the progress directory', () => {
  const root = mkTempDir();
  const { progress } = seedProgressFixture(root);
  const outsideScreenshot = path.join(root, 'progress', 'outside.png');
  fs.writeFileSync(outsideScreenshot, 'outside progress slug');
  writeJsonFile(path.join(progress, 'validate-findings.json'), mkEnvelope('cwv-validate', [
    mkValidatedFinding({
      evidence: [
        { kind: 'measurement-delta', data: { metric: 'CLS', baseline: 0.14, treatment: 0, deltaScore: -0.14, runs: 15 } },
        { kind: 'screenshot', data: { path: 'screenshots/../../outside.png', phase: 'escape' } },
        { kind: 'screenshot', data: { path: 'screenshots/missing.png', phase: 'missing' } },
      ],
    }),
  ]));

  const manifest = buildManifest({ progressDir: progress });

  assert.equal(manifest.localCompletion.status, 'complete');
  assert.equal(manifest.artifacts.screenshots.some((item) => item.path.includes('outside.png')), false);
  assert.ok(manifest.artifacts.screenshots.some((item) => (
    item.path === 'screenshots/missing.png' && item.exists === false
  )));
  assert.ok(manifest.artifacts.screenshots.some((item) => item.path === 'screenshots/treatment.png'));
});

test('buildManifest validates cwv-analyze Finding envelopes', () => {
  const root = mkTempDir();
  const { progress } = seedProgressFixture(root);
  writeJsonFile(path.join(progress, 'analyze-findings.json'), mkEnvelope('cwv-analyze', [
    mkDiagnoseFinding({
      id: 'analyze-lcp-hero',
      skill: 'cwv-analyze',
    }),
  ]));

  const manifest = buildManifest({ progressDir: progress });

  assert.equal(manifest.localCompletion.status, 'complete');
  const analyzeValidation = manifest.findingValidation.find((entry) => entry.file === 'analyze-findings.json');
  assert.equal(analyzeValidation.valid, true);
  assert.equal(analyzeValidation.findingCount, 1);
  assert.ok(manifest.artifacts.findingFiles.some((item) => item.path === 'analyze-findings.json'));
});

test('writeJson writes a manifest file with a trailing newline', () => {
  const root = mkTempDir();
  const file = path.join(root, 'out', 'manifest.json');
  writeJson(file, { ok: true });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "ok": true\n}\n');
});

test('CLI exits 2 for invalid flags and missing values', () => {
  const unknown = spawnSync('node', [LOCAL_ARTIFACTS_CLI, '--wat'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown flag: --wat/);

  const missing = spawnSync('node', [LOCAL_ARTIFACTS_CLI, '--progress'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Missing value for --progress/);

  const positional = spawnSync('node', [LOCAL_ARTIFACTS_CLI, 'progress/example'], { encoding: 'utf8' });
  assert.equal(positional.status, 2);
  assert.match(positional.stderr, /Unexpected positional argument: progress\/example/);

  const invalidMode = spawnSync('node', [
    LOCAL_ARTIFACTS_CLI,
    '--progress',
    mkTempDir(),
    '--branch-mode',
    'banana',
  ], { encoding: 'utf8' });
  assert.equal(invalidMode.status, 2);
  assert.match(invalidMode.stderr, /Invalid --branch-mode "banana"/);
});

test('CLI exits 4 when requested branch creation fails after writing manifest', () => {
  const root = mkTempDir();
  const { progress, sourceRepo } = seedProgressFixture(root);
  const output = path.join(progress, 'artifacts-manifest.json');

  const result = spawnSync('node', [
    LOCAL_ARTIFACTS_CLI,
    '--progress',
    progress,
    '--source-repo',
    sourceRepo,
    '--branch-mode',
    'per-fix',
    '--branch-prefix',
    'bad prefix',
    '--create-branches',
    '--output',
    output,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 4, result.stderr || result.stdout);
  const manifest = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(manifest.localCompletion.status, 'blocked');
  assert.equal(manifest.localCompletion.branchOutputPassed, false);
  assert.equal(manifest.localCompletion.branchCreationPassed, false);
});

test('CLI exits 4 when patch generation fails after writing manifest', () => {
  const root = mkTempDir();
  const { progress, sourceRepo } = seedProgressFixture(root);
  const output = path.join(progress, 'artifacts-manifest.json');
  writeJsonFile(path.join(progress, 'validate-findings.json'), mkEnvelope('cwv-validate', [
    mkValidatedFinding({
      sourceEdits: [
        { file: 'scripts/theme.js', before: '.missing(e)', after: '.show()', line: 42 },
      ],
    }),
  ]));

  const result = spawnSync('node', [
    LOCAL_ARTIFACTS_CLI,
    '--progress',
    progress,
    '--source-repo',
    sourceRepo,
    '--branch-mode',
    'per-fix',
    '--output',
    output,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 4, result.stderr || result.stdout);
  const manifest = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(manifest.localCompletion.status, 'blocked');
  assert.equal(manifest.localCompletion.branchPatchGenerationPassed, false);
});

test('branch-name helpers produce git-friendly deterministic names', () => {
  assert.equal(sanitizeSegment('Validate CLS Banner!'), 'validate-cls-banner');
  assert.equal(makeBranchName('perf/', 'Example.com / Home', 'Fix #1'), 'perf/example.com-home-fix-1');
  assert.equal(makeBranchName('', 'example', 'fix'), 'example-fix');
});

test('isGitRepo accepts linked worktree .git file markers', () => {
  const root = mkTempDir();
  const repo = path.join(root, 'linked-worktree');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /tmp/main/.git/worktrees/linked-worktree\n');
  assert.equal(isGitRepo(repo), true);
});

test('patch-dir stays under the progress directory', () => {
  const root = mkTempDir();
  const progress = path.join(root, 'progress', 'example');
  fs.mkdirSync(progress, { recursive: true });
  assert.equal(makePatchRelativePath(progress, 'nested/patches', 'Fix 1'), 'nested/patches/fix-1.diff');
  assert.throws(
    () => makePatchRelativePath(progress, '../escape', 'Fix 1'),
    /progress dir/,
  );
  assert.throws(
    () => buildManifest({
      progressDir: seedProgressFixture(root).progress,
      sourceRepo: path.join(root, 'source'),
      branchMode: 'per-fix',
      patchDir: '../escape',
    }),
    /progress dir/,
  );
});
