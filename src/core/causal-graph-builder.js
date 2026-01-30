/**
 * Phase 3: Causal Graph Builder
 *
 * Constructs dependency graphs from agent findings to identify root causes,
 * distinguish symptoms, and find duplicate/compound issues.
 */

import { extractFileName } from '../config/regex-patterns.js';

import {
  createEmptyGraph,
  createNodeFromFinding,
  createMetricNode,
  createEdge,
  addNode,
  addEdge,
  calculateDepths,
  identifyRootCauses,
  identifySymptoms,
  findCriticalPaths,
  exportToDot,
} from '../models/causal-graph.js';

/**
 * Classifies a finding into a semantic type for better relationship detection
 * @param {Object} finding - The finding to classify
 * @returns {string} Finding type
 */
function classifyFindingType(finding) {
  const desc = (finding.finding || finding.description || '').toLowerCase();
  const evidence = (finding.evidence?.[0]?.reference || '').toLowerCase();

  // Image-related issues
  if (desc.includes('missing width') || desc.includes('missing height') ||
      desc.includes('unsized image') || desc.includes('image dimension')) {
    return 'image-sizing';
  }

  // Code/resource waste
  if (desc.includes('unused') && (desc.includes('css') || desc.includes('code') || desc.includes('javascript'))) {
    return 'unused-code';
  }

  // Font-specific issues
  if (desc.includes('font') && (desc.includes('format') || desc.includes('woff2') || desc.includes('ttf'))) {
    return 'font-format';
  }
  if (desc.includes('font') && desc.includes('preload')) {
    return 'font-preload';
  }

  // Resource loading issues
  if (desc.includes('preload') && !desc.includes('font')) {
    return 'resource-preload';
  }
  if (desc.includes('preconnect') || desc.includes('dns-prefetch')) {
    return 'resource-hints';
  }

  // Rendering issues
  if (desc.includes('render-blocking') || desc.includes('blocking resource')) {
    return 'blocking-resource';
  }
  if (desc.includes('inline') && desc.includes('css')) {
    return 'inline-css';
  }

  // Layout issues
  if (desc.includes('layout shift') || desc.includes('cumulative layout')) {
    return 'layout-shift';
  }

  return 'unknown';
}

/**
 * Builds a causal graph from all agent findings
 * @param {Object[]} allFindings - Array of findings from all agents
 * @param {Object} metricsData - Current metric values (LCP, CLS, INP, etc.)
 * @returns {Object} Causal graph with nodes, edges, and analysis
 */
export function buildCausalGraph(allFindings, metricsData) {
  const graph = createEmptyGraph();

  // Step 1: Create metric nodes (observable symptoms at top level)
  addMetricNodes(graph, metricsData);

  // Step 2: Create finding nodes
  allFindings.forEach(finding => {
    const node = createNodeFromFinding(finding);
    addNode(graph, node);
  });

  // Step 3: Connect findings to metrics they affect
  connectFindingsToMetrics(graph, allFindings);

  // Step 4: Connect findings to each other (find dependencies)
  connectFindingsToFindings(graph, allFindings);

  // Step 5: Calculate node depths
  calculateDepths(graph);

  // Step 6: Identify root causes and symptoms
  identifyRootCauses(graph);
  identifySymptoms(graph);

  // Step 7: Find critical paths from root causes to metrics
  const criticalPaths = [];
  Object.values(graph.nodes)
    .filter(n => n.type === 'metric')
    .forEach(metricNode => {
      const paths = findCriticalPaths(graph, metricNode.id);
      criticalPaths.push(...paths);
    });
  graph.criticalPaths = criticalPaths;

  return graph;
}

/**
 * Adds metric nodes to the graph
 * @param {Object} graph - The causal graph
 * @param {Object} metricsData - Metric values
 */
