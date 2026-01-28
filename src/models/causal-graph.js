/**
 * Phase 3: Causal Graph Data Structures
 *
 * Represents relationships between performance issues to distinguish
 * root causes from symptoms and identify compound issues.
 */

/**
 * Node in the causal graph
 * @typedef {Object} CausalNode
 * @property {string} id - Unique node ID (matches finding ID)
 * @property {string} type - 'metric' | 'bottleneck' | 'waste' | 'opportunity'
 * @property {string} description - Human-readable description
 * @property {boolean} isRootCause - True if this is a root cause (not a symptom)
 * @property {Object} impact - Quantified impact on metrics
 * @property {string[]} causes - IDs of nodes that cause this issue
 * @property {string[]} causedBy - IDs of nodes this issue contributes to
 * @property {number} depth - Distance from root metrics (0 = metric, higher = deeper cause)
 * @property {Object} metadata - Original finding data
 */

/**
 * Edge in the causal graph
 * @typedef {Object} CausalEdge
 * @property {string} from - Source node ID (the cause)
 * @property {string} to - Target node ID (the effect)
 * @property {string} relationship - Type of relationship
 * @property {number} strength - Confidence in this relationship (0-1)
 * @property {string} mechanism - How 'from' causes 'to'
 */

/**
 * Complete causal graph
 * @typedef {Object} CausalGraph
 * @property {Object.<string, CausalNode>} nodes - All nodes keyed by ID
 * @property {CausalEdge[]} edges - All causal relationships
 * @property {string[]} rootCauses - IDs of root cause nodes
 * @property {string[]} symptoms - IDs of symptom nodes
 * @property {string[][]} criticalPaths - Ordered paths from root causes to metrics
 */

/**
 * Relationship types between nodes
 */
export const RelationshipType = {
  BLOCKS: 'blocks',              // A blocks B (render-blocking script blocks LCP)
  DELAYS: 'delays',              // A delays B (slow TTFB delays LCP)
  CAUSES: 'causes',              // A causes B (missing dimensions causes CLS)
  CONTRIBUTES_TO: 'contributes', // A contributes to B (unused code contributes to TBT)
  DEPENDS_ON: 'depends',         // A depends on B (LCP depends on FCP)
  DUPLICATES: 'duplicates',      // A is duplicate of B (same issue, different agent)
  COMPOUNDS: 'compounds',        // A + B compound to worsen C (multiple small CLS sources)
};

/**
 * Creates a new causal node from an agent finding
 * @param {Object} finding - Agent finding object
 * @returns {CausalNode} Causal node
 */
export function createNodeFromFinding(finding) {
  return {
    id: finding.id,
    type: finding.type,
    description: finding.description,
    isRootCause: finding.rootCause || false,
    impact: finding.estimatedImpact || {},
    causes: [],        // Will be populated during graph construction
    causedBy: [],      // Will be populated during graph construction
    depth: null,       // Will be calculated during graph analysis
    metadata: finding,
  };
}

/**
 * Creates a metric node (top-level observable symptom)
 * @param {string} metric - Metric name (LCP, CLS, INP, etc.)
 * @param {number} currentValue - Current metric value
 * @param {number} targetValue - Target/threshold value
 * @returns {CausalNode} Metric node
 */
export function createMetricNode(metric, currentValue, targetValue) {
  return {
    id: `metric-${metric.toLowerCase()}`,
    type: 'metric',
    description: `${metric} is ${currentValue} (target: ${targetValue})`,
    isRootCause: false,  // Metrics are always symptoms
    impact: { metric, current: currentValue, target: targetValue },
    causes: [],
    causedBy: [],
    depth: 0,  // Metrics are always at depth 0
    metadata: { metric, currentValue, targetValue },
  };
}

/**
 * Creates an edge between two nodes
 * @param {string} fromId - Source node ID (cause)
 * @param {string} toId - Target node ID (effect)
 * @param {string} relationship - Relationship type
 * @param {number} strength - Confidence (0-1)
 * @param {string} mechanism - Explanation of causality
 * @returns {CausalEdge} Edge
 */
export function createEdge(fromId, toId, relationship, strength, mechanism) {
  return {
    from: fromId,
    to: toId,
    relationship,
    strength: strength || 0.7,
    mechanism: mechanism || '',
  };
}

/**
 * Initializes an empty causal graph
 * @returns {CausalGraph} Empty graph
 */
export function createEmptyGraph() {
  return {
    nodes: {},
    edges: [],
    rootCauses: [],
    symptoms: [],
    criticalPaths: [],
  };
}

/**
 * Adds a node to the graph
 * @param {CausalGraph} graph - The graph
 * @param {CausalNode} node - Node to add
 */
export function addNode(graph, node) {
  graph.nodes[node.id] = node;
}

/**
 * Adds an edge to the graph and updates node relationships
 * @param {CausalGraph} graph - The graph
 * @param {CausalEdge} edge - Edge to add
 */
