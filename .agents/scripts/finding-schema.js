import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
/**
 * Finding Schema validator — zero-dependency.
 *
 * Canonical reference: .agents/references/topics/finding-schema.md
 *
 * Usage:
 *   import { validateFinding, validateEnvelope, SOURCE_TIERS, MIN_IMPACT } from './finding-schema.js';
 *   const res = validateFinding(obj);
 *   if (!res.valid) console.error(res.errors);
 */


const SCHEMA_VERSION = '1.0';

const SKILLS = ['cwv-triage', 'cwv-analyze', 'cwv-diagnose', 'cwv-fix', 'cwv-validate'];
const SOURCES = ['crux', 'rum', 'psi', 'har', 'html', 'coverage', 'perf_observer', 'rules', 'code'];
const METRICS = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB', 'TBT', 'SI'];
const TYPES = ['bottleneck', 'waste', 'opportunity'];
const SEVERITIES = ['high', 'medium', 'low'];
const STATUSES = ['draft', 'proposed', 'applied', 'validated', 'rejected', 'regression', 'no_op'];
const SOURCE_AVAILABILITY_STATUSES = [
  'unattempted',
  'fetched',
  'not_found',
  'auth_blocked',
  'mapping_failed',
];

// Platform-vs-customer attribution (ROADMAP G5). Optional `owner` tag (+ an
// optional `ownership` detail block) answering "is it AEM or the customer?".
// Derived by .agents/scripts/attribution.js from playbook applicable_flavors +
// stack docs + response headers. Both fields are optional — findings emitted
// before attribution simply omit them.
const OWNERS = ['platform-default', 'dispatcher-cdn', 'customer-code', 'customer-content', 'third-party'];

const EVIDENCE_KINDS = [
  'cwv-attribution',
  'resource-timing',
  'crux-percentile',
  'rum-bundle',
  'psi-audit',
  'har-entry',
  'coverage-row',
  'rule-violation',
  'long-animation-frame',
  'csp-violation',
  'screenshot',
  'measurement-delta',
];

// Source-tier confidence caps.
const SOURCE_TIERS = {
  crux: { tier: 1, maxConfidence: 0.95 },
  rum: { tier: 1, maxConfidence: 0.95 },
  psi: { tier: 2, maxConfidence: 0.85 },
  har: { tier: 2, maxConfidence: 0.85 },
  perf_observer: { tier: 2, maxConfidence: 0.85 },
  coverage: { tier: 2, maxConfidence: 0.85 },
  html: { tier: 3, maxConfidence: 0.75 },
  rules: { tier: 3, maxConfidence: 0.75 },
  code: { tier: 4, maxConfidence: 0.65 },
};

// Minimum actionable impact + metric-is-poor gates.
const MIN_IMPACT = {
  LCP: { delta: 200, poorAbove: 2500, unit: 'ms' },
  CLS: { delta: 0.03, poorAbove: 0.10, unit: 'score' },
  INP: { delta: 50, poorAbove: 200, unit: 'ms' },
  TBT: { delta: 100, poorAbove: 200, unit: 'ms' },
  FCP: { delta: 150, poorAbove: 1800, unit: 'ms' },
  TTFB: { delta: 150, poorAbove: 800, unit: 'ms' },
};

// Lifecycle transitions: prev → allowed next.
// `no_op` is a terminal state emitted by cwv-validate when a patch was applied
// but the oracle could not distinguish the treatment from baseline (e.g.
// tolerance-identical samples, or the patch silently didn't alter the DOM).
// Distinct from `rejected` (which means "measured and found harmful/below
// threshold") so downstream analytics can filter out inconclusive no-ops.
const LIFECYCLE = {
  draft: ['proposed', 'rejected'],
  proposed: ['applied', 'rejected'],
  applied: ['validated', 'rejected', 'regression', 'no_op'],
  validated: [],
  rejected: [],
  regression: [],
  no_op: [],
};