function addMetricNodes(graph, metricsData) {
  const thresholds = {
    LCP: 2500,  // ms
    CLS: 0.1,   // score
    INP: 200,   // ms
    TBT: 300,   // ms
    TTFB: 800,  // ms
    FCP: 1800,  // ms
  };

  Object.entries(metricsData).forEach(([metric, value]) => {
    if (thresholds[metric]) {
      const node = createMetricNode(metric, value, thresholds[metric]);
      addNode(graph, node);
    }
  });
}

/**
 * Connects finding nodes to the metrics they affect
 * @param {Object} graph - The causal graph
 * @param {Object[]} allFindings - All findings
 */
function connectFindingsToMetrics(graph, allFindings) {
  allFindings.forEach(finding => {
    const metricId = `metric-${finding.metric.toLowerCase()}`;
    const metricNode = graph.nodes[metricId];

    if (metricNode) {
      // Determine relationship type based on finding type
      let relationship = 'contributes';
      if (finding.type === 'bottleneck') relationship = 'blocks';
      else if (finding.type === 'waste') relationship = 'delays';
      else if (finding.type === 'opportunity') relationship = 'contributes';

      const edge = createEdge(
        finding.id,
        metricId,
        relationship,
        finding.evidence?.confidence || 0.7,
        finding.reasoning?.mechanism || finding.description
      );

      addEdge(graph, edge);
    }
  });
}

/**
 * Connects findings to each other based on relationships
 * @param {Object} graph - The causal graph
 * @param {Object[]} allFindings - All findings
 */
function connectFindingsToFindings(graph, allFindings) {
  // Check each pair of findings for relationships
  for (let i = 0; i < allFindings.length; i++) {
    for (let j = i + 1; j < allFindings.length; j++) {
      const findingA = allFindings[i];
      const findingB = allFindings[j];

      const relationship = detectRelationship(findingA, findingB);
      if (relationship) {
        const edge = createEdge(
          relationship.from,
          relationship.to,
          relationship.type,
          relationship.strength,
          relationship.mechanism
        );
        addEdge(graph, edge);
      }
    }
  }
}

/**
 * Detects if two findings are related
 * @param {Object} findingA - First finding
 * @param {Object} findingB - Second finding
 * @returns {Object|null} Relationship object or null
 */
function detectRelationship(findingA, findingB) {
  // Check for duplicates (same issue, different agents)
  if (areDuplicates(findingA, findingB)) {
    return {
      from: findingA.id,
      to: findingB.id,
      type: 'duplicates',
      strength: 1.0,
      mechanism: 'Same issue detected by multiple agents'
    };
  }

  // Check for file-based relationships
  const fileRelationship = detectFileRelationship(findingA, findingB);
  if (fileRelationship) return fileRelationship;

  // Check for metric-based relationships
  const metricRelationship = detectMetricRelationship(findingA, findingB);
  if (metricRelationship) return metricRelationship;

  // Check for timing-based relationships
  const timingRelationship = detectTimingRelationship(findingA, findingB);
  if (timingRelationship) return timingRelationship;

  return null;
}

/**
 * Checks if two findings are duplicates
 * @param {Object} findingA - First finding
 * @param {Object} findingB - Second finding
 * @returns {boolean} True if duplicates
 */
function areDuplicates(findingA, findingB) {
  // Same metric and very similar descriptions
  if (findingA.metric !== findingB.metric) return false;

  // First check: must be same semantic type
  const typeA = classifyFindingType(findingA);
  const typeB = classifyFindingType(findingB);
  if (typeA !== typeB) return false; // Different types → not duplicates

  const descA = findingA.description.toLowerCase();
  const descB = findingB.description.toLowerCase();

  // Second check: keyword overlap (stricter threshold)
  const keywords = ['hero', 'image', 'font', 'script', 'css', 'render-blocking', 'unused', 'preload'];
  const commonKeywords = keywords.filter(kw => descA.includes(kw) && descB.includes(kw));

  // Require 3+ keywords for duplicates (not just 2)
  if (commonKeywords.length < 3) return false;

  // Third check: similar evidence references (same file)
  const refA = findingA.evidence?.[0]?.reference || '';
  const refB = findingB.evidence?.[0]?.reference || '';
  const fileA = refA.match(/([a-zA-Z0-9_-]+\.(js|css|woff2?|jpg|png|webp))/)?.[1];
  const fileB = refB.match(/([a-zA-Z0-9_-]+\.(js|css|woff2?|jpg|png|webp))/)?.[1];

  // If both reference same file with same type, likely duplicate
  return fileA && fileB && fileA === fileB;
}

