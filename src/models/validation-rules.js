/**
 * Phase 4: Validation Rules
 *
 * Defines criteria for validating agent findings and impact estimates.
 * Helps catch overestimates, weak evidence, and incorrect attributions.
 */

/**
 * Validation result
 * @typedef {Object} ValidationResult
 * @property {boolean} isValid - Overall validity
 * @property {number} confidence - Adjusted confidence (0-1)
 * @property {string[]} warnings - Non-blocking issues
 * @property {string[]} errors - Blocking issues
 * @property {Object} adjustments - Recommended adjustments
 */

/**
 * Validation rules configuration
 */
export const ValidationRules = {
  // Minimum confidence thresholds
  MIN_CONFIDENCE: {
    evidence: 0.5,        // Evidence confidence
    impact: 0.5,          // Impact estimate confidence
    overall: 0.6,         // Overall finding confidence (avg of above)
  },

  // Evidence source reliability tiers for confidence calibration
  // Field data (real users) > Lab data (controlled) > Code review (speculative)
  EVIDENCE_RELIABILITY: {
    // Tier 1: Field data - highly reliable (real user measurements)
    crux: { maxConfidence: 0.95, tier: 'field', description: 'CrUX field data - 28-day real user aggregate' },
    rum: { maxConfidence: 0.95, tier: 'field', description: 'RUM field data - recent real user measurements' },

    // Tier 2: Lab data - reliable (controlled measurements)
    psi: { maxConfidence: 0.85, tier: 'lab', description: 'PSI/Lighthouse - controlled lab environment' },
    har: { maxConfidence: 0.85, tier: 'lab', description: 'HAR network data - controlled capture' },
    perfEntries: { maxConfidence: 0.85, tier: 'lab', description: 'Performance entries - controlled capture' },
    coverage: { maxConfidence: 0.80, tier: 'lab', description: 'Code coverage - controlled execution' },

    // Tier 3: Static analysis - moderate reliability (no runtime verification)
    html: { maxConfidence: 0.75, tier: 'static', description: 'HTML analysis - static markup inspection' },
    rules: { maxConfidence: 0.75, tier: 'static', description: 'Rules engine - heuristic pattern matching' },

    // Tier 4: Code review - speculative (requires human judgment)
    code: { maxConfidence: 0.65, tier: 'speculative', description: 'Code review - speculative analysis' },
  },

  // Evidence quality checks
  EVIDENCE: {
    minReferenceLength: 10,           // "PSI audit" is too vague
    requiresFileReference: true,       // Must mention file names
    requiresMetricValues: true,        // Must include actual numbers
    allowedSources: [
      // Base formats (exact match)
      'psi', 'crux', 'rum', 'har', 'coverage',
      'perfEntries', 'html', 'rules', 'code',
      // Agent output formats (partial match)
      'PSI Audit', 'PerformanceObserver', 'html-analysis',
      'Custom Rule Evaluation', 'RUM Data Summary',
      'Code Coverage Analysis', 'HAR', 'Code Review',
    ],
  },

  // Impact estimation checks
  IMPACT: {
    // Maximum realistic improvements (in ms or score units)
    maxRealisticImpact: {
      LCP: 2000,          // 2s max LCP improvement
      CLS: 0.3,           // 0.3 max CLS improvement
      INP: 2000,          // 2s max INP improvement (long tasks can be 1700-3200ms)
      TBT: 1000,          // 1s max TBT improvement
      TTFB: 10000,        // 10s max TTFB improvement (measured 19.5s TTFB exists)
      FCP: 1500,          // 1.5s max FCP improvement
    },

    // Cascade efficiency (how much A→B improvement translates)
    cascadeEfficiency: {
      'TTFB→FCP': 0.8,    // 80% of TTFB improvement affects FCP
      'FCP→LCP': 0.6,     // 60% of FCP improvement affects LCP
      'TBT→INP': 0.5,     // 50% of TBT improvement affects INP
      'blocking→LCP': 0.7, // 70% of blocking time affects LCP
    },

    // Minimum impact to be actionable
    minActionableImpact: {
      LCP: 200,           // 200ms minimum to suggest
      CLS: 0.03,          // 0.03 minimum to suggest
      INP: 50,            // 50ms minimum to suggest
      TBT: 100,           // 100ms minimum to suggest
    },
  },

  // Root cause validation
  ROOT_CAUSE: {
    // Root causes should be at appropriate depth
    minDepth: 1,          // Must be deeper than metrics (depth 0)
    maxDepth: 4,          // Too deep = too abstract

    // Root causes should have specific characteristics
    requiresConcreteFix: true,      // Must have actionable fix
    requiresNoIncomingEdges: false, // Can have incoming duplicates
  },

  // Reasoning quality checks
  REASONING: {
    minObservationLength: 20,   // Must be specific
    minDiagnosisLength: 20,     // Must explain problem
    minMechanismLength: 20,     // Must explain impact
    minSolutionLength: 20,      // Must justify fix

    requiresNumbers: true,      // Must cite concrete data
    requiresFileNames: true,    // Must reference specific files
  },

  // Duplicate detection thresholds
  DUPLICATES: {
    similarityThreshold: 0.7,   // 70% keyword overlap
    sameMetric: true,           // Must affect same metric
  },
};