/**
 * Validate the shape of a `patches` object. Canonical markup-patch shape is
 * `{ selector: string, attrs: { key: string|null } }`. Historic shapes
 * (`action: 'set-attr'`/`'setAttribute'` paired with `attr`/`name`/`value`)
 * are silent no-ops in the runtime applier (.agents/scripts/patches/mutate-markup.js)
 * and the source mapper (.agents/scripts/source-mapper.js). Reject them early.
 *
 * @param {object} patches
 * @param {string[]} errors - mutated in place
 */
function validatePatches(patches, errors) {
  if (patches.markup !== undefined) {
    if (!Array.isArray(patches.markup)) {
      errors.push('patches.markup must be an array');
      return;
    }
    patches.markup.forEach((m, i) => {
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        errors.push(`patches.markup[${i}] must be an object`);
        return;
      }
      if (typeof m.selector !== 'string' || !m.selector) {
        errors.push(`patches.markup[${i}].selector must be a non-empty string`);
      }
      if ('action' in m) {
        errors.push(
          `patches.markup[${i}].action is not part of the canonical shape — ` +
          `use { selector, attrs: { key: value } } instead of action/attr/name/value`,
        );
      }
      if ('attr' in m) {
        errors.push(
          `patches.markup[${i}].attr is not part of the canonical shape — ` +
          `use attrs: { "${m.attr}": "${m.value !== undefined ? m.value : ''}" } instead`,
        );
      }
      if ('name' in m && !('attrs' in m)) {
        errors.push(
          `patches.markup[${i}].name is not part of the canonical shape — ` +
          `use attrs: { "${m.name}": "${m.value !== undefined ? m.value : ''}" } instead`,
        );
      }
      if (!('attrs' in m)) {
        errors.push(`patches.markup[${i}] must include attrs: { key: value }`);
      } else if (!m.attrs || typeof m.attrs !== 'object' || Array.isArray(m.attrs)) {
        errors.push(`patches.markup[${i}].attrs must be a plain object of attribute key/value pairs`);
      } else {
        for (const [k, v] of Object.entries(m.attrs)) {
          if (typeof k !== 'string' || !k) {
            errors.push(`patches.markup[${i}].attrs has empty attribute name`);
          }
          if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
            errors.push(`patches.markup[${i}].attrs.${k} must be string|number|boolean|null (got ${typeof v})`);
          }
        }
      }
    });
  }
}

/**
 * Validate the shape of a `sourceEdits` array — the structured source-edit
 * records produced by .agents/scripts/source-mapper.js (the load-bearing subset
 * of its edit objects: `{ file, before, after, line? }`; source-mapper's extra
 * `rationale`/`autoApplicable`/`patchType`/`insertion` fields are runtime/preview
 * concerns and are tolerated but not required). These records are the raw,
 * tool-agnostic material `cwv-publish` (spec 003-02) formats into the SpaceCat
 * unified-diff `patchContent` at upload — see finding-schema.md
 * "fix-findings.json → suggestion-payload mapping". Distinct from `patches`,
 * which are CDP/DOM runtime mutations (NOT a diff).
 *
 * OPTIONAL on a Finding (not every finding is publish-bound or has source
 * mapped) but REQUIRED-for-publish — `cwv-publish` needs it to build the diff.
 *
 * @param {*} sourceEdits
 * @param {string[]} errors - mutated in place
 */
function validateSourceEdits(sourceEdits, errors) {
  if (!Array.isArray(sourceEdits)) {
    errors.push('sourceEdits must be an array if provided');
    return;
  }
  sourceEdits.forEach((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      errors.push(`sourceEdits[${i}] must be an object`);
      return;
    }
    if (typeof e.file !== 'string' || !e.file) {
      errors.push(`sourceEdits[${i}].file must be a non-empty string`);
    }
    if (typeof e.before !== 'string') {
      errors.push(`sourceEdits[${i}].before must be a string`);
    }
    if (typeof e.after !== 'string') {
      errors.push(`sourceEdits[${i}].after must be a string`);
    }
    // `line` is optional — source-mapper emits null for append-style edits
    // (e.g. the EDS block-decorator case). Reject only a present non-number.
    if (e.line !== undefined && e.line !== null && typeof e.line !== 'number') {
      errors.push(`sourceEdits[${i}].line must be a number (or null/absent)`);
    }
  });
}

