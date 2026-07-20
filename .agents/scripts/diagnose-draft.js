#!/usr/bin/env node

/**
 * diagnose-draft.js — derive non-mutating SpaceCat-shaped diagnosis artifacts.
 *
 * The diagnosis phase is allowed to prepare reviewable backend-shaped material,
 * but it must not perform or pre-claim any SpaceCat state transition. This pure
 * helper turns `diagnose-findings.json` into:
 *   - `diagnose-spacecat-draft.json` — identity + draft issues for publish review
 *   - `diagnose-report.md` — AEM expert-readable diagnosis report
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildIssueValue,
  metricToIssueType,
  profileToDeviceType,
  severityToRank,
} from './publish-payload.js';

function findingsFromEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new TypeError('diagnose draft input must be a Finding envelope object');
  }
  const findings = Array.isArray(envelope.findings) ? envelope.findings : [envelope];
  return findings.filter((finding) => finding && typeof finding === 'object');
}

function firstMetric(finding) {
  return String((finding.metric && finding.metric[0]) || '').toUpperCase();
}

function normalizeMetric(metric) {
  return metricToIssueType(metric);
}

function selectedFinding(findings, opts = {}) {
  const statusAllowed = (finding) => finding.status !== 'rejected';
  const url = opts.url;
  const metric = opts.metric ? normalizeMetric(opts.metric) : null;
  const candidates = findings.filter((finding) => {
    if (!statusAllowed(finding)) return false;
    if (url && finding.url !== url) return false;
    if (metric && normalizeMetric(firstMetric(finding)) !== metric) return false;
    return true;
  });
  if (candidates.length === 0) {
    throw new Error('buildDiagnoseSpaceCatDraft: no non-rejected diagnosis finding matches the requested URL/metric');
  }
  return candidates.find((finding) => finding.rootCause === true) || candidates[0];
}

function evidencePath(entry) {
  const data = entry && entry.data && typeof entry.data === 'object' ? entry.data : {};
  return data.path || data.artifact || data.artifactPath || data.file || null;
}

function evidenceSelector(entry) {
  const data = entry && entry.data && typeof entry.data === 'object' ? entry.data : {};
  return data.selector || data.target || data.node || null;
}

function evidenceResource(entry) {
  const data = entry && entry.data && typeof entry.data === 'object' ? entry.data : {};
  return data.url || data.href || data.src || data.resource || null;
}

function uniq(values) {
  return [...new Set(values.filter((value) => value != null && value !== '').map(String))];
}

function summarizeEvidence(finding) {
  return (finding.evidence || []).map((entry) => ({
    kind: entry.kind || 'evidence',
    path: evidencePath(entry),
    summary: entry.summary || entry.description || finding.cause || '',
  }));
}

function affectedFromFinding(finding) {
  const evidence = finding.evidence || [];
  return {
    selectors: uniq([
      ...(Array.isArray(finding.selectors) ? finding.selectors : []),
      finding.selector,
      finding.target,
      ...evidence.map(evidenceSelector),
    ]),
    resources: uniq([
      ...(Array.isArray(finding.resources) ? finding.resources : []),
      finding.resource,
      ...evidence.map(evidenceResource),
    ]),
  };
}

function confidenceFor(finding) {
  return {
    value: finding.confidence,
    source: finding.source,
    limit: finding.confidenceLimit || null,
    rationale: finding.confidenceRationale || 'Capped by diagnosis evidence tier and mechanism confidence.',
  };
}

function issueFromFinding(finding, { deviceType }) {
  const metric = firstMetric(finding);
  const patchContent = '';
  return {
    findingId: finding.id,
    type: normalizeMetric(metric),
    status: 'DRAFT',
    rootCause: finding.rootCause === true,
    problem: finding.publishDescription || finding.cause || finding.recommendation || '',
    mechanism: finding.rootCause
      ? (finding.rootCauseDescription || finding.cause || '')
      : (finding.cause || ''),
    recommendation: finding.recommendation || '',
    evidence: summarizeEvidence(finding),
    affected: affectedFromFinding(finding),
    owner: finding.owner || (finding.ownership && finding.ownership.owner) || 'unknown',
    ownership: finding.ownership || null,
    confidence: confidenceFor(finding),
    confidenceLimits: confidenceFor(finding),
    value: buildIssueValue(finding, { deviceType, patchContent }),
  };
}

function buildDiagnoseSpaceCatDraft(envelope, opts = {}) {
  const findings = findingsFromEnvelope(envelope);
  const selected = selectedFinding(findings, opts);
  const selectedUrl = opts.url || selected.url || envelope.url;
  const metric = normalizeMetric(opts.metric || firstMetric(selected));
  const deviceType = profileToDeviceType(opts.profile !== undefined ? opts.profile : envelope.profile || selected.profile);
  const matching = findings.filter((finding) => (
    finding.status !== 'rejected'
    && (finding.url || envelope.url) === selectedUrl
    && normalizeMetric(firstMetric(finding)) === metric
  ));
  const issues = matching.map((finding) => issueFromFinding(finding, { deviceType }));
  const aggregationKey = `${selectedUrl}|${metric}`;

  return {
    schemaVersion: '1.0',
    kind: 'diagnose-spacecat-draft',
    generatedAt: new Date().toISOString(),
    sourceArtifact: opts.sourceArtifact || 'diagnose-findings.json',
    publishState: 'draft',
    mutatesBackend: false,
    selectedUrl,
    url: selectedUrl,
    metric,
    aggregationKey,
    profile: opts.profile !== undefined ? opts.profile : envelope.profile || selected.profile || null,
    deviceType,
    selectedFindingId: selected.id,
    dedupIdentity: {
      url: selectedUrl,
      metric,
      aggregationKey,
    },
    dedupPlan: null,
    publishReadProbeRequired: true,
    suggestion: {
      type: 'CODE_CHANGE',
      rank: Math.min(...matching.map((finding) => severityToRank(finding.severity))),
      data: {
        url: selectedUrl,
        type: 'url',
        aggregationKey,
        isCodeChangeAvailable: false,
        metrics: [{ deviceType }],
        issues,
      },
    },
  };
}

function bulletList(values, fallback = '- None recorded.') {
  if (!values.length) return fallback;
  return values.map((value) => `- ${value}`).join('\n');
}

function buildDiagnoseReport(draft) {
  const issues = (draft.suggestion && draft.suggestion.data && draft.suggestion.data.issues) || [];
  const rootCauses = issues
    .filter((issue) => issue.rootCause === true)
    .map((issue) => `${issue.findingId}: ${issue.mechanism || issue.problem}`);
  const hypotheses = issues
    .filter((issue) => issue.rootCause !== true)
    .map((issue) => `${issue.findingId}: ${issue.mechanism || issue.problem}`);
  const evidence = issues.flatMap((issue) => (
    (issue.evidence || []).map((entry) => {
      const pathPart = entry.path ? ` (${entry.path})` : '';
      const summaryPart = entry.summary ? ` - ${entry.summary}` : '';
      return `${issue.findingId}: ${entry.kind}${pathPart}${summaryPart}`;
    })
  ));
  const owners = issues.map((issue) => `${issue.findingId}: ${issue.owner}`);
  const risks = issues.flatMap((issue) => {
    const limits = issue.confidenceLimits || {};
    return [
      `${issue.findingId}: confidence ${limits.value ?? 'unknown'}; ${limits.rationale || 'no confidence rationale recorded'}`,
    ];
  });
  const remediation = issues.map((issue) => `${issue.findingId}: ${issue.recommendation || 'Review the draft issue value.'}`);

  return [
    '# Diagnose Report',
    '',
    '## Selected URL',
    draft.selectedUrl || draft.url || '',
    '',
    '## Failing Metrics',
    `- ${String(draft.metric || '').toUpperCase()}`,
    '',
    '## Root Cause',
    bulletList(rootCauses),
    '',
    '## Additional Hypotheses',
    bulletList(hypotheses),
    '',
    '## Evidence',
    bulletList(evidence),
    '',
    '## Ownership',
    bulletList(owners),
    '',
    '## Risks',
    bulletList(risks),
    '',
    '## Recommended Next Remediation Path',
    bulletList(remediation),
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    input: null,
    draftOutput: 'diagnose-spacecat-draft.json',
    reportOutput: 'diagnose-report.md',
    url: null,
    metric: null,
    profile: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (flag) => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      return value;
    };
    switch (a) {
      case '--output': args.draftOutput = next(a); break;
      case '--report': args.reportOutput = next(a); break;
      case '--url': args.url = next(a); break;
      case '--metric': args.metric = next(a); break;
      case '--profile': args.profile = next(a); break;
      case '--help':
        process.stdout.write('usage: node diagnose-draft.js <diagnose-findings.json> [--output diagnose-spacecat-draft.json] [--report diagnose-report.md] [--url URL] [--metric LCP|CLS|INP|TTFB] [--profile PROFILE]\n');
        process.exit(0);
        break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
        if (args.input) throw new Error(`Unexpected positional argument: ${a}`);
        args.input = a;
    }
  }
  if (!args.input) throw new Error('Missing input diagnose-findings.json');
  return args;
}

export {
  buildDiagnoseReport,
  buildDiagnoseSpaceCatDraft,
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const inputPath = path.resolve(args.input);
    const envelope = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const draft = buildDiagnoseSpaceCatDraft(envelope, {
      sourceArtifact: path.basename(inputPath),
      url: args.url,
      metric: args.metric,
      profile: args.profile,
    });
    fs.writeFileSync(args.draftOutput, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
    fs.writeFileSync(args.reportOutput, buildDiagnoseReport(draft), 'utf8');
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
