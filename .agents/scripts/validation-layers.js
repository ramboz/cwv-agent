const PASS_ASO_VERDICTS = new Set(['PASS', 'PASSED', 'VALIDATED']);
const FAIL_ASO_VERDICTS = new Set(['FAIL', 'FAILED', 'REJECT', 'REGRESSION', 'INCONCLUSIVE', 'UNRELIABLE']);
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
    doesNotProve: 'The translated source patch rebuilds, deploys, or routes through AEM.',
    customerPhrase: 'Lab validation confirmed the runtime treatment improved the target metric.',
  },
  sourceBuild: {
    label: 'AEM CS source builder validation',
    proves: 'The translated source patch rebuilt into Granite clientlibs through the AEM CS source/build contract.',
    doesNotProve: 'The rebuilt bytes were deployed or routed into the live AEM environment.',
    customerPhrase: 'Source-build validation confirmed the patch rebuilds into AEM clientlibs.',
  },
  aso: {
    label: 'ASO validation',
    proves: 'The optional ASO provider accepted the source patch and returned its own validation verdict.',
    doesNotProve: 'Actual AEM or Cloud Manager deployment happened.',
    customerPhrase: 'ASO validation provided an additional service-style check of the source patch.',
  },
  aemDeployment: {
    label: 'AEM deployment/revalidation',
    proves: 'An explicit AEM deployment or post-deployment revalidation artifact exists.',
    doesNotProve: 'Nothing beyond the artifact itself; inspect the deployment record before claiming production status.',
    customerPhrase: 'AEM deployment/revalidation evidence is recorded for this patch.',
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

function summarizeAsoStatus(verdicts) {
  const normalized = uniqueStrings(verdicts).map((verdict) => verdict.toUpperCase());
  if (normalized.some((verdict) => PASS_ASO_VERDICTS.has(verdict))) return 'passed';
  if (normalized.some((verdict) => FAIL_ASO_VERDICTS.has(verdict))) return 'failed';
  return normalized.length > 0 ? 'unknown' : 'missing';
}

function summarizeSourceBuildStatus(results) {
  const values = Array.isArray(results) ? results : [];
  if (values.some((result) => {
    if (!result || typeof result !== 'object') return false;
    if (result.success === true) return true;
    const steps = Array.isArray(result.steps) ? result.steps : [];
    return steps.length > 0 && steps.every((step) => step && step.exitCode === 0);
  })) return 'passed';
  if (values.some((result) => {
    if (!result || typeof result !== 'object') return false;
    if (result.success === false) return true;
    const steps = Array.isArray(result.steps) ? result.steps : [];
    return steps.some((step) => step && step.exitCode !== 0);
  })) return 'failed';
  return values.length > 0 ? 'unknown' : 'missing';
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
  sourceBuildArtifacts = [],
  sourceBuildResults = [],
  asoArtifacts = [],
  asoVerdicts = [],
  aemDeploymentArtifacts = [],
} = {}) {
  const runtimeStatus = summarizeRuntimeStatus(runtimeResults);
  const sourceBuildStatus = summarizeSourceBuildStatus(sourceBuildResults);
  const asoStatus = summarizeAsoStatus(asoVerdicts);
  const deploymentArtifacts = uniqueStrings(aemDeploymentArtifacts);
  const layers = {
    runtime: layer('runtime', {
      status: runtimeStatus,
      required: true,
      artifacts: runtimeArtifacts,
    }),
    sourceBuild: layer('sourceBuild', {
      status: sourceBuildStatus,
      required: true,
      artifacts: sourceBuildArtifacts,
    }),
    aso: layer('aso', {
      status: asoStatus,
      required: false,
      artifacts: asoArtifacts,
    }),
    aemDeployment: layer('aemDeployment', {
      status: deploymentArtifacts.length > 0 ? 'passed' : 'missing',
      required: false,
      artifacts: deploymentArtifacts,
    }),
  };

  const warnings = [];
  if (layers.sourceBuild.status !== 'passed') {
    warnings.push({
      code: 'aem-cs-source-builder-missing',
      severity: 'warning',
      layer: 'sourceBuild',
      message: 'AEM CS source-builder validation has not passed; do not present this as a source-build-validated handoff.',
    });
  }
  if (layers.aemDeployment.status !== 'passed') {
    warnings.push({
      code: 'aem-deployment-revalidation-missing',
      severity: 'info',
      layer: 'aemDeployment',
      message: 'No AEM deployment/revalidation artifact is present; customer-facing language must not claim deployment or AEM revalidation.',
    });
  }

  return {
    schemaVersion: '1.0',
    target: 'aem-cs-source-patch',
    layers,
    warnings,
  };
}

