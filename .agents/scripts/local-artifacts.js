#!/usr/bin/env node

/**
 * local-artifacts.js — assemble the local handoff manifest for a CWV run.
 *
 * The default `local` execution profile ends in files under progress/{slug}/
 * plus optional source diffs/branch plans. This module indexes those files,
 * validates every emitted Finding envelope, and writes a single manifest that
 * can be handed to an engineer without requiring SpaceCat persistence. The
 * manifest also records which optional provider profiles fed the run.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { validateEnvelope } from './finding-schema.js';
import { deriveStructuralGate } from './rank-candidates.js';
import { buildValidationLayerSummary } from './validation-layers.js';

const HELP = `
local-artifacts.js — progress/{slug} → artifacts-manifest.json

Usage:
  node .agents/scripts/local-artifacts.js --progress progress/<slug> [flags]

Flags:
  --progress <dir>            Run directory to index (required)
  --output <path>             Write manifest JSON (default: stdout)
  --source-repo <path>        Optional local source git repo for branch output
  --branch-mode <mode>        none | per-fix | cumulative (default: none)
  --branch-prefix <prefix>    Branch prefix for source handoff (default: perf)
  --patch-dir <rel>           Patch file directory under progress dir (default: source-patches)
  --create-branches           Create local git branch refs in --source-repo
  --no-write-patches          Do not write generated source patch files
  --help                      Print this help and exit 0

Exit codes:
  0 = manifest emitted and Finding validation passed
  1 = input / write error
  2 = invalid flags
  3 = manifest emitted but at least one Finding envelope failed validation
  4 = manifest emitted but requested branch/patch output failed
`;

const FINDING_FILE_RE = /(?:^|\/)(triage|diagnose|analyze|fix|validate)-findings\.json$/;
const IMAGE_FILE_RE = /\.(png|jpe?g|webp)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'source']);
const BRANCH_MODES = new Set(['none', 'per-fix', 'cumulative']);

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

function parseArgs(argv) {
  const args = {
    progress: null,
    output: null,
    sourceRepo: null,
    branchMode: 'none',
    branchPrefix: 'perf',
    patchDir: 'source-patches',
    createBranches: false,
    writePatches: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (flag) => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new UsageError(`Missing value for ${flag}`);
      return value;
    };
    switch (a) {
      case '--help': case '-h': args.help = true; break;
      case '--progress': args.progress = next(a); break;
      case '--output': args.output = next(a); break;
      case '--source-repo': args.sourceRepo = next(a); break;
      case '--branch-mode': args.branchMode = next(a); break;
      case '--branch-prefix': args.branchPrefix = next(a); break;
      case '--patch-dir': args.patchDir = next(a); break;
      case '--create-branches': args.createBranches = true; break;
      case '--no-write-patches': args.writePatches = false; break;
      default:
        if (a && a.startsWith('--')) throw new UsageError(`Unknown flag: ${a}`);
        if (a) throw new UsageError(`Unexpected positional argument: ${a}`);
    }
  }
  if (!BRANCH_MODES.has(args.branchMode)) {
    throw new UsageError(`Invalid --branch-mode "${args.branchMode}". Valid: ${Array.from(BRANCH_MODES).join(', ')}`);
  }
  return args;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function relPath(root, file) {
  return toPosix(path.relative(root, file));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeStat(file) {
  try {
    const st = fs.statSync(file);
    return {
      bytes: st.size,
      mtime: st.mtime.toISOString(),
    };
  } catch {
    return {};
  }
}

function fileRecord(progressDir, relativePath, kind) {
  const absolute = path.join(progressDir, relativePath);
  if (!fs.existsSync(absolute)) return null;
  return {
    path: toPosix(relativePath),
    kind,
    ...safeStat(absolute),
  };
}

function artifactRecord(progressDir, relativePath, kind, { includeMissing = false } = {}) {
  const normalized = toPosix(relativePath);
  const absolute = path.join(progressDir, normalized);
  if (!fs.existsSync(absolute)) {
    return includeMissing ? {
      path: normalized,
      kind,
      exists: false,
    } : null;
  }
  const st = fs.statSync(absolute);
  return {
    path: normalized,
    kind,
    exists: true,
    type: st.isDirectory() ? 'directory' : 'file',
    bytes: st.size,
    mtime: st.mtime.toISOString(),
  };
}

function addUniqueRecord(list, seen, record) {
  if (!record || seen.has(record.path)) return;
  seen.add(record.path);
  list.push(record);
}

function listFiles(root, { maxDepth = 5, maxFiles = 5000 } = {}) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  walk(root, 0);
  return out;
}

function extractFindings(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.findings)) return obj.findings;
  if (obj.id && obj.cause) return [obj];
  return [];
}

function summarizeSourceEdits(sourceEdits) {
  const edits = Array.isArray(sourceEdits) ? sourceEdits : [];
  return {
    count: edits.length,
    files: [...new Set(edits.map((edit) => edit && edit.file).filter(Boolean))],
  };
}

function summarizeRepoSourceEdits(sourceEdits, sourceRepo) {
  const edits = Array.isArray(sourceEdits) ? sourceEdits : [];
  return {
    count: edits.length,
    files: [...new Set(edits.map((edit) => (
      normalizeSourceFile(sourceRepo, edit && edit.file).relativeFile
    )))],
  };
}

function summarizeFinding(finding, findingFile) {
  return {
    id: finding.id,
    status: finding.status,
    metric: Array.isArray(finding.metric) ? finding.metric : [],
    findingFile,
    sourceEdits: summarizeSourceEdits(finding.sourceEdits),
  };
}

function normalizeStringList(value) {
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const item of raw.flat(Infinity)) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeProviderSlot(explicit, fallback = {}) {
  const raw = explicit && typeof explicit === 'object' ? explicit : {};
  const profiles = normalizeStringList(raw.profiles || raw.profile);
  const providers = normalizeStringList(raw.providers || raw.provider);
  const artifacts = normalizeStringList(raw.artifacts || raw.artifact);
  const notes = normalizeStringList(raw.notes || raw.note);
  const slot = {
    status: raw.status || fallback.status || 'not-used',
    profiles: profiles.length > 0 ? profiles : normalizeStringList(fallback.profiles || fallback.profile),
    providers: providers.length > 0 ? providers : normalizeStringList(fallback.providers || fallback.provider),
    artifacts: artifacts.length > 0 ? artifacts : normalizeStringList(fallback.artifacts || fallback.artifact),
  };

  const fallbackNotes = normalizeStringList(fallback.notes || fallback.note);
  if (notes.length > 0 || fallbackNotes.length > 0) {
    slot.notes = notes.length > 0 ? notes : fallbackNotes;
  }

  const calls = Array.isArray(raw.spaceCatApiCalls)
    ? raw.spaceCatApiCalls
    : (Array.isArray(fallback.spaceCatApiCalls) ? fallback.spaceCatApiCalls : null);
  if (calls) slot.spaceCatApiCalls = calls;

  return slot;
}

function sourceManifestRecord(progressDir, sourceRepo) {
  const candidates = [
    path.join(progressDir, 'source', '.cwv-source-manifest.json'),
    sourceRepo && path.join(sourceRepo, '.cwv-source-manifest.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const progressRoot = path.resolve(progressDir);
    const resolved = path.resolve(candidate);
    const artifact = resolved.startsWith(`${progressRoot}${path.sep}`)
      ? toPosix(path.relative(progressRoot, resolved))
      : resolved;
    let manifest = null;
    try {
      manifest = readJson(candidate);
    } catch {
      // Keep the artifact visible even if the manifest is malformed.
    }
    return { path: artifact, manifest };
  }
  return null;
}

function inferFieldProviderSlot(validFindings) {
  const profileBySource = {
    rum: 'field-aem-rum',
    crux: 'field-google',
    psi: 'field-google',
  };
  const providerBySource = {
    rum: 'rum-fetch',
    crux: 'crux',
    psi: 'pagespeed-insights',
  };
  const profiles = [];
  const providers = [];
  const artifacts = [];
  for (const { finding, file } of validFindings) {
    const source = finding && finding.source;
    if (!profileBySource[source]) continue;
    profiles.push(profileBySource[source]);
    providers.push(providerBySource[source]);
    artifacts.push(file);
  }
  const uniqueProfiles = normalizeStringList(profiles);
  return {
    status: uniqueProfiles.length > 0 ? 'used' : 'not-used',
    profiles: uniqueProfiles,
    providers: normalizeStringList(providers),
    artifacts: normalizeStringList(artifacts),
  };
}

function inferSourceProviderSlot({ progressDir, sourceRepo }) {
  const sourceManifest = sourceManifestRecord(progressDir, sourceRepo);
  if (sourceManifest) {
    const tool = sourceManifest.manifest && sourceManifest.manifest.tool;
    if (tool === 'source-fetch') {
      return {
        status: 'used',
        profiles: ['source-s3'],
        providers: ['source-fetch'],
        artifacts: [sourceManifest.path],
      };
    }
    if (tool === 'eds-source-fetch') {
      return {
        status: 'used',
        profiles: ['local'],
        providers: ['eds-source-fetch'],
        artifacts: [sourceManifest.path],
        notes: ['prod-reconstruction'],
      };
    }
    return {
      status: 'used',
      profiles: [],
      providers: [tool || 'unknown-source-manifest'],
      artifacts: [sourceManifest.path],
      notes: ['unmapped source manifest tool'],
    };
  }
  if (sourceRepo) {
    return {
      status: 'used',
      profiles: ['local'],
      providers: ['local-source-repo'],
      artifacts: [path.resolve(sourceRepo)],
    };
  }
  return { status: 'not-used', profiles: [], providers: [], artifacts: [] };
}

function inferDiagnosisProviderSlot(findingValidations) {
  const artifacts = findingValidations
    .filter((validation) => /(?:^|\/)(diagnose|analyze)-findings\.json$/.test(validation.file))
    .map((validation) => validation.file);
  return {
    status: artifacts.length > 0 ? 'used' : 'not-used',
    profiles: artifacts.length > 0 ? ['local'] : [],
    providers: artifacts.length > 0 ? ['cwv-agent'] : [],
    artifacts,
  };
}

function inferValidationProviderSlot({ findingValidations, artifacts }) {
  const validationArtifacts = findingValidations
    .filter((validation) => /(?:^|\/)validate-findings\.json$/.test(validation.file))
    .map((validation) => validation.file);
  const verdictArtifacts = (artifacts.verdicts || []).map((record) => record.path);
  const asoArtifacts = (artifacts.asoValidation || []).map((record) => record.path);
  const localUsed = validationArtifacts.length > 0 || verdictArtifacts.length > 0;
  const asoUsed = asoArtifacts.length > 0;
  const used = localUsed || asoUsed;
  return {
    status: used ? 'used' : 'not-used',
    profiles: normalizeStringList([
      localUsed ? 'local' : null,
      asoUsed ? 'validate-aso' : null,
    ]),
    providers: normalizeStringList([
      validationArtifacts.length > 0 ? 'cwv-validate' : null,
      verdictArtifacts.length > 0 ? 'oracle' : null,
      asoUsed ? 'aso-shallow-validator' : null,
    ]),
    artifacts: normalizeStringList([...validationArtifacts, ...verdictArtifacts, ...asoArtifacts]),
  };
}

function inferPublishingProviderSlot(artifacts) {
  const publishPlanArtifacts = (artifacts.publishPlans || []).map((record) => record.path);
  return {
    status: publishPlanArtifacts.length > 0 ? 'planned' : 'not-used',
    profiles: ['publish-spacecat'],
    providers: ['cwv-publish'],
    artifacts: publishPlanArtifacts,
    spaceCatApiCalls: [],
  };
}

function readArtifactJson(progressDir, record) {
  if (!record || !record.path) return null;
  try {
    return readJson(path.join(progressDir, record.path));
  } catch {
    return null;
  }
}

function shortJsonSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const key of [
    'schemaVersion',
    'kind',
    'tool',
    'provider',
    'status',
    'verdict',
    'success',
    'mutatesBackend',
    'confirmBeforeWriteRequired',
    'siteId',
    'jobId',
    'requestId',
  ]) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function summarizeBuilderResult(result) {
  if (!result || typeof result !== 'object') return null;
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const failedSteps = steps.filter((step) => step && step.exitCode !== 0);
  const zeroExitSteps = steps.length > 0 && failedSteps.length === 0;
  const success = result.success === true || zeroExitSteps;
  return {
    status: success ? 'passed' : (result.success === false || failedSteps.length > 0 ? 'failed' : 'unknown'),
    success,
    stepCount: steps.length,
    failedStepCount: failedSteps.length,
    stderrLogCount: steps.filter((step) => step && step.stderrLogFile).length,
    logsDir: result.logsDir || null,
    distDir: result.distDir || null,
  };
}

function summarizeAsoArtifact(record, data) {
  if (!data) return null;
  const base = path.posix.basename(record.path);
  if (base === 'poll-trail.json' && Array.isArray(data)) {
    const last = data[data.length - 1] || null;
    return {
      status: data.length > 0 ? 'recorded' : 'empty',
      pollCount: data.length,
      lastStatus: last && (last.status || last.verdict || last.state) || null,
    };
  }
  if (base === 'final-verdict.json' || base === 'summary.json') {
    const verdict = String(data.verdict || data.status || '').toUpperCase();
    return {
      status: ['PASS', 'PASSED', 'VALIDATED'].includes(verdict)
        ? 'passed'
        : (verdict ? 'failed' : 'unknown'),
      ...shortJsonSummary(data),
    };
  }
  return {
    status: 'recorded',
    ...shortJsonSummary(data),
  };
}

function summarizePublishArtifact(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    status: data.mutatesBackend === false ? 'draft' : (data.publishState || data.status || 'recorded'),
    kind: data.kind || null,
    metric: data.metric || null,
    selectedUrl: data.selectedUrl || data.url || null,
    confirmBeforeWriteRequired: data.confirmBeforeWriteRequired,
    mutatesBackend: data.mutatesBackend,
    siteId: data.siteId || null,
    action: data.suggestion && data.suggestion.action || null,
    targetSuggestionId: data.suggestion && data.suggestion.targetSuggestionId || null,
  };
}

function summarizeDeploymentArtifact(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    status: data.status || data.verdict || data.result || 'recorded',
    deployedAt: data.deployedAt || data.deploymentAt || null,
    revalidatedAt: data.revalidatedAt || data.validationAt || null,
    environment: data.environment || null,
  };
}

function summarizeArtifactJson(progressDir, record) {
  const data = readArtifactJson(progressDir, record);
  if (!data) return null;
  if (record.kind === 'aem-clientlib-build-result') return summarizeBuilderResult(data);
  if (record.kind === 'aso-validation') return summarizeAsoArtifact(record, data);
  if (['diagnose-spacecat-draft', 'remediation-payload', 'publish-plan'].includes(record.kind)) {
    return summarizePublishArtifact(data);
  }
  if (record.kind === 'aem-deployment-revalidation') return summarizeDeploymentArtifact(data);
  if (record.kind === 'oracle-verdict') return shortJsonSummary(data);
  return shortJsonSummary(data);
}

function progressRelativeFromPath(progressDir, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const progressRoot = path.resolve(progressDir);
  const raw = rawPath.trim();
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(progressRoot, raw);
  if (resolved !== progressRoot && !resolved.startsWith(`${progressRoot}${path.sep}`)) return null;
  return toPosix(path.relative(progressRoot, resolved));
}

function addBuilderDirectoryRecords(progressDir, artifacts, seen) {
  const candidates = [
    { bucket: 'sourceBuildLogs', kind: 'aem-clientlib-builder-logs', path: 'aem-clientlib-builder-logs' },
    { bucket: 'sourceBuildDists', kind: 'aem-clientlib-builder-dist', path: 'aem-clientlib-builder-dist' },
  ];

  for (const record of artifacts.sourceBuilds || []) {
    const data = readArtifactJson(progressDir, record);
    if (!data || typeof data !== 'object') continue;
    const logsDir = progressRelativeFromPath(progressDir, data.logsDir);
    const distDir = progressRelativeFromPath(progressDir, data.distDir);
    if (logsDir) candidates.push({ bucket: 'sourceBuildLogs', kind: 'aem-clientlib-builder-logs', path: logsDir });
    if (distDir) candidates.push({ bucket: 'sourceBuildDists', kind: 'aem-clientlib-builder-dist', path: distDir });
  }

  for (const candidate of candidates) {
    addUniqueRecord(
      artifacts[candidate.bucket],
      seen[candidate.bucket],
      artifactRecord(progressDir, candidate.path, candidate.kind),
    );
  }
}

function buildValidationArtifactIndex({
  progressDir,
  artifacts,
  findingValidations,
  validationLayers,
}) {
  const entries = [];
  const seen = new Set();
  const add = (record, {
    provider,
    validationLayer,
    status = null,
    required = false,
    summary = undefined,
  }) => {
    if (!record) return;
    const key = `${validationLayer}:${provider}:${record.path}:${record.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    const exists = record.exists !== undefined
      ? record.exists
      : fs.existsSync(path.join(progressDir, record.path));
    const statusSummary = summary === undefined ? summarizeArtifactJson(progressDir, record) : summary;
    entries.push({
      provider,
      validationLayer,
      path: record.path,
      kind: record.kind,
      exists,
      status: status || (exists ? 'present' : (required ? 'missing' : 'skipped')),
      ...(record.type ? { type: record.type } : {}),
      ...(record.bytes !== undefined ? { bytes: record.bytes } : {}),
      ...(record.mtime ? { mtime: record.mtime } : {}),
      ...(statusSummary ? { summary: statusSummary } : {}),
    });
  };
  const addMissing = (pathValue, kind, options) => {
    add(artifactRecord(progressDir, pathValue, kind, { includeMissing: true }), options);
  };

  const validationByFile = new Map((findingValidations || []).map((validation) => [
    validation.file,
    {
      status: validation.valid ? 'valid' : 'invalid',
      findingCount: validation.findingCount,
      validatedCount: validation.validatedCount,
      sourceEditCount: validation.sourceEditCount,
      errors: validation.errors,
      warnings: validation.warnings,
    },
  ]));

  for (const record of artifacts.findingFiles || []) {
    const layer = record.path.endsWith('validate-findings.json') ? 'runtime' : 'diagnosis';
    add(record, {
      provider: record.path.endsWith('validate-findings.json') ? 'cwv-validate' : 'cwv-agent',
      validationLayer: layer,
      summary: validationByFile.get(record.path),
    });
  }
  for (const record of artifacts.baselineFiles || []) {
    add(record, { provider: 'launcher', validationLayer: 'runtime' });
  }
  for (const record of artifacts.treatmentMeasurements || []) {
    add(record, { provider: 'launcher', validationLayer: 'runtime' });
  }
  for (const record of artifacts.verdicts || []) {
    add(record, { provider: 'oracle', validationLayer: 'runtime' });
  }

  for (const record of artifacts.sourcePatches || []) {
    add(record, { provider: 'local-artifacts', validationLayer: 'sourcePatch' });
  }
  for (const record of artifacts.sourceBuilds || []) {
    add(record, { provider: 'aem-clientlib-builder', validationLayer: 'sourceBuild', required: true });
  }
  for (const record of artifacts.sourceBuildLogs || []) {
    add(record, { provider: 'aem-clientlib-builder', validationLayer: 'sourceBuild' });
  }
  for (const record of artifacts.sourceBuildDists || []) {
    add(record, { provider: 'aem-clientlib-builder', validationLayer: 'sourceBuild' });
  }
  if ((artifacts.sourceBuilds || []).length === 0) {
    addMissing('aem-clientlib-build-result.json', 'aem-clientlib-build-result', {
      provider: 'aem-clientlib-builder',
      validationLayer: 'sourceBuild',
      status: 'missing',
      required: true,
    });
  }
  if ((artifacts.sourceBuildLogs || []).length === 0) {
    addMissing('aem-clientlib-builder-logs', 'aem-clientlib-builder-logs', {
      provider: 'aem-clientlib-builder',
      validationLayer: 'sourceBuild',
      status: 'missing',
      required: true,
    });
  }
  if ((artifacts.sourceBuildDists || []).length === 0) {
    addMissing('aem-clientlib-builder-dist', 'aem-clientlib-builder-dist', {
      provider: 'aem-clientlib-builder',
      validationLayer: 'sourceBuild',
      status: 'missing',
      required: true,
    });
  }

  const asoExpected = [
    'request.json',
    'submit-response.json',
    'poll-trail.json',
    'final-verdict.json',
    'summary.json',
  ];
  for (const record of artifacts.asoValidation || []) {
    add(record, { provider: 'aso-shallow-validator', validationLayer: 'aso' });
  }
  for (const name of asoExpected) {
    if (!(artifacts.asoValidation || []).some((record) => record.path === `aso-validation/${name}`)) {
      addMissing(`aso-validation/${name}`, 'aso-validation', {
        provider: 'aso-shallow-validator',
        validationLayer: 'aso',
        status: 'skipped',
      });
    }
  }

  for (const record of [
    ...(artifacts.diagnoseDrafts || []),
    ...(artifacts.remediationPayloads || []),
    ...(artifacts.publishPlans || []),
  ]) {
    add(record, { provider: 'cwv-publish', validationLayer: 'publishing' });
  }
  if ((artifacts.publishPlans || []).length === 0) {
    addMissing('publish-plan.json', 'publish-plan', {
      provider: 'cwv-publish',
      validationLayer: 'publishing',
      status: 'skipped',
    });
  }

  for (const record of artifacts.aemDeployment || []) {
    add(record, { provider: 'aem', validationLayer: 'aemDeployment' });
  }
  if ((artifacts.aemDeployment || []).length === 0) {
    addMissing('aem-deployment-revalidation.json', 'aem-deployment-revalidation', {
      provider: 'aem',
      validationLayer: 'aemDeployment',
      status: 'skipped',
    });
  }

  add({
    path: '#/validationLayers',
    kind: 'validation-layer-summary',
    exists: true,
  }, {
    provider: 'cwv-agent',
    validationLayer: 'all',
    summary: {
      target: validationLayers.target,
      layers: Object.fromEntries(Object.entries(validationLayers.layers || {}).map(([key, layerValue]) => [
        key,
        layerValue.status,
      ])),
      warnings: (validationLayers.warnings || []).map((warning) => warning.code),
    },
  });

  return entries.sort((a, b) => (
    `${a.validationLayer}:${a.provider}:${a.path}`.localeCompare(`${b.validationLayer}:${b.provider}:${b.path}`)
  ));
}

function buildManifestValidationLayers({ progressDir, artifacts, validatedFindings }) {
  const runtimeResults = [
    ...validatedFindings.map(() => ({ status: 'validated' })),
    ...(artifacts.verdicts || [])
      .map((record) => readArtifactJson(progressDir, record))
      .filter(Boolean),
  ];
  const runtimeArtifacts = normalizeStringList([
    ...validatedFindings.map((finding) => finding._findingFile),
    ...(artifacts.verdicts || []).map((record) => record.path),
  ]);
  const sourceBuildResults = (artifacts.sourceBuilds || [])
    .map((record) => readArtifactJson(progressDir, record))
    .filter(Boolean);
  const asoVerdicts = (artifacts.asoValidation || [])
    .map((record) => readArtifactJson(progressDir, record))
    .filter(Boolean)
    .map((artifact) => artifact.verdict)
    .filter(Boolean);

  return buildValidationLayerSummary({
    runtimeArtifacts,
    runtimeResults,
    sourceBuildArtifacts: (artifacts.sourceBuilds || []).map((record) => record.path),
    sourceBuildResults,
    asoArtifacts: (artifacts.asoValidation || []).map((record) => record.path),
    asoVerdicts,
    aemDeploymentArtifacts: (artifacts.aemDeployment || []).map((record) => record.path),
  });
}

function buildIntegrationProviders({
  session,
  progressDir,
  sourceRepo,
  validFindings,
  findingValidations,
  artifacts,
}) {
  const explicit = (session && typeof session === 'object' && (
    session.integrationProviders || session.providers
  )) || {};
  return {
    fieldData: normalizeProviderSlot(
      explicit.fieldData,
      inferFieldProviderSlot(validFindings),
    ),
    source: normalizeProviderSlot(
      explicit.source,
      inferSourceProviderSlot({ progressDir, sourceRepo }),
    ),
    diagnosis: normalizeProviderSlot(
      explicit.diagnosis,
      inferDiagnosisProviderSlot(findingValidations),
    ),
    validation: normalizeProviderSlot(
      explicit.validation,
      inferValidationProviderSlot({ findingValidations, artifacts }),
    ),
    publishing: normalizeProviderSlot(
      explicit.publishing,
      inferPublishingProviderSlot(artifacts),
    ),
  };
}

function readRankedPatchSummary(progressDir) {
  const file = path.join(progressDir, 'ranked_patches.json');
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function mergeStructuralGateResults(...gates) {
  const severity = { fail: 3, warn: 2, pass: 1, 'not-run': 0 };
  const result = gates.reduce((worst, gate) => (
    (severity[gate && gate.result] || 0) > (severity[worst] || 0) ? gate.result : worst
  ), 'not-run');
  const reasons = normalizeStringList(gates.flatMap((gate) => (
    gate && gate.reasons ? gate.reasons : []
  )));
  const sourceFindingIds = normalizeStringList(gates.flatMap((gate) => (
    gate && gate.sourceFindingIds ? gate.sourceFindingIds : []
  )));
  const sourceFiles = normalizeStringList(gates.flatMap((gate) => (
    gate && gate.sourceFiles ? gate.sourceFiles : []
  )));
  return {
    name: 'eds-structural-contract',
    result: result || 'not-run',
    sourceFindingIds,
    sourceFiles,
    reasons,
  };
}

function buildStructuralGateSummary({ validFindings, findingValidations, progressDir }) {
  const findingEntries = validFindings.filter(({ finding }) => (
    deriveStructuralGate([finding]).result !== 'not-run'
  ));
  const findingGate = deriveStructuralGate(validFindings.map(({ finding }) => finding));
  const fileGate = mergeStructuralGateResults(...findingValidations
    .filter((validation) => validation.valid && validation.structuralGate)
    .map((validation) => validation.structuralGate));
  const ranked = readRankedPatchSummary(progressDir);
  const rankedGate = ranked && ranked.structuralGate ? ranked.structuralGate : null;
  const gate = mergeStructuralGateResults(findingGate, fileGate, rankedGate);
  const probeOnlyCandidates = Array.isArray(ranked && ranked.candidates)
    ? ranked.candidates
      .filter((candidate) => candidate && (candidate.probeOnly || candidate.promotionBlocked))
      .map((candidate) => ({
        id: candidate.id,
        findingId: candidate.findingId || candidate.id,
        metric: candidate.metric || null,
        probeOnly: candidate.probeOnly === true,
        promotionBlocked: candidate.promotionBlocked === true,
        promotionBlockReason: candidate.promotionBlockReason || null,
      }))
    : [];
  return {
    ...gate,
    findings: findingEntries.map(({ finding, file }) => ({
      id: finding.id,
      file,
      status: finding.status,
      metric: Array.isArray(finding.metric) ? finding.metric : [],
      rootCause: finding.rootCause === true,
    })),
    probeOnlyCandidates,
  };
}

function screenshotPathsFromFindings(findings) {
  const out = [];
  for (const finding of findings) {
    for (const evidence of finding.evidence || []) {
      if (!evidence || evidence.kind !== 'screenshot' || !evidence.data) continue;
      const raw = evidence.data.path || evidence.data.file || evidence.data.screenshot;
      if (typeof raw === 'string' && raw.trim()) out.push(raw.trim());
    }
  }
  return out;
}

function validateFindingFile(progressDir, record) {
  const absolute = path.join(progressDir, record.path);
  try {
    const data = readJson(absolute);
    const validation = validateEnvelope(data);
    const findings = extractFindings(data);
    const structuralGate = deriveStructuralGate({ ...data, file: record.path });
    return {
      file: record.path,
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      findingCount: findings.length,
      validatedCount: findings.filter((finding) => finding.status === 'validated').length,
      sourceEditCount: findings.reduce((sum, finding) => (
        sum + (Array.isArray(finding.sourceEdits) ? finding.sourceEdits.length : 0)
      ), 0),
      structuralGate: structuralGate.result !== 'not-run' ? structuralGate : null,
      findings,
    };
  } catch (err) {
    return {
      file: record.path,
      valid: false,
      errors: [err && err.message ? err.message : String(err)],
      warnings: [],
      findingCount: 0,
      validatedCount: 0,
      sourceEditCount: 0,
      findings: [],
    };
  }
}

function sanitizeSegment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    || 'artifact';
}

function makeBranchName(prefix, slug, id) {
  const cleanPrefix = String(prefix || '').replace(/^\/+|\/+$/g, '');
  const tail = `${sanitizeSegment(slug)}-${sanitizeSegment(id)}`;
  return cleanPrefix ? `${cleanPrefix}/${tail}` : tail;
}

function safeProgressRelativePath(progressDir, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('progress-relative path must be a non-empty string');
  }
  if (path.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath.replace(/\\/g, '/'))) {
    throw new Error(`progress-relative path must not be absolute: ${relativePath}`);
  }
  const root = path.resolve(progressDir);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`progress-relative path escapes progress dir: ${relativePath}`);
  }
  return toPosix(path.relative(root, target));
}

function safeScreenshotRelativePath(progressDir, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const raw = rawPath.trim();
  const root = path.resolve(progressDir);
  if (path.isAbsolute(raw)) {
    const target = path.resolve(raw);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
    return toPosix(path.relative(root, target));
  }
  try {
    return safeProgressRelativePath(root, raw);
  } catch {
    return null;
  }
}

function makePatchRelativePath(progressDir, patchDir, id) {
  const rawDir = String(patchDir || 'source-patches').replace(/\\/g, '/');
  const normalizedDir = path.posix.normalize(rawDir);
  if (normalizedDir === '..' || normalizedDir.startsWith('../')) {
    throw new Error(`--patch-dir must stay under the progress dir: ${patchDir}`);
  }
  return safeProgressRelativePath(progressDir, path.posix.join(normalizedDir, `${sanitizeSegment(id)}.diff`));
}

function isGitRepo(repoPath) {
  if (!repoPath) return false;
  try {
    const marker = fs.statSync(path.join(repoPath, '.git'));
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

function normalizeSourceFile(sourceRepo, sourceFile) {
  if (typeof sourceFile !== 'string' || !sourceFile.trim()) {
    throw new Error('source edit file must be a non-empty path');
  }
  const repoRoot = path.resolve(sourceRepo);
  const rawFile = sourceFile.trim();
  const file = path.isAbsolute(rawFile) ? path.resolve(rawFile) : path.resolve(repoRoot, rawFile);
  if (file !== repoRoot && !file.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`source edit escapes source repo: ${sourceFile}`);
  }
  const relativeFile = toPosix(path.relative(repoRoot, file));
  if (!relativeFile) {
    throw new Error(`source edit file must not be the source repo root: ${sourceFile}`);
  }
  return { repoRoot, file, relativeFile };
}

function lineOffset(text, line) {
  if (typeof line !== 'number' || line <= 1) return 0;
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return offset;
}

function applyOneSourceEdit(content, edit) {
  const before = String(edit.before == null ? '' : edit.before);
  const after = String(edit.after == null ? '' : edit.after);
  if (before === '') {
    const offset = lineOffset(content, edit.line);
    return `${content.slice(0, offset)}${after}${content.slice(offset)}`;
  }

  const anchoredOffset = lineOffset(content, edit.line);
  let index = content.indexOf(before, anchoredOffset);
  if (index === -1) index = content.indexOf(before);
  if (index === -1) {
    throw new Error(`source edit anchor not found in ${edit.file}: ${JSON.stringify(before.slice(0, 80))}`);
  }
  return `${content.slice(0, index)}${after}${content.slice(index + before.length)}`;
}

function relabelDiff(rawDiff, relativeFile) {
  const oldLabel = `a/${relativeFile}`;
  const newLabel = `b/${relativeFile}`;
  let inFileHeader = false;
  let oldHeaderSeen = false;
  let newHeaderSeen = false;
  return String(rawDiff || '')
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ')) {
        inFileHeader = true;
        oldHeaderSeen = false;
        newHeaderSeen = false;
        return `diff --git ${oldLabel} ${newLabel}`;
      }
      if (inFileHeader && line.startsWith('@@')) inFileHeader = false;
      if (inFileHeader && !oldHeaderSeen && line.startsWith('--- ')) {
        oldHeaderSeen = true;
        return `--- ${oldLabel}`;
      }
      if (inFileHeader && !newHeaderSeen && line.startsWith('+++ ')) {
        newHeaderSeen = true;
        return `+++ ${newLabel}`;
      }
      return line;
    })
    .join('\n');
}

function sourceEditsToGitPatch(sourceEdits, sourceRepo) {
  if (!Array.isArray(sourceEdits) || sourceEdits.length === 0) return '';
  if (!sourceRepo) throw new Error('sourceRepo is required to generate git-applicable source patches');

  const byFile = new Map();
  for (const edit of sourceEdits) {
    const { relativeFile } = normalizeSourceFile(sourceRepo, edit && edit.file);
    if (!byFile.has(relativeFile)) byFile.set(relativeFile, []);
    byFile.get(relativeFile).push(edit);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwv-local-diff-'));
  const sections = [];
  try {
    for (const [relativeFile, edits] of byFile) {
      const { file } = normalizeSourceFile(sourceRepo, relativeFile);
      const original = fs.readFileSync(file, 'utf8');
      const modified = edits.reduce((content, edit) => applyOneSourceEdit(content, edit), original);
      if (modified === original) continue;

      const oldFile = path.join(tmp, 'old', relativeFile);
      const newFile = path.join(tmp, 'new', relativeFile);
      fs.mkdirSync(path.dirname(oldFile), { recursive: true });
      fs.mkdirSync(path.dirname(newFile), { recursive: true });
      fs.writeFileSync(oldFile, original, 'utf8');
      fs.writeFileSync(newFile, modified, 'utf8');

      const diff = spawnSync('git', [
        'diff',
        '--no-index',
        '--no-ext-diff',
        oldFile,
        newFile,
      ], { encoding: 'utf8' });
      if (![0, 1].includes(diff.status)) {
        throw new Error(`git diff failed for ${relativeFile}: ${diff.stderr || diff.stdout}`);
      }
      if (diff.stdout.trim()) sections.push(relabelDiff(diff.stdout, relativeFile).trimEnd());
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return sections.join('\n');
}


function createBranch(repoPath, branch) {
  const exists = spawnSync('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    encoding: 'utf8',
  });
  if (exists.status === 0) {
    return { requested: true, created: false, status: 'exists' };
  }
  const result = spawnSync('git', ['-C', repoPath, 'branch', branch], {
    encoding: 'utf8',
  });
  return {
    requested: true,
    created: result.status === 0,
    status: result.status === 0 ? 'created' : 'failed',
    stderr: result.stderr ? result.stderr.trim() : undefined,
  };
}

function writePatchFile(progressDir, patchRel, sourceEdits, sourceRepo) {
  const safeRel = safeProgressRelativePath(progressDir, patchRel);
  const diff = sourceEditsToGitPatch(sourceEdits, sourceRepo);
  if (!diff.trim()) {
    throw new Error('source edits produced an empty patch');
  }
  const check = spawnSync('git', ['-C', sourceRepo, 'apply', '--check', '-'], {
    input: `${diff}\n`,
    encoding: 'utf8',
  });
  if (check.status !== 0) {
    const details = (check.stderr || check.stdout || '').trim();
    throw new Error(`generated patch failed git apply --check${details ? `: ${details}` : ''}`);
  }
  const target = path.join(progressDir, safeRel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${diff}\n`, 'utf8');
  return fileRecord(progressDir, safeRel, 'source-patch');
}

function branchGitFailures(branchOutput) {
  return (branchOutput.branches || [])
    .filter((branch) => branch.git && branch.git.requested && branch.git.status === 'failed')
    .map((branch) => ({
      id: branch.id,
      branch: branch.branch,
      status: branch.git.status,
      stderr: branch.git.stderr,
    }));
}

function branchPatchFailures(branchOutput) {
  return (branchOutput.branches || [])
    .filter((branch) => branch.patch && branch.patch.status === 'failed')
    .map((branch) => ({
      id: branch.id,
      branch: branch.branch,
      patchFile: branch.patchFile,
      status: branch.patch.status,
      error: branch.patch.error,
    }));
}

function buildBranchOutputs({
  progressDir,
  slug,
  validatedFindings,
  sourceRepo,
  branchMode,
  branchPrefix,
  patchDir,
  writePatches,
  createBranches,
}) {
  if (branchMode === 'none') {
    return {
      sourceRepo: sourceRepo ? { path: sourceRepo, isGitRepo: isGitRepo(sourceRepo) } : null,
      mode: 'none',
      branches: [],
    };
  }

  if (!sourceRepo) {
    throw new Error('--source-repo is required when --branch-mode is not "none"');
  }

  const repo = path.resolve(sourceRepo);
  const repoInfo = { path: repo, isGitRepo: isGitRepo(repo) };
  if (createBranches && !repoInfo.isGitRepo) {
    throw new Error(`--create-branches requires a git repo: ${repo}`);
  }

  const withEdits = validatedFindings.filter((finding) => (
    Array.isArray(finding.sourceEdits) && finding.sourceEdits.length > 0
  ));

  const branches = [];
  const addBranch = ({ id, findingIds, sourceEdits }) => {
    const patchRel = makePatchRelativePath(progressDir, patchDir, id);
    const branch = makeBranchName(branchPrefix, slug, id);
    const entry = {
      id,
      findingIds,
      branch,
      patchFile: patchRel,
      sourceEdits: summarizeSourceEdits(sourceEdits),
    };

    try {
      const patchFile = writePatches ? writePatchFile(progressDir, patchRel, sourceEdits, repo) : {
        path: patchRel,
        kind: 'source-patch',
        generated: false,
      };
      entry.patchFile = patchFile.path;
      entry.patch = {
        requested: writePatches,
        generated: writePatches,
        status: writePatches ? 'created' : 'skipped',
      };
      entry.sourceEdits = summarizeRepoSourceEdits(sourceEdits, repo);
      entry.commands = {
        createBranch: ['git', '-C', repo, 'branch', branch],
        applyPatch: ['git', '-C', repo, 'apply', path.resolve(progressDir, patchFile.path)],
      };
      if (createBranches) entry.git = createBranch(repo, branch);
    } catch (err) {
      entry.patch = {
        requested: writePatches,
        generated: false,
        status: 'failed',
        error: err && err.message ? err.message : String(err),
      };
    }

    branches.push(entry);
  };

  if (branchMode === 'per-fix') {
    for (const finding of withEdits) {
      addBranch({
        id: finding.id,
        findingIds: [finding.id],
        sourceEdits: finding.sourceEdits,
      });
    }
  } else if (branchMode === 'cumulative' && withEdits.length > 0) {
    addBranch({
      id: 'cumulative',
      findingIds: withEdits.map((finding) => finding.id),
      sourceEdits: withEdits.flatMap((finding) => finding.sourceEdits),
    });
  }

  return {
    sourceRepo: repoInfo,
    mode: branchMode,
    branches,
    skipped: validatedFindings
      .filter((finding) => !Array.isArray(finding.sourceEdits) || finding.sourceEdits.length === 0)
      .map((finding) => ({
        findingId: finding.id,
        reason: 'validated finding has no sourceEdits',
      })),
  };
}

function buildManifest({
  progressDir,
  sourceRepo = null,
  branchMode = 'none',
  branchPrefix = 'perf',
  patchDir = 'source-patches',
  writePatches = true,
  createBranches = false,
} = {}) {
  if (!progressDir) throw new Error('progressDir is required');
  if (!BRANCH_MODES.has(branchMode)) {
    throw new Error(`Invalid branchMode "${branchMode}". Valid: ${Array.from(BRANCH_MODES).join(', ')}`);
  }

  const resolvedProgress = path.resolve(progressDir);
  const st = fs.statSync(resolvedProgress);
  if (!st.isDirectory()) throw new Error(`progressDir is not a directory: ${resolvedProgress}`);

  const sessionPath = path.join(resolvedProgress, 'session.json');
  const session = fs.existsSync(sessionPath) ? readJson(sessionPath) : null;
  const slug = (session && session.slug) || path.basename(resolvedProgress);
  const url = (session && session.url) || null;
  const generatedAt = new Date().toISOString();

  const artifacts = {
    baselineFiles: [],
    findingFiles: [],
    diagnoseFindings: [],
    diagnoseDrafts: [],
    diagnoseReports: [],
    remediationPayloads: [],
    remediationReports: [],
    publishPlans: [],
    patchCandidates: [],
    treatmentMeasurements: [],
    verdicts: [],
    sourceBuilds: [],
    sourceBuildLogs: [],
    sourceBuildDists: [],
    asoValidation: [],
    aemDeployment: [],
    validatedFindings: [],
    screenshots: [],
    sourceEdits: [],
    sourcePatches: [],
    summaries: [],
    sessionFiles: [],
  };
  const seen = Object.fromEntries(Object.keys(artifacts).map((key) => [key, new Set()]));

  for (const [relativePath, kind, bucket] of [
    ['baseline.json', 'baseline', 'baselineFiles'],
    ['baseline-2.json', 'baseline', 'baselineFiles'],
    ['session.json', 'session', 'sessionFiles'],
    ['diagnose-spacecat-draft.json', 'diagnose-spacecat-draft', 'diagnoseDrafts'],
    ['diagnose-report.md', 'diagnose-report', 'diagnoseReports'],
    ['remediation-payload.json', 'remediation-payload', 'remediationPayloads'],
    ['remediation-report.md', 'remediation-report', 'remediationReports'],
    ['publish-plan.json', 'publish-plan', 'publishPlans'],
    ['cumulative.json', 'patch-bundle', 'patchCandidates'],
    ['ranked_patches.json', 'patch-candidates', 'patchCandidates'],
    ['patches.json', 'patch-bundle', 'patchCandidates'],
    ['SUMMARY.md', 'summary', 'summaries'],
  ]) {
    addUniqueRecord(artifacts[bucket], seen[bucket], fileRecord(resolvedProgress, relativePath, kind));
  }

  const allFiles = listFiles(resolvedProgress);
  for (const file of allFiles) {
    const rel = relPath(resolvedProgress, file);
    const normalized = rel.replace(/\\/g, '/');
    const base = path.posix.basename(normalized);

    if (FINDING_FILE_RE.test(normalized)) {
      const kind = `${base.replace(/\.json$/, '')}`;
      const record = fileRecord(resolvedProgress, normalized, kind);
      addUniqueRecord(artifacts.findingFiles, seen.findingFiles, record);
      if (base === 'diagnose-findings.json') {
        addUniqueRecord(artifacts.diagnoseFindings, seen.diagnoseFindings, record);
      }
      continue;
    }

    if (/^experiments\/[^/]+\/patch\.json$/.test(normalized)) {
      addUniqueRecord(artifacts.patchCandidates, seen.patchCandidates, fileRecord(resolvedProgress, normalized, 'experiment-patch'));
    } else if (/^experiments\/[^/]+\/result\.json$/.test(normalized)) {
      addUniqueRecord(artifacts.treatmentMeasurements, seen.treatmentMeasurements, fileRecord(resolvedProgress, normalized, 'treatment-measurement'));
    } else if (/^experiments\/[^/]+\/verdict\.json$/.test(normalized)) {
      addUniqueRecord(artifacts.verdicts, seen.verdicts, fileRecord(resolvedProgress, normalized, 'oracle-verdict'));
    } else if (normalized.endsWith('aem-clientlib-build-result.json')) {
      addUniqueRecord(artifacts.sourceBuilds, seen.sourceBuilds, fileRecord(resolvedProgress, normalized, 'aem-clientlib-build-result'));
    } else if (/^source-patches\/.+\.(?:diff|patch)$/.test(normalized)) {
      addUniqueRecord(artifacts.sourcePatches, seen.sourcePatches, fileRecord(resolvedProgress, normalized, 'source-patch'));
    } else if (/^aso-validation\/(?:request|submit-response|poll-trail|final-verdict|summary)\.json$/.test(normalized)) {
      addUniqueRecord(artifacts.asoValidation, seen.asoValidation, fileRecord(resolvedProgress, normalized, 'aso-validation'));
    } else if (/^(?:aem-deployment|aem-revalidation|aem-deployment-revalidation)\.json$/.test(normalized)) {
      addUniqueRecord(artifacts.aemDeployment, seen.aemDeployment, fileRecord(resolvedProgress, normalized, 'aem-deployment-revalidation'));
    } else if (IMAGE_FILE_RE.test(normalized)) {
      addUniqueRecord(artifacts.screenshots, seen.screenshots, fileRecord(resolvedProgress, normalized, 'screenshot'));
    } else if (/source-edits.*\.json$/.test(base)) {
      addUniqueRecord(artifacts.sourceEdits, seen.sourceEdits, fileRecord(resolvedProgress, normalized, 'source-edits'));
    }
  }
  addBuilderDirectoryRecords(resolvedProgress, artifacts, seen);

  const findingValidations = artifacts.findingFiles.map((record) => validateFindingFile(resolvedProgress, record));
  const validFindings = findingValidations
    .filter((validation) => validation.valid)
    .flatMap((validation) => validation.findings.map((finding) => ({
      finding,
      file: validation.file,
    })));
  const validatedFindings = validFindings
    .filter(({ finding }) => finding.status === 'validated')
    .map(({ finding, file }) => ({ ...finding, _findingFile: file }));
  const validationPassed = findingValidations.every((validation) => validation.valid);

  for (const { finding, file } of validFindings) {
    if (Array.isArray(finding.sourceEdits) && finding.sourceEdits.length > 0) {
      const summary = summarizeFinding(finding, file);
      const key = `${file}#${summary.id}`;
      if (!seen.sourceEdits.has(key)) {
        seen.sourceEdits.add(key);
        artifacts.sourceEdits.push({
          findingFile: file,
          kind: 'source-edits',
          findingId: summary.id,
          status: summary.status,
          metric: summary.metric,
          sourceEdits: summary.sourceEdits,
        });
      }
    }
  }

  for (const { finding, file } of validFindings.filter(({ finding }) => finding.status === 'validated')) {
    artifacts.validatedFindings.push(summarizeFinding(finding, file));
  }

  for (const raw of screenshotPathsFromFindings(validFindings.map(({ finding }) => finding))) {
    const relative = safeScreenshotRelativePath(resolvedProgress, raw);
    if (!relative) continue;
    addUniqueRecord(artifacts.screenshots, seen.screenshots, fileRecord(resolvedProgress, relative, 'screenshot') || {
      path: toPosix(relative),
      kind: 'screenshot',
      exists: false,
    });
  }

  const branchOutput = buildBranchOutputs({
    progressDir: resolvedProgress,
    slug,
    validatedFindings: validationPassed ? validatedFindings : [],
    sourceRepo,
    branchMode,
    branchPrefix,
    patchDir,
    writePatches,
    createBranches,
  });
  for (const branch of branchOutput.branches || []) {
    if (branch.patchFile) {
      addUniqueRecord(artifacts.sourcePatches, seen.sourcePatches, fileRecord(resolvedProgress, branch.patchFile, 'source-patch') || {
        path: branch.patchFile,
        kind: 'source-patch',
        generated: false,
      });
    }
  }

  const branchFailures = branchGitFailures(branchOutput);
  const branchPatchFailuresList = branchPatchFailures(branchOutput);
  const branchCreationPassed = branchFailures.length === 0;
  const branchPatchGenerationPassed = branchPatchFailuresList.length === 0;
  const branchOutputPassed = branchCreationPassed && branchPatchGenerationPassed;
  const blockedReasons = [];
  if (!validationPassed) blockedReasons.push('finding-validation-failed');
  if (!branchCreationPassed) blockedReasons.push('branch-creation-failed');
  if (!branchPatchGenerationPassed) blockedReasons.push('branch-patch-generation-failed');
  const completion = {
    status: blockedReasons.length === 0 ? 'complete' : 'blocked',
    publishRequired: false,
    spaceCatApiCalls: [],
    findingValidationPassed: validationPassed,
    invalidFindingFiles: findingValidations
      .filter((validation) => !validation.valid)
      .map((validation) => validation.file),
    branchOutputPassed,
    branchCreationPassed,
    branchCreationFailures: branchFailures,
    branchPatchGenerationPassed,
    branchPatchGenerationFailures: branchPatchFailuresList,
    blockedReasons,
  };
  const integrationProviders = buildIntegrationProviders({
    session,
    progressDir: resolvedProgress,
    sourceRepo,
    validFindings,
    findingValidations,
    artifacts,
  });
  const structuralGate = buildStructuralGateSummary({
    validFindings,
    findingValidations,
    progressDir: resolvedProgress,
  });
  const validationLayers = buildManifestValidationLayers({
    progressDir: resolvedProgress,
    artifacts,
    validatedFindings,
  });
  const validationArtifactIndex = buildValidationArtifactIndex({
    progressDir: resolvedProgress,
    artifacts,
    findingValidations,
    validationLayers,
  });
  completion.structuralGateResult = structuralGate.result;

  return {
    schemaVersion: '1.0',
    kind: 'cwv-local-artifact-manifest',
    generatedAt,
    profile: 'local',
    slug,
    url,
    progressDir: resolvedProgress,
    integrationProviders,
    validationLayers,
    validationArtifactIndex,
    structuralGate,
    localCompletion: completion,
    artifacts,
    findingValidation: findingValidations.map(({ findings: _findings, ...validation }) => validation),
    branchOutput,
  };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (!args.progress) {
    process.stderr.write(`Error: --progress is required.\n${HELP}`);
    process.exit(2);
  }

  const manifest = buildManifest({
    progressDir: args.progress,
    sourceRepo: args.sourceRepo,
    branchMode: args.branchMode,
    branchPrefix: args.branchPrefix,
    patchDir: args.patchDir,
    writePatches: args.writePatches,
    createBranches: args.createBranches,
  });

  if (args.output) writeJson(args.output, manifest);
  else process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);

  if (manifest.localCompletion.status === 'complete') process.exit(0);
  if (!manifest.localCompletion.findingValidationPassed) process.exit(3);
  if (!manifest.localCompletion.branchOutputPassed) process.exit(4);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    if (err && err.exitCode === 2) {
      process.stderr.write(`Error: ${err.message}\n${HELP}`);
      process.exit(2);
    }
    process.stderr.write(JSON.stringify({
      error: err && err.message ? err.message : String(err),
      phase: 'local-artifacts',
    }) + '\n');
    process.exit(1);
  }
}

export {
  parseArgs,
  buildManifest,
  buildBranchOutputs,
  isGitRepo,
  makePatchRelativePath,
  sourceEditsToGitPatch,
  sanitizeSegment,
  makeBranchName,
  writeJson,
};
