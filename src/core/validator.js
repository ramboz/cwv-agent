/**
 * Phase 4: Validation Executor
 *
 * Applies validation rules to agent findings and adjusts/blocks
 * low-quality suggestions before they reach the user.
 */

import { validateAllFindings, validateFinding } from '../models/validation-rules.js';
import { cacheResults } from '../utils.js';

/**
 * Validates all findings and applies adjustments/blocking
 * @param {Object[]} findings - Array of agent findings
 * @param {Object} causalGraph - Causal graph (for root cause validation)
 * @param {Object} config - Validation configuration
 * @returns {Object} Validation results with filtered findings
 */
export function validateFindings(findings, causalGraph, config = {}) {
  const {
    blockingMode = true,           // Block invalid findings
    adjustMode = true,             // Apply adjustments
    strictMode = false,            // Strict validation (block warnings too)
  } = config;

  console.log('- validating findings...');

  // Run validation on all findings
  const validationResults = validateAllFindings(findings, causalGraph);

  // Separate findings by validation result
  const approved = [];
  const adjusted = [];
  const blocked = [];

  validationResults.results.forEach(result => {
    const finding = findings.find(f => f.id === result.findingId);
    if (!finding) return;

    const { isValid, confidence, warnings, errors, adjustments } = result.validation;

    // Determine action
    if (errors.length > 0 && blockingMode) {
      // Block if has errors
      blocked.push({
        finding,
        reason: 'errors',
        issues: errors,
      });
    } else if (warnings.length > 0 && strictMode) {
      // Block warnings in strict mode
      blocked.push({
        finding,
        reason: 'warnings (strict mode)',
        issues: warnings,
      });
    } else if (Object.keys(adjustments).length > 0 && adjustMode) {
      // Apply adjustments
      const adjustedFinding = { ...finding };

      // Apply impact adjustments
      if (adjustments.impact) {
        adjustedFinding.estimatedImpact = {
          ...adjustedFinding.estimatedImpact,
          ...adjustments.impact,
        };
      }

      // Adjust overall confidence
      adjustedFinding.evidence = {
        ...adjustedFinding.evidence,
        confidence: confidence,
      };

      // Add validation metadata
      adjustedFinding.validation = {
        adjusted: true,
        originalConfidence: finding.evidence?.confidence,
        warnings,
      };

      adjusted.push({
        finding: adjustedFinding,
        original: finding,
        warnings,
        adjustments,
      });
    } else {
      // Approve as-is
      approved.push({
        finding,
        confidence,
      });
    }
  });

  // Log validation summary
  console.log(`✅ Validation: ${approved.length} approved, ${adjusted.length} adjusted, ${blocked.length} blocked`);

  if (blocked.length > 0) {
    console.log('   Blocked findings:');
    blocked.forEach(b => {
      console.log(`   - ${b.finding.id}: ${b.issues[0]}`);
    });
  }

  // if (adjusted.length > 0) {
  //   console.log('   Adjusted findings:');
  //   adjusted.forEach(a => {
  //     console.log(`   - ${a.finding.id}: ${a.warnings[0] || 'Impact adjusted'}`);
  //   });
  // }

  // Return validated findings
  return {
    approvedFindings: approved.map(a => a.finding),
    adjustedFindings: adjusted.map(a => a.finding),
    blockedFindings: blocked,
    summary: {
      total: findings.length,
      approved: approved.length,
      adjusted: adjusted.length,
      blocked: blocked.length,
      finalCount: approved.length + adjusted.length,
      averageConfidence: validationResults.summary.averageConfidence,
    },
    validationResults,  // Full validation details
  };
}

/**
 * Filters findings based on validation results
 * @param {Object[]} findings - Original findings
 * @param {Object} validationResults - Results from validateFindings()
 * @returns {Object[]} Filtered and adjusted findings
 */
export function applyValidation(findings, validationResults) {
  return [
    ...validationResults.approvedFindings,
    ...validationResults.adjustedFindings,
  ];
}

/**
 * Generates a validation report
 * @param {Object} validationResults - Results from validateFindings()
 * @returns {string} Markdown validation report
 */
export function generateValidationReport(validationResults) {
  let report = '# Validation Report\n\n';

  report += `## Summary\n\n`;
  report += `- **Total Findings**: ${validationResults.summary.total}\n`;
  report += `- **Approved**: ${validationResults.summary.approved}\n`;
  report += `- **Adjusted**: ${validationResults.summary.adjusted}\n`;
  report += `- **Blocked**: ${validationResults.summary.blocked}\n`;
  report += `- **Final Count**: ${validationResults.summary.finalCount}\n`;
  report += `- **Average Confidence**: ${(validationResults.summary.averageConfidence * 100).toFixed(1)}%\n\n`;

  if (validationResults.blockedFindings.length > 0) {
    report += `## Blocked Findings\n\n`;
    validationResults.blockedFindings.forEach(blocked => {
      report += `### ${blocked.finding.id}\n`;
      report += `- **Description**: ${blocked.finding.description}\n`;
      report += `- **Reason**: ${blocked.reason}\n`;
      report += `- **Issues**:\n`;
      blocked.issues.forEach(issue => {
        report += `  - ${issue}\n`;
      });
      report += '\n';
    });
  }

  if (validationResults.adjustedFindings.length > 0) {
    report += `## Adjusted Findings\n\n`;
    validationResults.adjustedFindings.forEach(finding => {
      report += `### ${finding.id}\n`;
      report += `- **Description**: ${finding.description}\n`;

      if (finding.validation?.warnings) {
        report += `- **Warnings**:\n`;
        finding.validation.warnings.forEach(warning => {
          report += `  - ${warning}\n`;
        });
      }

      if (finding.estimatedImpact) {
        report += `- **Impact Adjusted**: ${finding.estimatedImpact.reduction} (confidence: ${(finding.estimatedImpact.confidence * 100).toFixed(0)}%)\n`;
      }

      report += '\n';
    });
  }

  return report;
}

/**
 * Saves validation results to cache
 * @param {string} pageUrl - Page URL
 * @param {string} deviceType - Device type
 * @param {Object} validationResults - Validation results
 * @param {string} model - Model name
 */
export function saveValidationResults(pageUrl, deviceType, validationResults, model) {
  try {
    cacheResults(pageUrl, deviceType, 'validation', validationResults, '', model);

    const report = generateValidationReport(validationResults);
    cacheResults(pageUrl, deviceType, 'validation-report', report, '', model);
  } catch (error) {
    console.warn('Failed to save validation results:', error.message);
  }
}