/**
 * Validate optional source-availability status recorded when a runtime patch
 * reaches source-translation / publish handoff. This lets downstream tools tell
 * the difference between "source was never tried" and "source-s3 was attempted
 * but unavailable or unmappable".
 *
 * @param {*} sourceAvailability
 * @param {string[]} errors - mutated in place
 */
function validateSourceAvailability(sourceAvailability, errors) {
  if (!sourceAvailability || typeof sourceAvailability !== 'object' || Array.isArray(sourceAvailability)) {
    errors.push('sourceAvailability must be an object if provided');
    return;
  }
  if (!SOURCE_AVAILABILITY_STATUSES.includes(sourceAvailability.status)) {
    errors.push(
      `sourceAvailability.status must be one of ${SOURCE_AVAILABILITY_STATUSES.join('|')}`,
    );
  }
  for (const key of ['siteId', 'baseURL', 'deliveryType', 'sourceRoot', 'manifestPath', 's3Key', 'reason']) {
    if (sourceAvailability[key] !== undefined && typeof sourceAvailability[key] !== 'string') {
      errors.push(`sourceAvailability.${key} must be a string if provided`);
    }
  }
  if (sourceAvailability.checkedAt !== undefined && !isIsoTimestamp(sourceAvailability.checkedAt)) {
    errors.push('sourceAvailability.checkedAt must be ISO 8601 if provided');
  }
}