/**
 * Get the reliability tier for an evidence source
 * @param {string} source - Evidence source name
 * @returns {string} Tier name (field, lab, static, speculative)
 */
function getSourceTier(source) {
  if (!source) return 'speculative';

  // Normalize source string for matching
  const normalizedSource = source.toLowerCase();

  // Try exact match first (handles 'psi', 'crux', 'psi.audits.X', etc.)
  const baseSource = source.split('.')[0];
  const reliability = ValidationRules.EVIDENCE_RELIABILITY[baseSource];

  if (reliability) {
    return reliability.tier;
  }

  // Handle agent output formats with flexible substring matching
  // Field tier (0.95 confidence)
  if (normalizedSource.includes('crux') || normalizedSource.includes('chrome ux report')) {
    return 'field';
  }
  if (normalizedSource.includes('rum') || normalizedSource.includes('real user monitoring')) {
    return 'field';
  }

  // Lab tier (0.80-0.85 confidence)
  if (normalizedSource.includes('psi') || normalizedSource.includes('pagespeed') || normalizedSource.includes('page speed')) {
    return 'lab';
  }
  if (normalizedSource.includes('har') || normalizedSource.includes('http archive')) {
    return 'lab';
  }
  if (normalizedSource.includes('performance') && (normalizedSource.includes('observer') || normalizedSource.includes('entries'))) {
    return 'lab';
  }
  if (normalizedSource.includes('coverage') || normalizedSource.includes('code coverage')) {
    return 'lab';
  }

  // Static tier (0.75 confidence)
  if (normalizedSource.includes('html')) {
    return 'static';
  }
  if (normalizedSource.includes('rule') || normalizedSource.includes('custom rule')) {
    return 'static';
  }

  // Speculative tier (0.65 confidence)
  if (normalizedSource.includes('code review') || normalizedSource.includes('code-review')) {
    return 'speculative';
  }

  // Default to speculative for unknown sources
  return 'speculative';
}

/**
 * Calibrate confidence based on evidence source reliability
 * Field data is highly reliable, code review is speculative
 *
 * @param {number} rawConfidence - Original confidence (0-1)
 * @param {string} source - Evidence source name
 * @returns {number} Calibrated confidence (0-1)
 */
function calibrateConfidenceBySource(rawConfidence, source) {
  if (!source) return rawConfidence;

  // Try exact match first (handles 'psi', 'crux', 'psi.audits.X', etc.)
  const baseSource = source.split('.')[0];
  let reliability = ValidationRules.EVIDENCE_RELIABILITY[baseSource];

  // If no exact match, determine tier from source string and lookup max confidence
  if (!reliability) {
    const tier = getSourceTier(source);

    // Map tier to max confidence using first matching source in that tier
    const tierMatches = Object.entries(ValidationRules.EVIDENCE_RELIABILITY)
      .filter(([_, rel]) => rel.tier === tier);

    if (tierMatches.length > 0) {
      reliability = tierMatches[0][1];
    } else {
      // Unknown source - apply conservative cap
      return Math.min(rawConfidence, 0.6);
    }
  }

  // Cap confidence at the source's maximum reliability
  // This prevents code review findings from claiming 0.95 confidence
  const cappedConfidence = Math.min(rawConfidence, reliability.maxConfidence);

  // For speculative sources, apply additional penalty for high claims
  if (reliability.tier === 'speculative' && rawConfidence > 0.8) {
    // LLM claiming high confidence on speculative data - reduce by 15%
    return cappedConfidence * 0.85;
  }

  return cappedConfidence;
}

