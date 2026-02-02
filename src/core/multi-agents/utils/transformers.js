/**
 * Transformation Utilities
 * Extracted from multi-agents.js for better maintainability
 *
 * Handles:
 * - transformFindingsToSuggestions: Convert causal graph findings to SpaceCat format
 * - formatSuggestionsToMarkdown: Generate human-readable markdown from JSON
 */

/**
 * Transform findings (causal graph format) to suggestions (SpaceCat legacy format)
 * Maps Phase 1 structured findings → legacy suggestion format for compatibility
 *
 * @param {Array} findings - Array of finding objects from agents
 * @returns {Array} Array of suggestion objects in SpaceCat format
 */
export function transformFindingsToSuggestions(findings) {
    if (!Array.isArray(findings)) return [];

    return findings.map((finding, index) => {
        // Determine priority from confidence and root cause status
        let priority = 'Medium';
        if (finding.rootCause && finding.evidence?.confidence > 0.8) {
            priority = 'High';
        } else if (!finding.rootCause || finding.evidence?.confidence < 0.6) {
            priority = 'Low';
        }

        // Determine effort from type and estimated impact
        let effort = 'Medium';
        if (finding.type === 'opportunity' || finding.estimatedImpact?.reduction < 100) {
            effort = 'Easy';
        } else if (finding.rootCause && finding.estimatedImpact?.reduction > 500) {
            effort = 'Hard';
        }

        // Extract implementation from reasoning.solution
        let implementation = '';
        if (finding.reasoning?.solution) {
            implementation = finding.reasoning.solution;
        } else if (finding.description) {
            // Fallback to description if no solution provided
            implementation = finding.description;
        }

        // Generate code example from implementation text
        let codeExample = null;
        if (implementation) {
            // Extract code blocks from implementation text
            const codeMatch = implementation.match(/```(?:javascript|css|html)?\s*([\s\S]*?)```/);
            if (codeMatch) {
                codeExample = codeMatch[1].trim();
            }
        }

        // Format impact as a string
        let impact = 'Not estimated';
        if (finding.estimatedImpact) {
            const { metric, reduction, confidence } = finding.estimatedImpact;
            if (metric && reduction) {
                // CLS is unitless, others use ms
                const unit = metric === 'CLS' ? '' : 'ms';
                impact = `~${reduction}${unit} ${metric} improvement (${Math.round(confidence * 100)}% confidence)`;
            }
        }

        // Determine category from metric
        const category = finding.metric?.toLowerCase() || 'general';

        return {
            id: index + 1,
            title: finding.description || `${finding.metric} Optimization`,
            description: finding.reasoning?.observation || finding.description,
            // Solution field: clear explanation of the fix in plain language
            solution: implementation || `Address the ${finding.metric || 'performance'} issue by implementing the recommended optimizations.`,
            metric: finding.metric,
            priority,
            effort,
            estimatedImpact: impact,
            implementation,
            codeExample,
            category
        };
    });
}

/**
 * Format structured suggestions (JSON) into human-readable markdown
 * This is the "view layer" - JSON is the canonical source of truth
 *
 * @param {Object} structuredData - The structured suggestions object
 * @param {Object} metadata - Additional context (url, deviceType, rootCauses, etc.)
 * @returns {string} Formatted markdown report
 */
export function formatSuggestionsToMarkdown(structuredData, metadata = {}) {
    const { url, deviceType, rootCauseImpacts, validationSummary } = metadata;
    const suggestions = structuredData.suggestions || [];

    let markdown = `# Core Web Vitals Analysis Report

**URL**: ${url}
**Device**: ${deviceType}
**Date**: ${new Date().toISOString()}
**Suggestions**: ${suggestions.length}

---

`;

    // Add root cause summary if available
    if (rootCauseImpacts && rootCauseImpacts.length > 0) {
        markdown += `## Root Cause Analysis

${rootCauseImpacts.length} fundamental issues identified that cascade to multiple symptoms:

${rootCauseImpacts.slice(0, 5).map((rc, i) => `
${i + 1}. **${rc.description}**
   - Affects: ${rc.affectedFindings} finding(s)
   - Total impact: ~${rc.totalImpact}ms
`).join('')}

---

`;
    }

    // Add validation summary if available
    if (validationSummary) {
        markdown += `## Validation Summary

- Total findings: ${validationSummary.total || 0}
- Approved: ${validationSummary.approved || 0}
- Adjusted: ${validationSummary.adjusted || 0}
- Blocked: ${validationSummary.blocked || 0}
- Average confidence: ${((validationSummary.averageConfidence || 0) * 100).toFixed(1)}%

---

`;
    }

    // Format each suggestion
    markdown += `## Recommendations\n\n`;

    suggestions.forEach((suggestion, index) => {
        markdown += `### ${index + 1}. ${suggestion.title}

**Issue**: ${suggestion.description}

`;

        // Solution is the most important part - explain the fix clearly
        if (suggestion.solution) {
            markdown += `**Solution**: ${suggestion.solution}\n\n`;
        }

        if (suggestion.metric) {
            const metrics = Array.isArray(suggestion.metric) ? suggestion.metric.join(', ') : suggestion.metric;
            markdown += `**Metric**: ${metrics}  \n`;
        }

        if (suggestion.priority) {
            markdown += `**Priority**: ${suggestion.priority}  \n`;
        }

        if (suggestion.effort) {
            markdown += `**Effort**: ${suggestion.effort}  \n`;
        }

        if (suggestion.estimatedImpact) {
            markdown += `**Estimated Impact**: ${suggestion.estimatedImpact}  \n`;
        }

        if (suggestion.confidence) {
            markdown += `**Confidence**: ${(suggestion.confidence * 100).toFixed(0)}%  \n`;
        }

        if (suggestion.evidence && suggestion.evidence.length > 0) {
            markdown += `\n**Evidence**:\n${suggestion.evidence.map(e => `- ${e}`).join('\n')}\n`;
        }

        if (suggestion.codeChanges && suggestion.codeChanges.length > 0) {
            markdown += `\n**Code Changes**:\n`;
            suggestion.codeChanges.forEach(change => {
                markdown += `\nFile: \`${change.file}\`${change.line ? `:${change.line}` : ''}\n`;
                if (change.before && change.after) {
                    markdown += `\`\`\`diff\n- ${change.before}\n+ ${change.after}\n\`\`\`\n`;
                }
            });
        }

        if (suggestion.validationCriteria && suggestion.validationCriteria.length > 0) {
            markdown += `\n**Validation Criteria**:\n${suggestion.validationCriteria.map(c => `- ${c}`).join('\n')}\n`;
        }

        // NEW: Format verification instructions
        if (suggestion.verification) {
            markdown += `\n**How to Verify This Fix**:\n`;
            markdown += `- **Tool**: ${suggestion.verification.tool}\n`;
            markdown += `- **Method**:\n`;
            // Split method by newlines and format as numbered list
            const methodSteps = suggestion.verification.method.split('\\n').filter(s => s.trim());
            methodSteps.forEach(step => {
                markdown += `  ${step}\n`;
            });
            markdown += `- **Expected Result**: ${suggestion.verification.expectedImprovement}\n`;
            if (suggestion.verification.acceptanceCriteria) {
                markdown += `- **Acceptance Criteria**: ${suggestion.verification.acceptanceCriteria}\n`;
            }
        }

        markdown += `\n---\n\n`;
    });

    return markdown;
}