function validateSelectedTop(selectedTop, errors, prefix = 'selectedTop', opts = {}) {
  if (!selectedTop || typeof selectedTop !== 'object' || Array.isArray(selectedTop)) {
    errors.push(`${prefix} must be an object if provided`);
    return;
  }
  if (!isHttpUrl(selectedTop.url)) {
    errors.push(`${prefix}.url must be http(s) URL`);
  }
  if (selectedTop.canonicalUrl !== undefined && !isHttpUrl(selectedTop.canonicalUrl)) {
    errors.push(`${prefix}.canonicalUrl must be http(s) URL if provided`);
  }
  if (!['crux', 'rum', 'psi'].includes(selectedTop.source)) {
    errors.push(`${prefix}.source must be one of crux|rum|psi`);
  }
  if (typeof selectedTop.rank !== 'number' || selectedTop.rank < 1) {
    errors.push(`${prefix}.rank must be a positive number`);
  }
  if (typeof selectedTop.pressure !== 'number' || selectedTop.pressure < 0) {
    errors.push(`${prefix}.pressure must be a non-negative number`);
  }
  if (typeof selectedTop.selectionReason !== 'string' || !selectedTop.selectionReason) {
    errors.push(`${prefix}.selectionReason must be a non-empty string`);
  }
  if (!Array.isArray(selectedTop.failingMetrics)) {
    errors.push(`${prefix}.failingMetrics must be an array`);
  } else {
    if (opts.requireHandoff && selectedTop.failingMetrics.length === 0) {
      errors.push(`${prefix}.failingMetrics must include at least one failing metric`);
    }
    selectedTop.failingMetrics.forEach((m, i) => {
      if (!METRICS.includes(m)) errors.push(`${prefix}.failingMetrics[${i}] must be one of ${METRICS.join('|')}`);
    });
  }
  const hasTopLevelTrafficEvidence = selectedTop.bundleCount > 0 || selectedTop.sampleCount > 0;
  let hasNestedTrafficEvidence = false;
  if (selectedTop.bundleCount !== undefined
      && (typeof selectedTop.bundleCount !== 'number' || selectedTop.bundleCount < 0)) {
    errors.push(`${prefix}.bundleCount must be a non-negative number if provided`);
  }
  if (selectedTop.sampleCount !== undefined
      && (typeof selectedTop.sampleCount !== 'number' || selectedTop.sampleCount < 0)) {
    errors.push(`${prefix}.sampleCount must be a non-negative number if provided`);
  }
  if (selectedTop.traffic !== undefined) {
    if (!selectedTop.traffic || typeof selectedTop.traffic !== 'object' || Array.isArray(selectedTop.traffic)) {
      errors.push(`${prefix}.traffic must be an object if provided`);
    } else {
      hasNestedTrafficEvidence = selectedTop.traffic.bundleCount > 0
        || selectedTop.traffic.sampleCount > 0;
      if (selectedTop.traffic.bundleCount !== undefined
          && (typeof selectedTop.traffic.bundleCount !== 'number' || selectedTop.traffic.bundleCount < 0)) {
        errors.push(`${prefix}.traffic.bundleCount must be a non-negative number if provided`);
      }
      if (selectedTop.traffic.sampleCount !== undefined
          && (typeof selectedTop.traffic.sampleCount !== 'number' || selectedTop.traffic.sampleCount < 0)) {
        errors.push(`${prefix}.traffic.sampleCount must be a non-negative number if provided`);
      }
    }
  }
  if (opts.requireHandoff && !hasTopLevelTrafficEvidence && !hasNestedTrafficEvidence) {
    errors.push(`${prefix} must include traffic, sampleCount, or bundleCount`);
  }
  if (opts.requireHandoff && typeof selectedTop.recommendedFormFactor !== 'string') {
    errors.push(`${prefix}.recommendedFormFactor must be a string`);
  }
  if (selectedTop.recommendedFormFactor !== undefined
      && !['PHONE', 'DESKTOP', 'TABLET'].includes(selectedTop.recommendedFormFactor)) {
    errors.push(`${prefix}.recommendedFormFactor must be one of PHONE|DESKTOP|TABLET`);
  }
  if (opts.requireHandoff && (typeof selectedTop.recommendedProfile !== 'string' || !selectedTop.recommendedProfile)) {
    errors.push(`${prefix}.recommendedProfile must be a non-empty string`);
  } else if (selectedTop.recommendedProfile !== undefined && typeof selectedTop.recommendedProfile !== 'string') {
    errors.push(`${prefix}.recommendedProfile must be a string if provided`);
  }
}

function isIsoTimestamp(s) {
  if (typeof s !== 'string') return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}T/.test(s);
}