/**
 * Validates a single finding
 * @param {Object} finding - Agent finding to validate
 * @param {Object} graph - Causal graph (for depth/relationship checks)
 * @returns {ValidationResult} Validation result
 */
export function validateFinding(finding, graph = null) {
  const warnings = [];
  const errors = [];
  const adjustments = {};

  // 1. Evidence validation
  const evidenceValidation = validateEvidence(finding.evidence);
  warnings.push(...evidenceValidation.warnings);
  errors.push(...evidenceValidation.errors);

  // 2. Impact validation
  const impactValidation = validateImpact(finding.estimatedImpact, finding.metric);
  warnings.push(...impactValidation.warnings);
  errors.push(...impactValidation.errors);
  if (impactValidation.adjustedImpact) {
    adjustments.impact = impactValidation.adjustedImpact;
  }

  // 3. Reasoning validation (Phase 2+)
  if (finding.reasoning) {
    const reasoningValidation = validateReasoning(finding.reasoning);
    warnings.push(...reasoningValidation.warnings);
    errors.push(...reasoningValidation.errors);
  }

  // 4. Root cause validation (if applicable)
  if (finding.rootCause && graph) {
    const rootCauseValidation = validateRootCause(finding, graph);
    warnings.push(...rootCauseValidation.warnings);
    errors.push(...rootCauseValidation.errors);
  }

  // 5. Calculate overall confidence with evidence-based calibration
  const evidenceConfidence = finding.evidence?.confidence || 0.5;
  const impactConfidence = finding.estimatedImpact?.confidence || 0.5;
  const overallConfidence = (evidenceConfidence + impactConfidence) / 2;

  // Apply evidence source calibration
  const calibratedConfidence = calibrateConfidenceBySource(
    overallConfidence,
    finding.evidence?.source
  );

  // Adjust confidence based on warnings/errors
  let adjustedConfidence = calibratedConfidence;
  if (warnings.length > 0) {
    adjustedConfidence *= 0.9; // 10% penalty per warning
  }
  if (errors.length > 0) {
    adjustedConfidence *= 0.7; // 30% penalty per error
  }

  const isValid = errors.length === 0 && adjustedConfidence >= ValidationRules.MIN_CONFIDENCE.overall;

  return {
    isValid,
    confidence: adjustedConfidence,
    warnings,
    errors,
    adjustments,
    calibration: {
      originalConfidence: overallConfidence,
      sourceCalibrated: calibratedConfidence,
      source: finding.evidence?.source,
      tier: getSourceTier(finding.evidence?.source),
    },
  };
}

/**
 * Validates evidence quality
 * @param {Object} evidence - Evidence object
 * @returns {Object} Validation result
 */