export function addEdge(graph, edge) {
  // Add edge
  graph.edges.push(edge);

  // Update node relationships
  const fromNode = graph.nodes[edge.from];
  const toNode = graph.nodes[edge.to];

  if (fromNode && toNode) {
    if (!fromNode.causedBy.includes(edge.to)) {
      fromNode.causedBy.push(edge.to);
    }
    if (!toNode.causes.includes(edge.from)) {
      toNode.causes.push(edge.from);
    }
  }
}

/**
 * Calculates node depths (distance from root metrics)
 * @param {CausalGraph} graph - The graph
 */
export function calculateDepths(graph) {
  // BFS from metric nodes (depth 0)
  const queue = Object.values(graph.nodes).filter(n => n.type === 'metric');
  queue.forEach(n => n.depth = 0);

  const visited = new Set();

  while (queue.length > 0) {
    const node = queue.shift();
    if (visited.has(node.id)) continue;
    visited.add(node.id);

    // Visit nodes that cause this node (go deeper)
    node.causes.forEach(causeId => {
      const causeNode = graph.nodes[causeId];
      if (causeNode && (causeNode.depth === null || causeNode.depth < node.depth + 1)) {
        causeNode.depth = node.depth + 1;
        queue.push(causeNode);
      }
    });
  }
}

/**
 * Identifies root causes (nodes with no incoming edges, or marked as rootCause)
 * @param {CausalGraph} graph - The graph
 * @returns {string[]} IDs of root cause nodes
 */
export function identifyRootCauses(graph) {
  const rootCauses = [];

  Object.values(graph.nodes).forEach(node => {
    // Skip metric nodes (they're symptoms by definition)
    if (node.type === 'metric') return;

    // Node is root cause if:
    // 1. Explicitly marked as rootCause, OR
    // 2. Has no incoming causal edges (nothing causes it)
    const hasIncomingEdges = graph.edges.some(e => e.to === node.id && e.relationship !== RelationshipType.DUPLICATES);

    if (node.isRootCause || !hasIncomingEdges) {
      rootCauses.push(node.id);
    }
  });

  graph.rootCauses = rootCauses;
  return rootCauses;
}

/**
 * Identifies symptoms (nodes that don't cause anything else, excluding metrics)
 * @param {CausalGraph} graph - The graph
 * @returns {string[]} IDs of symptom nodes
 */
export function identifySymptoms(graph) {
  const symptoms = [];

  Object.values(graph.nodes).forEach(node => {
    // Skip root causes and metrics
    if (node.isRootCause || node.type === 'metric') return;

    // Node is symptom if it doesn't cause anything else (leaf node)
    const hasOutgoingEdges = graph.edges.some(e => e.from === node.id);

    if (!hasOutgoingEdges) {
      symptoms.push(node.id);
    }
  });

  graph.symptoms = symptoms;
  return symptoms;
}

/**
 * Finds critical paths from root causes to metrics
 * @param {CausalGraph} graph - The graph
 * @param {string} metricId - Target metric node ID
 * @returns {string[][]} Array of paths (each path is array of node IDs)
 */
export function findCriticalPaths(graph, metricId) {
  const paths = [];
  const metricNode = graph.nodes[metricId];
  if (!metricNode) return paths;

  // DFS from metric backwards to root causes
  function dfs(nodeId, currentPath, visited) {
    const node = graph.nodes[nodeId];
    if (!node || visited.has(nodeId)) return;

    visited.add(nodeId);
    currentPath.push(nodeId);

    // If this is a root cause, save the path
    if (graph.rootCauses.includes(nodeId)) {
      paths.push([...currentPath].reverse()); // Reverse to go root → metric
    } else {
      // Continue to nodes that cause this one
      node.causes.forEach(causeId => {
        dfs(causeId, currentPath, new Set(visited));
      });
    }

    currentPath.pop();
  }

  dfs(metricId, [], new Set());
  return paths;
}

/**
 * Exports graph to DOT format for visualization
 * @param {CausalGraph} graph - The graph
 * @returns {string} DOT format string
 */
export function exportToDot(graph) {
  let dot = 'digraph CausalGraph {\n';
  dot += '  rankdir=BT;\n';  // Bottom to top (root causes at bottom, metrics at top)
  dot += '  node [shape=box];\n\n';

  // Add nodes
  Object.values(graph.nodes).forEach(node => {
    const shape = node.type === 'metric' ? 'ellipse' : 'box';
    const color = node.isRootCause ? 'red' : (node.type === 'metric' ? 'green' : 'lightblue');
    const label = `${node.description}\\n(depth: ${node.depth})`;
    dot += `  "${node.id}" [label="${label}", shape=${shape}, style=filled, fillcolor=${color}];\n`;
  });

  dot += '\n';

  // Add edges
  graph.edges.forEach(edge => {
    const label = `${edge.relationship}\\n(${(edge.strength * 100).toFixed(0)}%)`;
    const style = edge.relationship === RelationshipType.DUPLICATES ? 'dashed' : 'solid';
    dot += `  "${edge.from}" -> "${edge.to}" [label="${label}", style=${style}];\n`;
  });

  dot += '}\n';
  return dot;
}
