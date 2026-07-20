/**
 * validation-layers.js — the honest validation-claim ladder.
 *
 * A lab-validated patch and a change that is live in production are different
 * claims, and handoff material must never blur them. This module summarizes
 * which validation layers a run actually passed, and guards customer-facing
 * text against claiming more than the artifacts prove.
 *
 * Layers:
 *   - runtime    (required) — the launcher/oracle A/B run proved the treatment
 *                 improved the target metric on the live URL under the fixed
 *                 lab profile.
 *   - deployment (optional) — the source change was landed and a post-deploy
 *                 re-measurement artifact exists.
 */

const PASS_RUNTIME_VERDICTS = new Set(['VALIDATED']);
const NON_PASS_RUNTIME_VERDICTS = new Set([
  'REGRESSION',
  'INCONCLUSIVE',
  'BELOW_THRESHOLD',
  'NO_OP',
  'NOT_MEASURED',
  'UNRELIABLE',
]);

const LAYER_TEXT = {
  runtime: {
    label: 'Runtime launcher/oracle validation',
    proves: 'The runtime treatment improved the target metric on the production URL under the fixed lab profile.',
    doesNotProve: 'The equivalent source change was landed, deployed, or re-measured live.',
    customerPhrase: 'Lab validation confirmed the runtime treatment improved the target metric.',
  },
  deployment: {
    label: 'Deployment/re-measurement',
    proves: 'An explicit post-deployment re-measurement artifact exists for the landed change.',
    doesNotProve: 'Nothing beyond the artifact itself; inspect the record before claiming production status.',
    customerPhrase: 'Post-deployment re-measurement evidence is recorded for this change.',
  },
};

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of (Array.isArray(values) ? values : [values])) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function layer(key, { status, required = false, artifacts = [], notes = [] } = {}) {
  const text = LAYER_TEXT[key];
  return {
    key,
    label: text.label,
    status,
    required,
    artifacts: uniqueStrings(artifacts),
    proves: text.proves,
    doesNotProve: text.doesNotProve,
    customerPhrase: text.customerPhrase,
    notes: uniqueStrings(notes),
  };
}

function summarizeRuntimeStatus(results) {
  const values = Array.isArray(results) ? results : [];
  const verdicts = values
    .map((result) => String((result && (result.verdict || result.status)) || '').toUpperCase())
    .filter(Boolean);
  if (verdicts.some((verdict) => PASS_RUNTIME_VERDICTS.has(verdict))) return 'passed';
  if (verdicts.some((verdict) => NON_PASS_RUNTIME_VERDICTS.has(verdict))) return 'failed';
  return values.length > 0 ? 'unknown' : 'missing';
}

function buildValidationLayerSummary({
  runtimeArtifacts = [],
  runtimeResults = [],
  deploymentArtifacts = [],
} = {}) {
  const runtimeStatus = summarizeRuntimeStatus(runtimeResults);
  const deployment = uniqueStrings(deploymentArtifacts);
  const layers = {
    runtime: layer('runtime', {
      status: runtimeStatus,
      required: true,
      artifacts: runtimeArtifacts,
    }),
    deployment: layer('deployment', {
      status: deployment.length > 0 ? 'passed' : 'missing',
      required: false,
      artifacts: deployment,
    }),
  };

  const warnings = [];
  if (layers.runtime.status !== 'passed') {
    warnings.push({
      code: 'runtime-validation-missing',
      severity: 'warning',
      layer: 'runtime',
      message: 'Runtime launcher/oracle validation has not passed; do not present this as a lab-validated handoff.',
    });
  }
  if (layers.deployment.status !== 'passed') {
    warnings.push({
      code: 'deployment-remeasurement-missing',
      severity: 'info',
      layer: 'deployment',
      message: 'No deployment/re-measurement artifact is present; customer-facing language must not claim the change is deployed or re-validated live.',
    });
  }

  return {
    schemaVersion: '1.0',
    target: 'source-patch',
    layers,
    warnings,
  };
}

function deploymentPassed(summary) {
  return !!(
    summary
    && summary.layers
    && summary.layers.deployment
    && summary.layers.deployment.status === 'passed'
  );
}

function containsDeploymentClaim(text) {
  const value = String(text || '');
  return /\b(?:deploy(?:ed|ment)?|revalidat(?:ed|ion)?|live in production|shipped to production)\b/i.test(value);
}

/**
 * Throw when customer-facing text claims deployment/re-validation without a
 * passing deployment layer. The guard that keeps handoff language honest.
 */
function assertNoDeploymentClaim(text, summary, context = 'validation layer check') {
  if (!containsDeploymentClaim(text)) return;
  if (deploymentPassed(summary)) return;
  throw new Error(
    `${context}: customer-facing text claims deployment or live re-validation, `
    + 'but no passing deployment/re-measurement artifact is present.',
  );
}

export {
  buildValidationLayerSummary,
  assertNoDeploymentClaim,
};