function validateEvidence(evidence) {
  const warnings = [];
  const errors = [];

  if (!evidence) {
    errors.push('Missing evidence object');
    return { warnings, errors };
  }

  // Check source validity (allow partial matches for flexible agent output formats)
  const sourceNormalized = (evidence.source || '').toLowerCase();
  const isValidSource = ValidationRules.EVIDENCE.allowedSources.some(allowed => {
    const allowedNormalized = allowed.toLowerCase();
    // Match if source contains allowed string or vice versa
    return evidence.source === allowed ||
           evidence.source.startsWith(allowed + '.') ||
           sourceNormalized.includes(allowedNormalized) ||
           allowedNormalized.includes(sourceNormalized);
  });
  if (!isValidSource) {
    warnings.push(`Unusual evidence source: ${evidence.source}`);
  }

  // Check reference quality
  const ref = evidence.reference || '';
  const isFieldData = evidence.source === 'crux' || evidence.source === 'rum';

  // Field data (CrUX/RUM) is aggregate - no file-level specificity exists
  // Allow shorter references for field data (e.g., "CLS: 1.81" is specific enough)
  if (!isFieldData && ref.length < ValidationRules.EVIDENCE.minReferenceLength) {
    errors.push('Evidence reference too vague (must be >10 chars with specifics)');
  }

  // Check for file names (not required for field data sources or PSI audits)
  if (ValidationRules.EVIDENCE.requiresFileReference) {
    const sourceNormalized = (evidence.source || '').toLowerCase();
    const isFieldData = sourceNormalized.includes('crux') || sourceNormalized.includes('rum');
    const isPSIAudit = sourceNormalized.includes('psi') || sourceNormalized.includes('pagespeed');
    const hasFileName = /\.(js|css|html|woff2?|jpg|png|webp|svg)/i.test(ref);

    // PSI audits reference audit names (e.g., "Reduce unused JavaScript"), not files
    // Field data is aggregate metrics, not file-specific
    if (!hasFileName && !isFieldData && !isPSIAudit) {
      warnings.push('Evidence lacks specific file reference');
    }
  }

  // Check for metric values (not required for field data/perf entries - they are metrics)
  if (ValidationRules.EVIDENCE.requiresMetricValues) {
    const sourceNormalized = (evidence.source || '').toLowerCase();
    const isMetricSource = sourceNormalized.includes('crux') ||
                           sourceNormalized.includes('rum') ||
                           sourceNormalized.includes('performance') ||
                           sourceNormalized.includes('perfentries');

    // Match numbers with units (ms, KB, MB, s, %) or numbers with ms/s decimal notation
    const hasNumbers = /\d+(\.\d+)?\s*(ms|KB|MB|s|%)/i.test(ref) || /\d+\.\d+\s?ms/i.test(ref);

    if (!hasNumbers && !isMetricSource) {
      warnings.push('Evidence lacks concrete metric values');
    }
  }

  // Check confidence
  if (evidence.confidence < ValidationRules.MIN_CONFIDENCE.evidence) {
    warnings.push(`Low evidence confidence: ${(evidence.confidence * 100).toFixed(0)}%`);
  }

  return { warnings, errors };
}

/**
 * Validates impact estimation
 * @param {Object} impact - Estimated impact object
 * @param {string} metric - Metric being improved
 * @returns {Object} Validation result with adjusted impact
 */
function validateImpact(impact, metric) {
  const warnings = [];
  const errors = [];
  let adjustedImpact = null;

  if (!impact) {
    errors.push('Missing impact estimate');
    return { warnings, errors, adjustedImpact };
  }

  const reduction = impact.reduction || 0;
  const maxRealistic = ValidationRules.IMPACT.maxRealisticImpact[metric];

  // Check if impact is unrealistically high
  if (maxRealistic && reduction > maxRealistic) {
    warnings.push(`Impact may be overestimated: ${reduction} > ${maxRealistic} (max realistic)`);
    adjustedImpact = {
      ...impact,
      reduction: maxRealistic,
      confidence: impact.confidence * 0.7, // Lower confidence
      calculation: `${impact.calculation || ''} [Capped at ${maxRealistic} for realism]`,
    };
  }

  // Check if impact is too small to be actionable
  const minActionable = ValidationRules.IMPACT.minActionableImpact[metric];
  if (minActionable && reduction < minActionable) {
    warnings.push(`Impact too small to be actionable: ${reduction} < ${minActionable}`);
  }

  // Check confidence
  if (impact.confidence < ValidationRules.MIN_CONFIDENCE.impact) {
    warnings.push(`Low impact confidence: ${(impact.confidence * 100).toFixed(0)}%`);
  }

  // Validate calculation if provided
  if (impact.calculation) {
    const calcValidation = validateCalculation(impact.calculation, reduction);
    warnings.push(...calcValidation.warnings);
    errors.push(...calcValidation.errors);
  }

  return { warnings, errors, adjustedImpact };
}

/**
 * Validates impact calculation logic
 * @param {string} calculation - Calculation explanation
 * @param {number} reduction - Claimed reduction
 * @returns {Object} Validation result
 */
function validateCalculation(calculation, reduction) {
  const warnings = [];
  const errors = [];

  // Extract numbers from calculation
  const numbers = calculation.match(/\d+/g)?.map(Number) || [];

  // Check if calculation mentions the reduction value
  if (!calculation.includes(reduction.toString())) {
    warnings.push('Calculation does not show how reduction value was derived');
  }

  // Check for cascade claims without efficiency factor
  if (calculation.toLowerCase().includes('cascade') || calculation.includes('→')) {
    const hasCascadeNote = /not 1:1|cascading|indirect|partial/i.test(calculation);
    if (!hasCascadeNote) {
      warnings.push('Cascade impact claims 1:1 improvement (unrealistic)');
    }
  }

  return { warnings, errors };
}