function validationLayerWarnings(summary, {
  aemCs = false,
  aso = 'advisory',
} = {}) {
  const warnings = [];
  const layers = summary && summary.layers ? summary.layers : {};
  const sourceBuild = layers.sourceBuild || {};
  const runtime = layers.runtime || {};
  const asoLayer = layers.aso || {};
  const deployment = layers.aemDeployment || {};
  const asoRequired = aso === 'required' || aso === true;

  if (aemCs && runtime.status !== 'passed') {
    warnings.push({
      code: 'runtime-validation-missing',
      severity: 'error',
      blocking: true,
      layer: 'runtime',
      message: 'Runtime launcher/oracle validation is missing for this AEM CS publish preparation.',
    });
  }
  if (aemCs && sourceBuild.status !== 'passed') {
    warnings.push({
      code: 'aem-cs-source-builder-missing',
      severity: 'warning',
      blocking: false,
      layer: 'sourceBuild',
      message: 'AEM CS source-builder validation is missing or failed; publish preparation may continue only as a runtime-validated handoff.',
    });
  }
  if (aemCs && asoRequired && asoLayer.status !== 'passed') {
    warnings.push({
      code: 'aso-validation-required-missing',
      severity: 'error',
      blocking: true,
      layer: 'aso',
      message: 'ASO validation is configured as required, but no passing ASO validation artifact is present.',
    });
  }
  if (aemCs && !asoRequired && asoLayer.status !== 'passed') {
    warnings.push({
      code: 'aso-validation-advisory-missing',
      severity: 'info',
      blocking: false,
      layer: 'aso',
      message: 'ASO validation is advisory for this AEM CS publish preparation and has not passed.',
    });
  }
  if (aemCs && deployment.status !== 'passed') {
    warnings.push({
      code: 'aem-deployment-revalidation-missing',
      severity: 'info',
      blocking: false,
      layer: 'aemDeployment',
      message: 'No AEM deployment/revalidation artifact is present; do not claim deployment or AEM revalidation in customer-facing language.',
    });
  }

  return warnings;
}

function aemDeploymentPassed(summary) {
  return !!(
    summary
    && summary.layers
    && summary.layers.aemDeployment
    && summary.layers.aemDeployment.status === 'passed'
  );
}

function containsAemDeploymentClaim(text) {
  const value = String(text || '');
  return /\bCloud Manager\b/i.test(value)
    || /\bAEM\b[\s\S]{0,80}\b(?:deploy(?:ed|ment)?|revalidat(?:ed|ion)?)\b/i.test(value)
    || /\b(?:deploy(?:ed|ment)?|revalidat(?:ed|ion)?)\b[\s\S]{0,80}\bAEM\b/i.test(value);
}

function assertNoAemDeploymentClaim(text, summary, context = 'validation layer check') {
  if (!containsAemDeploymentClaim(text)) return;
  if (aemDeploymentPassed(summary)) return;
  throw new Error(
    `${context}: customer-facing text claims AEM/Cloud Manager deployment or revalidation, `
    + 'but no passing AEM deployment/revalidation artifact is present.',
  );
}

export {
  buildValidationLayerSummary,
  assertNoAemDeploymentClaim,
  validationLayerWarnings,
};
