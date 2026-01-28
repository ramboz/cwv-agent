import { StateGraph, END, START } from '@langchain/langgraph';
import { collectData } from './collect.js';
import { MultiAgentSystem } from './multi-agents.js';
import { buildCausalGraph, generateGraphSummary } from './causal-graph-builder.js';
import { validateFindings } from './validator.js';
import { getConfig } from '../config/index.js';
import { cacheResults } from '../utils.js';

/**
 * Workflow state schema
 */
export const WorkflowState = {
  // Input
  pageUrl: null,
  deviceType: null,
  model: null,
  skipCache: false,
  runId: null,

  // Data collection
  pageData: null,
  collectionErrors: [],

  // Agent execution
  agentOutputs: [],
  agentErrors: [],

  // Causal analysis
  causalGraph: null,
  graphSummary: '',

  // Validation
  validationResults: null,
  validatedFindings: [],

  // Final output
  finalSuggestions: null,
  report: null,

  // Workflow control
  iterationCount: 0,
  shouldRefine: false,
  validationFeedback: [],

  // Metrics
  startTime: null,
  endTime: null,
  totalCost: 0,
};

/**
 * Data collection node
 */
async function collectDataNode(state) {
  console.log(`\n🔍 Collecting performance data for ${state.pageUrl}...`);

  try {
    const pageData = await collectData(
      state.pageUrl,
      state.deviceType,
      state.skipCache,
      state.model
    );

    return {
      ...state,
      pageData,
      collectionErrors: [],
    };
  } catch (error) {
    console.error('Data collection failed:', error.message);
    return {
      ...state,
      collectionErrors: [error.message],
    };
  }
}

/**
 * Multi-agent analysis node
 */
async function runAgentsNode(state) {
  console.log('\n🤖 Running multi-agent analysis...');

  if (state.collectionErrors.length > 0) {
    console.error('Skipping agent execution due to collection errors');
    return state;
  }

  try {
    const system = new MultiAgentSystem(state.pageData, state.model);

    // Execute agents in parallel
    const outputs = await system.executeAllAgents();

    return {
      ...state,
      agentOutputs: outputs,
      agentErrors: [],
    };
  } catch (error) {
    console.error('Agent execution failed:', error.message);
    return {
      ...state,
      agentErrors: [error.message],
    };
  }
}

/**
 * Causal graph building node
 */
async function buildGraphNode(state) {
  console.log('\n🕸️  Building causal graph...');

  if (state.agentErrors.length > 0) {
    console.error('Skipping graph building due to agent errors');
    return state;
  }

  try {
    // Extract findings from agent outputs
    const allFindings = state.agentOutputs.flatMap(output => {
      if (output.findings && Array.isArray(output.findings)) {
        return output.findings;
      }
      return [];
    });

    if (allFindings.length === 0) {
      console.log('No findings to build graph from');
      return state;
    }

    // Build metrics data
    const metricsData = {};
    allFindings.forEach(f => {
      if (f.metric && f.estimatedImpact?.metric) {
        metricsData[f.metric] = f.estimatedImpact.current || 0;
      }
    });

    const causalGraph = buildCausalGraph(allFindings, metricsData);
    const graphSummary = generateGraphSummary(causalGraph);

    // Cache graph
    cacheResults(
      state.pageData.pageUrl,
      state.pageData.deviceType,
      'causal-graph',
      causalGraph,
      '',
      state.model
    );

    console.log(`✅ Causal Graph: ${causalGraph.rootCauses.length} root causes, ${causalGraph.criticalPaths.length} critical paths`);

    return {
      ...state,
      causalGraph,
      graphSummary,
    };
  } catch (error) {
    console.error('Graph building failed:', error.message);
    return state;
  }
}

/**
 * Validation node
 */
async function validateNode(state) {
  console.log('\n✅ Validating findings...');

  if (!state.causalGraph || state.agentErrors.length > 0) {
    console.error('Skipping validation due to missing graph or agent errors');
    return state;
  }

  try {
    const config = getConfig();
    const allFindings = state.agentOutputs.flatMap(output => output.findings || []);

    const validationResults = validateFindings(allFindings, state.causalGraph, {
      blockingMode: config.validation.blockingMode,
      adjustMode: config.validation.adjustMode,
      strictMode: config.validation.strictMode,
    });

    const validatedFindings = [
      ...validationResults.approvedFindings,
      ...validationResults.adjustedFindings,
    ];

    console.log(`✅ Validation: ${validationResults.summary.approved} approved, ${validationResults.summary.adjusted} adjusted, ${validationResults.summary.blocked} blocked`);

    // Generate feedback for blocked/adjusted findings
    const feedback = [];
    validationResults.blockedFindings.forEach(blocked => {
      feedback.push({
        findingId: blocked.finding.id,
        agentName: blocked.finding.source || 'unknown',
        issue: blocked.reason,
        suggestion: `Improve evidence quality and impact estimation`,
      });
    });

    return {
      ...state,
      validationResults,
      validatedFindings,
      validationFeedback: feedback,
    };
  } catch (error) {
    console.error('Validation failed:', error.message);
    return state;
  }
}