/**
 * Detects file-based relationships (same file mentioned)
 * @param {Object} findingA - First finding
 * @param {Object} findingB - Second finding
 * @returns {Object|null} Relationship or null
 */
function detectFileRelationship(findingA, findingB) {
  const refA = findingA.evidence?.reference || '';
  const refB = findingB.evidence?.reference || '';

  // Extract file names from references using centralized pattern
  const fileA = extractFileName(refA);
  const fileB = extractFileName(refB);
  const filePatternA = fileA ? [fileA, fileA] : null; // Preserve array format for compatibility
  const filePatternB = fileB ? [fileB, fileB] : null;

  if (filePatternA && filePatternB && filePatternA[1] === filePatternB[1]) {
    const filename = filePatternA[1];

    // Get semantic types of both findings
    const typeA = classifyFindingType(findingA);
    const typeB = classifyFindingType(findingB);

    // Define compatible type pairs that can be grouped
    // Only group if same file AND compatible operation types
    const compatiblePairs = [
      ['unused-code', 'blocking-resource'],  // Unused code causes bloat in blocking resource
      ['font-format', 'font-preload'],       // Font format and font preload are related
      ['unused-code', 'font-format'],        // Unused code in font files relates to format issues
      ['resource-preload', 'blocking-resource'], // Preload issues relate to blocking
    ];

    const isCompatible = compatiblePairs.some(([t1, t2]) =>
      (typeA === t1 && typeB === t2) || (typeA === t2 && typeB === t1)
    );

    // Skip relationship if types are incompatible
    // (e.g., don't group image-sizing + unused-code even if same CSS file)
    if (!isCompatible) {
      return null;
    }

    // Determine direction based on finding types
    // Coverage finding (waste) often causes PSI finding (bottleneck)
    if (findingA.type === 'waste' && findingB.type === 'bottleneck') {
      return {
        from: findingA.id,
        to: findingB.id,
        type: 'contributes',
        strength: 0.8,
        mechanism: `${typeA} in ${filename} contributes to ${typeB}`
      };
    } else if (findingB.type === 'waste' && findingA.type === 'bottleneck') {
      return {
        from: findingB.id,
        to: findingA.id,
        type: 'contributes',
        strength: 0.8,
        mechanism: `${typeB} in ${filename} contributes to ${typeA}`
      };
    }

    // Compatible types - create relationship
    return {
      from: findingA.id,
      to: findingB.id,
      type: 'contributes',
      strength: 0.6,
      mechanism: `Both ${typeA} and ${typeB} relate to ${filename}`
    };
  }

  return null;
}

/**
 * Detects metric-based relationships (cascading metrics)
 * @param {Object} findingA - First finding
 * @param {Object} findingB - Second finding
 * @returns {Object|null} Relationship or null
 */
function detectMetricRelationship(findingA, findingB) {
  // Metric dependencies: FCP → LCP, TBT → INP, etc.
  const dependencies = {
    'FCP': ['LCP'],
    'TTFB': ['FCP', 'LCP'],
    'TBT': ['INP'],
  };

  const metricA = findingA.metric;
  const metricB = findingB.metric;

  if (dependencies[metricA]?.includes(metricB)) {
    return {
      from: findingA.id,
      to: findingB.id,
      type: 'depends',
      strength: 0.7,
      mechanism: `${metricB} depends on ${metricA} - improvement in ${metricA} can cascade to ${metricB}`
    };
  } else if (dependencies[metricB]?.includes(metricA)) {
    return {
      from: findingB.id,
      to: findingA.id,
      type: 'depends',
      strength: 0.7,
      mechanism: `${metricA} depends on ${metricB} - improvement in ${metricB} can cascade to ${metricA}`
    };
  }

  return null;
}