/**
 * Validates reasoning quality (Phase 2)
 * @param {Object} reasoning - Reasoning object
 * @returns {Object} Validation result
 */
function validateReasoning(reasoning) {
  const warnings = [];
  const errors = [];

  const { observation, diagnosis, mechanism, solution } = reasoning;

  // Check lengths
  if (observation?.length < ValidationRules.REASONING.minObservationLength) {
    errors.push('Observation too vague (must be >20 chars with specifics)');
  }
  if (diagnosis?.length < ValidationRules.REASONING.minDiagnosisLength) {
    errors.push('Diagnosis too vague (must be >20 chars explaining problem)');
  }
  if (mechanism?.length < ValidationRules.REASONING.minMechanismLength) {
    errors.push('Mechanism too vague (must be >20 chars explaining impact)');
  }
  if (solution?.length < ValidationRules.REASONING.minSolutionLength) {
    errors.push('Solution too vague (must be >20 chars justifying fix)');
  }

  // Check for concrete data (numbers)
  if (ValidationRules.REASONING.requiresNumbers) {
    const hasNumbers = /\d+\s*(ms|KB|MB|s|%)/i.test(observation || '');
    if (!hasNumbers) {
      warnings.push('Observation lacks concrete metric values');
    }
  }

  // Check for file names
  if (ValidationRules.REASONING.requiresFileNames) {
    const hasFileName = /\.(js|css|html|woff2?|jpg|png|webp|svg)/i.test(observation || '');
    if (!hasFileName) {
      warnings.push('Observation lacks specific file reference');
    }
  }

  return { warnings, errors };
}

/**
 * Validates root cause attribution (Phase 3)
 * @param {Object} finding - Finding claiming to be root cause
 * @param {Object} graph - Causal graph
 * @returns {Object} Validation result
 */
function validateRootCause(finding, graph) {
  const warnings = [];
  const errors = [];

  const node = graph.nodes[finding.id];
  if (!node) {
    warnings.push('Finding not found in causal graph');
    return { warnings, errors };
  }

  // Check depth
  if (node.depth < ValidationRules.ROOT_CAUSE.minDepth) {
    errors.push(`Root cause depth too shallow: ${node.depth} (should be >${ValidationRules.ROOT_CAUSE.minDepth})`);
  }
  if (node.depth > ValidationRules.ROOT_CAUSE.maxDepth) {
    warnings.push(`Root cause depth very deep: ${node.depth} (may be too abstract)`);
  }

  // Check for incoming edges (causes of this cause)
  const incomingEdges = graph.edges.filter(e =>
    e.to === finding.id && e.relationship !== 'duplicates'
  );
  if (incomingEdges.length > 0 && ValidationRules.ROOT_CAUSE.requiresNoIncomingEdges) {
    warnings.push('Root cause has incoming edges (not truly fundamental)');
  }

  // Check if it has a concrete fix
  if (ValidationRules.ROOT_CAUSE.requiresConcreteFix) {
    const hasConcreteFix = finding.description && finding.description.length > 20;
    if (!hasConcreteFix) {
      warnings.push('Root cause lacks concrete fix description');
    }
  }

  return { warnings, errors };
}

/**
 * Validates all findings in bulk
 * @param {Object[]} findings - Array of findings
 * @param {Object} graph - Causal graph
 * @returns {Object} Bulk validation results
 */
export function validateAllFindings(findings, graph) {
  const results = findings.map(finding => ({
    findingId: finding.id,
    validation: validateFinding(finding, graph),
  }));

  const valid = results.filter(r => r.validation.isValid);
  const invalid = results.filter(r => !r.validation.isValid);
  const needsAdjustment = results.filter(r => Object.keys(r.validation.adjustments).length > 0);

  return {
    results,
    summary: {
      total: findings.length,
      valid: valid.length,
      invalid: invalid.length,
      needsAdjustment: needsAdjustment.length,
      averageConfidence: results.reduce((sum, r) => sum + r.validation.confidence, 0) / results.length,
    },
  };
}