/**
 * Synthesis node
 */
async function synthesizeNode(state) {
  console.log('\n📝 Synthesizing final suggestions...');

  // Implementation would call existing synthesis logic
  // For now, just pass through validated findings

  return {
    ...state,
    finalSuggestions: state.validatedFindings,
    endTime: Date.now(),
  };
}

/**
 * Conditional routing: Should we refine?
 */
function shouldRefineCondition(state) {
  const config = getConfig();

  // Don't refine if max iterations reached
  if (state.iterationCount >= config.workflow.maxIterations) {
    return 'synthesize';
  }

  // Don't refine if feedback loop disabled
  if (!config.workflow.enableFeedbackLoop) {
    return 'synthesize';
  }

  // Refine if validation blocked >20% of findings
  if (state.validationResults) {
    const blockRate = state.validationResults.summary.blocked / state.validationResults.summary.total;
    if (blockRate > 0.2) {
      console.log(`⚠️  High block rate (${(blockRate * 100).toFixed(1)}%), refining...`);
      return 'refine';
    }
  }

  return 'synthesize';
}

/**
 * Refinement node - incorporates validation feedback
 */
async function refineNode(state) {
  console.log('\n🔄 Refining with validation feedback...');

  // Increment iteration count
  const newState = {
    ...state,
    iterationCount: state.iterationCount + 1,
  };

  // In a full implementation, this would:
  // 1. Inject validation feedback into agent prompts
  // 2. Re-run agents with feedback context
  // 3. Guide agents to avoid previous mistakes

  // For now, just log and continue
  console.log(`Refinement iteration ${newState.iterationCount}`);
  console.log(`Feedback items: ${state.validationFeedback.length}`);

  return newState;
}

/**
 * Create and compile the workflow
 */
export function createCWVWorkflow() {
  const workflow = new StateGraph({
    channels: WorkflowState,
  });

  // Add nodes
  workflow.addNode('collect_data', collectDataNode);
  workflow.addNode('run_agents', runAgentsNode);
  workflow.addNode('build_graph', buildGraphNode);
  workflow.addNode('validate', validateNode);
  workflow.addNode('synthesize', synthesizeNode);
  workflow.addNode('refine', refineNode);

  // Add edges
  workflow.addEdge(START, 'collect_data');
  workflow.addEdge('collect_data', 'run_agents');
  workflow.addEdge('run_agents', 'build_graph');
  workflow.addEdge('build_graph', 'validate');

  // Conditional routing after validation
  workflow.addConditionalEdges(
    'validate',
    shouldRefineCondition,
    {
      refine: 'run_agents',    // Go back and refine
      synthesize: 'synthesize', // Proceed to final synthesis
    }
  );

  // Refinement loop back to agents
  workflow.addEdge('refine', 'run_agents');

  // End after synthesis
  workflow.addEdge('synthesize', END);

  return workflow.compile();
}

/**
 * Execute CWV analysis workflow
 * @param {string} pageUrl - URL to analyze
 * @param {string} deviceType - Device type (mobile/desktop)
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Workflow result
 */
export async function executeCWVWorkflow(pageUrl, deviceType, options = {}) {
  const config = getConfig();

  const initialState = {
    pageUrl,
    deviceType,
    model: options.model || config.models.primary,
    skipCache: options.skipCache || false,
    runId: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    startTime: Date.now(),
    iterationCount: 0,
    agentOutputs: [],
    collectionErrors: [],
    agentErrors: [],
    validationFeedback: [],
  };

  console.log(`\n🚀 Starting CWV Workflow`);
  console.log(`   URL: ${pageUrl}`);
  console.log(`   Device: ${deviceType}`);
  console.log(`   Model: ${initialState.model}`);
  console.log(`   Run ID: ${initialState.runId}`);

  const workflow = createCWVWorkflow();
  const result = await workflow.invoke(initialState);

  const duration = (result.endTime - result.startTime) / 1000;
  console.log(`\n✅ Workflow completed in ${duration.toFixed(1)}s`);
  console.log(`   Iterations: ${result.iterationCount}`);
  console.log(`   Final findings: ${result.validatedFindings?.length || 0}`);

  return result;
}