/**
 * Detects timing-based relationships
 * @param {Object} findingA - First finding
 * @param {Object} findingB - Second finding
 * @returns {Object|null} Relationship or null
 */
function detectTimingRelationship(findingA, findingB) {
  // Check if both mention pre-LCP or render-blocking
  const descA = findingA.description.toLowerCase();
  const descB = findingB.description.toLowerCase();

  const isPreLcpA = descA.includes('pre-lcp') || descA.includes('render-blocking');
  const isPreLcpB = descB.includes('pre-lcp') || descB.includes('render-blocking');

  if (isPreLcpA && isPreLcpB && findingA.metric === 'LCP' && findingB.metric === 'LCP') {
    // Get semantic types
    const typeA = classifyFindingType(findingA);
    const typeB = classifyFindingType(findingB);

    // Only compound if both are rendering-related issues
    // Don't compound unrelated issues like image-sizing + unused-code
    const renderingTypes = ['blocking-resource', 'font-preload', 'resource-preload', 'inline-css', 'resource-hints'];
    const bothRendering = renderingTypes.includes(typeA) && renderingTypes.includes(typeB);

    if (!bothRendering) {
      return null; // Skip incompatible timing relationship
    }

    return {
      from: findingA.id,
      to: findingB.id,
      type: 'compounds',
      strength: 0.65,
      mechanism: `Multiple pre-LCP rendering issues (${typeA} + ${typeB}) compound to delay LCP`
    };
  }

  return null;
}

/**
 * Exports the causal graph to various formats
 * @param {Object} graph - The causal graph
 * @returns {Object} Export data
 */
export function exportGraph(graph) {
  return {
    json: JSON.stringify(graph, null, 2),
    dot: exportToDot(graph),
    summary: {
      totalNodes: Object.keys(graph.nodes).length,
      totalEdges: graph.edges.length,
      rootCauses: graph.rootCauses.length,
      symptoms: graph.symptoms.length,
      criticalPaths: graph.criticalPaths.length,
      avgDepth: Object.values(graph.nodes)
        .filter(n => n.depth !== null)
        .reduce((sum, n) => sum + n.depth, 0) / Object.keys(graph.nodes).length
    }
  };
}

/**
 * Generates a human-readable summary of the causal graph
 * @param {Object} graph - The causal graph
 * @returns {string} Markdown summary
 */
export function generateGraphSummary(graph) {
  let summary = '# Causal Graph Analysis\n\n';

  summary += `## Summary Statistics\n\n`;
  summary += `- **Total Issues**: ${Object.keys(graph.nodes).length}\n`;
  summary += `- **Root Causes**: ${graph.rootCauses.length}\n`;
  summary += `- **Symptoms**: ${graph.symptoms.length}\n`;
  summary += `- **Relationships**: ${graph.edges.length}\n`;
  summary += `- **Critical Paths**: ${graph.criticalPaths.length}\n\n`;

  summary += `## Root Causes (Fix These First)\n\n`;
  graph.rootCauses.forEach(id => {
    const node = graph.nodes[id];
    summary += `- **${node.description}**\n`;
    summary += `  - Type: ${node.type}\n`;
    summary += `  - Affects: ${node.causedBy.map(cid => graph.nodes[cid]?.description || cid).join(', ')}\n\n`;
  });

  summary += `## Critical Paths (Root Cause → Metric)\n\n`;
  graph.criticalPaths.forEach((path, idx) => {
    summary += `### Path ${idx + 1}\n\n`;
    path.forEach((nodeId, i) => {
      const node = graph.nodes[nodeId];
      const indent = '  '.repeat(i);
      summary += `${indent}${i > 0 ? '↓ ' : ''}${node?.description || nodeId}\n`;
    });
    summary += '\n';
  });

  return summary;
}
