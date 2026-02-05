/**
 * JSON Parser Utilities
 * Simplified extraction logic with minimal fallbacks
 *
 * Primary path: Use withStructuredOutput() in suggestions-engine.js
 * This module is ONLY for backward compatibility with legacy cached outputs
 */

// Import transformFindingsToSuggestions from sibling module
import { transformFindingsToSuggestions } from './transformers.js';
import { LLM_PATTERNS } from '../../../config/regex-patterns.js';
// Import suggestionSchema from dedicated schemas module
import { suggestionSchema } from '../schemas.js';

/**
 * Extract structured suggestions from markdown content
 * LEGACY FALLBACK ONLY - Modern flow uses withStructuredOutput()
 *
 * @param {string} content - Markdown content from cached reports
 * @param {string} pageUrl - Page URL
 * @param {string} deviceType - Device type
 * @returns {Object|null} Parsed suggestions object or null
 */
export function extractStructuredSuggestions(content, pageUrl, deviceType) {
    if (!content || typeof content !== 'string') {
        console.warn('extractStructuredSuggestions: invalid content');
        return null;
    }

    try {
        // Pattern 1: Try primary format (final synthesis JSON block)
        const primaryMatch = content.match(
            /## STRUCTURED DATA FOR AUTOMATION[\s\S]*?```json\s*(\{[\s\S]*?\})\s*```/
        );

        if (primaryMatch) {
            try {
                const parsed = JSON.parse(primaryMatch[1]);
                return validateAndNormalize(parsed, pageUrl, deviceType);
            } catch (e) {
                console.warn('Failed to parse primary JSON format:', e.message);
            }
        }

        // Pattern 2: Aggregate individual agent JSON blocks (fallback)
        return aggregateAgentFindings(content, pageUrl, deviceType);

    } catch (e) {
        console.warn('extractStructuredSuggestions: parse failed:', e.message);
        return null;
    }
}

/**
 * Aggregate findings from individual agent JSON blocks
 * @param {string} content - Markdown content
 * @param {string} pageUrl - Page URL
 * @param {string} deviceType - Device type
 * @returns {Object|null} Aggregated suggestions object
 */
function aggregateAgentFindings(content, pageUrl, deviceType) {
    console.log('📊 Aggregating findings from individual agent JSON blocks');
    const allFindings = [];

    // Find all JSON blocks in the content
    // Use centralized LLM pattern for JSON block extraction
  const jsonBlockRegex = LLM_PATTERNS.JSON_BLOCK;
    let match;

    while ((match = jsonBlockRegex.exec(content)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed.findings) && parsed.findings.length > 0) {
                console.log(`   Found ${parsed.findings.length} findings from ${parsed.agentName || 'unknown agent'}`);
                allFindings.push(...parsed.findings);
            }
        } catch (e) {
            // Skip invalid JSON blocks
            continue;
        }
    }

    if (allFindings.length === 0) {
        console.warn('No structured data found in content');
        return null;
    }

    console.log(`✅ Aggregated ${allFindings.length} total findings from all agents`);

    // Transform findings to suggestions
    const suggestions = transformFindingsToSuggestions(allFindings);

    // Build summary from findings
    const summary = buildSummaryFromFindings(allFindings);

    return {
        url: pageUrl,
        deviceType: deviceType,
        timestamp: new Date().toISOString(),
        suggestions,
        summary: Object.keys(summary).length > 0 ? summary : undefined
    };
}

/**
 * Validate and normalize parsed JSON
 * @param {Object} parsed - Parsed JSON object
 * @param {string} pageUrl - Page URL
 * @param {string} deviceType - Device type
 * @returns {Object} Validated and normalized object
 */
function validateAndNormalize(parsed, pageUrl, deviceType) {
    let suggestions = parsed.suggestions;

    // Handle causal graph format (has findings instead of suggestions)
    if (!Array.isArray(suggestions) && Array.isArray(parsed.findings)) {
        console.log('Converting findings to suggestions format');
        suggestions = transformFindingsToSuggestions(parsed.findings);
    }

    // Normalize suggestions to fix common LLM output issues
    const normalizedSuggestions = Array.isArray(suggestions) ? suggestions.map(s => {
        // Fix comma-separated metrics (e.g., "LCP, INP" → ["LCP", "INP"])
        if (s.metric && typeof s.metric === 'string' && s.metric.includes(',')) {
            s.metric = s.metric.split(',').map(m => m.trim());
        }
        return s;
    }) : [];

    // Build summary from findings if available
    let summary = {};
    if (Array.isArray(parsed.findings)) {
        summary = buildSummaryFromFindings(parsed.findings);
    }

    // Inject known metadata (url/timestamp are not in schema - they're code-injected to avoid LLM typos)
    const normalized = {
        ...parsed,
        url: parsed.url || pageUrl,
        deviceType: parsed.deviceType || deviceType,
        timestamp: parsed.timestamp || new Date().toISOString(),
        suggestions: normalizedSuggestions,
        summary: Object.keys(summary).length > 0 ? summary : undefined
    };

    // Validate with Zod schema (logs warnings but doesn't block)
    // Note: url/timestamp are not in schema but are in normalized - Zod ignores extra props
    try {
        suggestionSchema.parse(normalized);
    } catch (zodError) {
        console.warn('Suggestion schema validation failed:', zodError.errors?.[0]?.message || 'Unknown validation error');
        // Continue despite validation errors for backward compatibility
    }

    return normalized;
}

/**
 * Build summary object from findings grouped by metric
 * @param {Array} findings - Array of findings
 * @returns {Object} Summary object
 */
function buildSummaryFromFindings(findings) {
    const metricGroups = findings.reduce((acc, finding) => {
        const metric = finding.metric?.toLowerCase();
        if (metric && ['lcp', 'cls', 'inp', 'ttfb'].includes(metric)) {
            if (!acc[metric]) {
                acc[metric] = { findings: [], current: null, target: null };
            }
            acc[metric].findings.push(finding);
        }
        return acc;
    }, {});

    const summary = {};
    Object.keys(metricGroups).forEach(metric => {
        const group = metricGroups[metric];
        const hasIssues = group.findings.some(f => f.rootCause);
        summary[metric] = {
            current: 'Unknown',
            target: metric === 'lcp' ? '2.5s' : metric === 'cls' ? '0.1' : metric === 'inp' ? '200ms' : '600ms',
            status: hasIssues ? 'poor' : 'good'
        };
    });

    return summary;
}