function isHttpUrl(s) {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate a single Finding object.
 * Optional opts.prevStatus enforces a lifecycle transition check.
 *
 * Returns { valid: boolean, errors: string[], warnings: string[] }.
 */
function validateFinding(f, opts = {}) {
  const errors = [];
  const warnings = [];

  if (!f || typeof f !== 'object') {
    return { valid: false, errors: ['finding is not an object'], warnings };
  }

  // Identity
  if (f.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be "${SCHEMA_VERSION}" (got ${JSON.stringify(f.schemaVersion)})`);
  }
  if (typeof f.id !== 'string' || !f.id) errors.push('id must be a non-empty string');
  if (!isIsoTimestamp(f.timestamp)) errors.push('timestamp must be ISO 8601 string');
  if (!isHttpUrl(f.url)) errors.push('url must be http(s) URL');
  if (!SKILLS.includes(f.skill)) errors.push(`skill must be one of ${SKILLS.join('|')}`);

  // Classification
  if (!SOURCES.includes(f.source)) errors.push(`source must be one of ${SOURCES.join('|')}`);
  if (!Array.isArray(f.metric) || f.metric.length === 0) {
    errors.push('metric must be a non-empty array');
  } else {
    for (const m of f.metric) {
      if (!METRICS.includes(m)) errors.push(`metric entry ${m} not in ${METRICS.join('|')}`);
    }
  }
  if (!TYPES.includes(f.type)) errors.push(`type must be one of ${TYPES.join('|')}`);
  if (!SEVERITIES.includes(f.severity)) errors.push(`severity must be one of ${SEVERITIES.join('|')}`);
  if (typeof f.rootCause !== 'boolean') errors.push('rootCause must be boolean');

  // Content
  if (typeof f.cause !== 'string' || !f.cause) errors.push('cause must be a non-empty string');
  if (!Array.isArray(f.evidence) || f.evidence.length === 0) {
    errors.push('evidence must be a non-empty array');
  } else {
    f.evidence.forEach((e, i) => {
      if (!e || typeof e !== 'object') {
        errors.push(`evidence[${i}] must be an object`);
        return;
      }
      if (!EVIDENCE_KINDS.includes(e.kind)) {
        warnings.push(`evidence[${i}].kind "${e.kind}" is not a known kind (allowed: ${EVIDENCE_KINDS.join(', ')})`);
      }
      if (!e.data || typeof e.data !== 'object') {
        errors.push(`evidence[${i}].data must be an object`);
      }
    });
  }
  if (typeof f.recommendation !== 'string' || !f.recommendation) {
    errors.push('recommendation must be a non-empty string');
  }
  if (f.patches !== undefined) {
    if (typeof f.patches !== 'object' || f.patches === null || Array.isArray(f.patches)) {
      errors.push('patches must be an object if provided');
    } else {
      validatePatches(f.patches, errors);
    }
  }
  // Structured source-edit records — the basis for the publish-time unified
  // diff (cwv-publish / 003-02). Optional on the Finding; required-for-publish.
  if (f.sourceEdits !== undefined) {
    validateSourceEdits(f.sourceEdits, errors);
  }
  if (f.sourceAvailability !== undefined) {
    validateSourceAvailability(f.sourceAvailability, errors);
  }

  // Scoring
  if (typeof f.confidence !== 'number' || f.confidence < 0 || f.confidence > 1) {
    errors.push('confidence must be a number in [0, 1]');
  } else {
    const tier = SOURCE_TIERS[f.source];
    if (tier && f.confidence > tier.maxConfidence + 1e-9) {
      errors.push(`confidence ${f.confidence} exceeds source-tier cap for "${f.source}" (${tier.maxConfidence})`);
    }
    if (f.confidence < 0.5) {
      warnings.push(`confidence < 0.5 — finding should be suppressed per evidence-and-confidence.md`);
    }
  }

  if (!f.impactReduction || typeof f.impactReduction !== 'object') {
    errors.push('impactReduction must be an object');
  } else {
    const ir = f.impactReduction;
    if (!METRICS.includes(ir.metric)) {
      errors.push(`impactReduction.metric must be one of ${METRICS.join('|')}`);
    }
    const hasMs = typeof ir.valueMs === 'number';
    const hasScore = typeof ir.score === 'number';
    if (!hasMs && !hasScore) {
      errors.push('impactReduction must include valueMs or score');
    }
    if (ir.metric === 'CLS' && !hasScore) {
      warnings.push('impactReduction.metric=CLS should use `score`, not `valueMs`');
    }
    if (ir.metric !== 'CLS' && hasScore && !hasMs) {
      warnings.push(`impactReduction.metric=${ir.metric} should use valueMs, not score`);
    }

    // MIN_ACTIONABLE_IMPACT gate (advisory — skill decides whether to reject).
    const floor = MIN_IMPACT[ir.metric];
    if (floor) {
      const magnitude = Math.abs(hasMs ? ir.valueMs : ir.score);
      if (magnitude < floor.delta && f.status !== 'rejected' && f.status !== 'regression' && f.status !== 'no_op') {
        warnings.push(
          `impactReduction magnitude ${magnitude}${floor.unit === 'ms' ? 'ms' : ''} is below MIN_ACTIONABLE_IMPACT ` +
          `(${floor.delta}${floor.unit === 'ms' ? 'ms' : ''}) for ${ir.metric}; consider status="rejected"`,
        );
      }
    }
  }

  // Lifecycle
  if (!STATUSES.includes(f.status)) {
    errors.push(`status must be one of ${STATUSES.join('|')}`);
  } else if (opts.prevStatus) {
    const allowed = LIFECYCLE[opts.prevStatus] || [];
    if (!allowed.includes(f.status) && f.status !== opts.prevStatus) {
      errors.push(`invalid lifecycle transition: ${opts.prevStatus} → ${f.status}`);
    }
  }
  if (f.status === 'validated' && (!Array.isArray(f.sourceEdits) || f.sourceEdits.length === 0)) {
    const sourceStatus = f.sourceAvailability && f.sourceAvailability.status;
    if (!sourceStatus || sourceStatus === 'unattempted') {
      warnings.push(
        'validated finding has no sourceEdits; before publishing guidance-only, run cwv-source-fetch/source-s3 '
        + 'or record sourceAvailability.status as not_found/auth_blocked/mapping_failed',
      );
    } else if (sourceStatus === 'fetched') {
      warnings.push(
        'validated finding has sourceAvailability.status="fetched" but no sourceEdits; map/reconcile the source '
        + 'edit before a deployable SpaceCat CODE_CHANGE publish',
      );
    }
  }

  if (f.relatedFindingIds !== undefined) {
    if (!Array.isArray(f.relatedFindingIds)) {
      errors.push('relatedFindingIds must be an array');
    } else {
      f.relatedFindingIds.forEach((id, i) => {
        if (typeof id !== 'string') errors.push(`relatedFindingIds[${i}] must be string`);
      });
    }
  }
  if (f.mergedSources !== undefined) {
    if (!Array.isArray(f.mergedSources)) {
      errors.push('mergedSources must be an array');
    } else {
      f.mergedSources.forEach((s, i) => {
        if (!SOURCES.includes(s)) errors.push(`mergedSources[${i}] "${s}" not a valid source`);
      });
    }
  }

  // Attribution (optional — see OWNERS / attribution.js)
  if (f.owner !== undefined && !OWNERS.includes(f.owner)) {
    errors.push(`owner must be one of ${OWNERS.join('|')}`);
  }
  if (f.ownership !== undefined) {
    if (typeof f.ownership !== 'object' || f.ownership === null || Array.isArray(f.ownership)) {
      errors.push('ownership must be an object if provided');
    } else {
      if (f.ownership.owner !== undefined && !OWNERS.includes(f.ownership.owner)) {
        errors.push(`ownership.owner must be one of ${OWNERS.join('|')}`);
      }
      if (f.owner !== undefined && f.ownership.owner !== undefined && f.owner !== f.ownership.owner) {
        errors.push(`owner "${f.owner}" disagrees with ownership.owner "${f.ownership.owner}"`);
      }
      if (f.ownership.confidence !== undefined
          && (typeof f.ownership.confidence !== 'number' || f.ownership.confidence < 0 || f.ownership.confidence > 1)) {
        errors.push('ownership.confidence must be a number in [0, 1]');
      }
    }
  }

  // Skill-specific rules
  if (f.skill === 'cwv-triage' && f.patches !== undefined) {
    warnings.push('cwv-triage findings should not include `patches` — patches come from cwv-diagnose');
  }
  if (f.skill === 'cwv-diagnose' && f.status !== 'proposed' && f.status !== 'rejected') {
    warnings.push(`cwv-diagnose typically emits status="proposed"; got "${f.status}"`);
  }
  if (f.skill === 'cwv-analyze' && !['proposed', 'rejected'].includes(f.status)) {
    warnings.push(`cwv-analyze typically emits status="proposed" or "rejected"; got "${f.status}"`);
  }
  if (f.skill === 'cwv-fix' && !['applied', 'rejected', 'regression'].includes(f.status)) {
    warnings.push(`cwv-fix typically emits status in {applied, rejected, regression}; got "${f.status}"`);
  }
  if (f.skill === 'cwv-validate' && !['validated', 'rejected', 'regression', 'no_op'].includes(f.status)) {
    warnings.push(`cwv-validate typically emits status in {validated, rejected, regression, no_op}; got "${f.status}"`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate an envelope: { schemaVersion, skill, url, timestamp, findings: [...] }
 * Also accepts a single Finding and wraps it.
 * Returns { valid, errors, warnings, findings: [{index, result}] }.
 */
function validateEnvelope(obj) {
  const errors = [];
  const warnings = [];
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['envelope is not an object'], warnings, findings: [] };
  }

  // If single finding, wrap.
  if (!Array.isArray(obj.findings) && obj.id && obj.cause) {
    const r = validateFinding(obj);
    return { valid: r.valid, errors: r.errors, warnings: r.warnings, findings: [{ index: 0, result: r }] };
  }

  if (obj.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`envelope.schemaVersion must be "${SCHEMA_VERSION}"`);
  }
  if (!SKILLS.includes(obj.skill)) errors.push(`envelope.skill must be one of ${SKILLS.join('|')}`);
  if (!isHttpUrl(obj.url)) errors.push('envelope.url must be http(s) URL');
  if (!isIsoTimestamp(obj.timestamp)) errors.push('envelope.timestamp must be ISO 8601');
  const selectedTopRequired = obj.skill === 'cwv-triage' && obj.status !== 'passing';
  if (selectedTopRequired && obj.selectedTop === undefined) {
    errors.push('selectedTop is required on non-passing cwv-triage envelopes');
  }
  if (obj.selectedTop !== undefined) validateSelectedTop(obj.selectedTop, errors, 'selectedTop', { requireHandoff: selectedTopRequired });
  if (obj.rawTop !== undefined) validateSelectedTop(obj.rawTop, errors, 'rawTop');
  if (obj.nearMisses !== undefined) {
    if (!Array.isArray(obj.nearMisses)) {
      errors.push('nearMisses must be an array if provided');
    } else {
      obj.nearMisses.forEach((row, i) => validateSelectedTop(row, errors, `nearMisses[${i}]`));
    }
  }

  const findingResults = [];
  if (!Array.isArray(obj.findings)) {
    errors.push('envelope.findings must be an array');
  } else {
    obj.findings.forEach((f, i) => {
      const r = validateFinding(f);
      findingResults.push({ index: i, result: r });
      r.errors.forEach((e) => errors.push(`findings[${i}]: ${e}`));
      r.warnings.forEach((w) => warnings.push(`findings[${i}]: ${w}`));
    });
  }

  return { valid: errors.length === 0, errors, warnings, findings: findingResults };
}

/**
 * Convenience: derive severity from impactReduction per the gates in finding-schema.md.
 */
function deriveSeverity(impactReduction) {
  if (!impactReduction || !impactReduction.metric) return 'low';
  const floor = MIN_IMPACT[impactReduction.metric];
  if (!floor) return 'low';
  const magnitude = Math.abs(
    typeof impactReduction.valueMs === 'number' ? impactReduction.valueMs : impactReduction.score || 0,
  );
  if (magnitude >= 3 * floor.delta) return 'high';
  if (magnitude >= floor.delta) return 'medium';
  return 'low';
}

export {
  SCHEMA_VERSION,
  SKILLS,
  SOURCES,
  METRICS,
  TYPES,
  SEVERITIES,
  STATUSES,
  OWNERS,
  EVIDENCE_KINDS,
  SOURCE_TIERS,
  MIN_IMPACT,
  LIFECYCLE,
  validateFinding,
  validateEnvelope,
  deriveSeverity,
};

// CLI entry: node finding-schema.js <path-to-finding-or-envelope.json>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node finding-schema.js <file.json>');
    process.exit(2);
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const res = validateEnvelope(data);
  for (const w of res.warnings) console.error(`WARN: ${w}`);
  for (const e of res.errors) console.error(`ERR:  ${e}`);
  if (!res.valid) process.exit(1);
  console.log('OK');
}
