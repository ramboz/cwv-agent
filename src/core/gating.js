/**
 * Unified Agent Gating System
 *
 * Provides consistent conditional execution logic for all agents (HAR, Coverage, Code).
 *
 * Key features:
 * - Single decision point per agent (no double-gating)
 * - Declarative rule definitions
 * - Device-aware thresholds
 * - Clear decision logging
 * - Easy to test and maintain
 */

/**
 * Unified thresholds for all agents
 * Based on 50th-75th percentile of real-world websites
 */
const UNIFIED_THRESHOLDS = {
  mobile: {
    // HAR thresholds
    requests: 60,              // Typical: 50-100, threshold catches 70%+
    transferBytes: 1_500_000,  // 1.5 MB - Typical: 1.5-2.5 MB

    // Coverage thresholds
    unusedBytes: 300_000,      // 300 KB of unused code
    unusedRatio: 0.30,         // 30% unused ratio

    // Code thresholds
    firstPartyBytes: 500_000,  // 500 KB of first-party code
    bundleCount: 3,            // 3+ bundles

    // CLS thresholds
    cls: 0.1,                  // CLS threshold (Good: <0.1, Needs work: 0.1-0.25)

    // Third-party thresholds
    thirdPartyCount: 5,        // 5+ third-party scripts
    thirdPartyTime: 500        // 500ms execution time
  },

  desktop: {
    // HAR thresholds (slightly higher for desktop)
    requests: 80,              // Typical: 60-120
    transferBytes: 2_000_000,  // 2 MB

    // Coverage thresholds
    unusedBytes: 400_000,      // 400 KB
    unusedRatio: 0.30,         // 30%

    // Code thresholds
    firstPartyBytes: 700_000,  // 700 KB
    bundleCount: 3,            // 3+ bundles

    // CLS thresholds (same as mobile)
    cls: 0.1,

    // Third-party thresholds (same as mobile)
    thirdPartyCount: 5,
    thirdPartyTime: 500
  }
};

/**
 * Agent-specific gating rules
 * Defines what signals each agent checks and minimum signals required
 */
const AGENT_RULES = {
  har: {
    description: 'HAR Network Analysis Agent',

    // Data signals (from collected HAR stats)
    dataSignals: [
      {
        name: 'Request Count',
        metric: 'entriesCount',
        operator: '>',
        thresholdKey: 'requests',
        description: 'Number of HTTP requests exceeds threshold'
      },
      {
        name: 'Transfer Size',
        metric: 'transferBytes',
        operator: '>',
        thresholdKey: 'transferBytes',
        description: 'Total transfer size exceeds threshold'
      }
    ],

    // PSI signals (from PageSpeed Insights audits)
    psiSignals: [
      {
        name: 'Redirects',
        metric: 'redirects',
        description: 'PSI redirects audit fails (redirect chains detected)'
      },
      {
        name: 'Server Response Slow',
        metric: 'serverResponseSlow',
        description: 'PSI server-response-time audit fails (TTFB > 600ms)'
      },
      {
        name: 'Render Blocking',
        metric: 'renderBlocking',
        description: 'PSI render-blocking-resources audit fails'
      }
    ],

    // Minimum signals required to trigger agent
    minSignals: 1,  // Any single signal triggers (was: 2)

    // Logic: OR across all signals (any data signal OR any PSI signal)
    logic: 'OR'
  },

  coverage: {
    description: 'Code Coverage Analysis Agent',

    dataSignals: [
      {
        name: 'Unused Bytes',
        metric: 'unusedBytes',
        operator: '>',
        thresholdKey: 'unusedBytes',
        description: 'Amount of unused code exceeds threshold'
      },
      {
        name: 'Unused Ratio',
        metric: 'unusedRatio',
        operator: '>',
        thresholdKey: 'unusedRatio',
        description: 'Percentage of unused code exceeds threshold'
      }
    ],

    psiSignals: [
      {
        name: 'Unused JavaScript',
        metric: 'reduceUnusedJS',
        description: 'PSI unused-javascript audit fails'
      },
      {
        name: 'Render Blocking',
        metric: 'renderBlocking',
        description: 'PSI render-blocking-resources audit fails'
      }
    ],

    minSignals: 1,
    logic: 'OR'
  },

  code: {
    description: 'First-Party Code Analysis Agent',

    dataSignals: [
      {
        name: 'First-Party Bytes',
        metric: 'firstPartyBytes',
        operator: '>',
        thresholdKey: 'firstPartyBytes',
        description: 'First-party code size exceeds threshold'
      },
      {
        name: 'Bundle Count',
        metric: 'bundleCount',
        operator: '>',
        thresholdKey: 'bundleCount',
        description: 'Number of bundles exceeds threshold'
      }
    ],

    psiSignals: [
      {
        name: 'Unused JavaScript',
        metric: 'reduceUnusedJS',
        description: 'PSI unused-javascript audit fails'
      }
    ],

    minSignals: 1,
    logic: 'OR'
  }
};

/**
 * Main AgentGating class
 */
export class AgentGating {
  constructor(deviceType) {
    if (!['mobile', 'desktop'].includes(deviceType)) {
      throw new Error(`Invalid device type: ${deviceType}. Must be 'mobile' or 'desktop'.`);
    }

    this.device = deviceType;
    this.thresholds = UNIFIED_THRESHOLDS[deviceType];
  }

  /**
   * Determine if an agent should run based on signals
   *
   * @param {string} agentType - Agent type ('har', 'coverage', 'code')
   * @param {object} signals - Signal values
   * @param {object} signals.data - Data-based signals (e.g., { entriesCount: 85, transferBytes: 2200000 })
   * @param {object} signals.psi - PSI-based signals (e.g., { redirects: false, serverResponseSlow: false })
   * @returns {object} Decision object with shouldRun, reason, signalsPassed, signalsTotal
   */
  shouldRunAgent(agentType, signals) {
    if (!AGENT_RULES[agentType]) {
      throw new Error(`Unknown agent type: ${agentType}. Must be 'har', 'coverage', or 'code'.`);
    }

    const rules = AGENT_RULES[agentType];
    const results = [];

    // Evaluate data signals
    for (const signal of rules.dataSignals) {
      const result = this.evaluateDataSignal(signal, signals.data || {});
      results.push({
        name: signal.name,
        passed: result.passed,
        reason: result.reason,
        type: 'data'
      });
    }

    // Evaluate PSI signals
    for (const signal of rules.psiSignals) {
      const result = this.evaluatePSISignal(signal, signals.psi || {});
      results.push({
        name: signal.name,
        passed: result.passed,
        reason: result.reason,
        type: 'psi'
      });
    }

    // Count passed signals
    const passedCount = results.filter(r => r.passed).length;
    const shouldRun = passedCount >= rules.minSignals;

    // Generate detailed reason
    const reason = this.explainDecision(agentType, results, rules, passedCount);

    return {
      shouldRun,
      reason,
      signalsPassed: passedCount,
      signalsTotal: results.length,
      signalResults: results,
      agentType,
      device: this.device
    };
  }

  /**
   * Evaluate a data-based signal
   */
  evaluateDataSignal(signal, data) {
    const value = data[signal.metric];

    // Handle missing data
    if (value === undefined || value === null) {
      return {
        passed: false,
        reason: `${signal.name}: No data available`
      };
    }

    const threshold = this.thresholds[signal.thresholdKey];
    let passed = false;

    switch (signal.operator) {
      case '>':
        passed = value > threshold;
        break;
      case '<':
        passed = value < threshold;
        break;
      case '>=':
        passed = value >= threshold;
        break;
      case '<=':
        passed = value <= threshold;
        break;
      case '===':
        passed = value === threshold;
        break;
      default:
        throw new Error(`Unknown operator: ${signal.operator}`);
    }

    // Format value for display
    const displayValue = signal.metric.includes('Bytes')
      ? `${Math.round(value / 1024)}KB`
      : signal.metric.includes('Ratio')
      ? `${Math.round(value * 100)}%`
      : value;

    const displayThreshold = signal.metric.includes('Bytes')
      ? `${Math.round(threshold / 1024)}KB`
      : signal.metric.includes('Ratio')
      ? `${Math.round(threshold * 100)}%`
      : threshold;

    return {
      passed,
      reason: `${signal.name}: ${displayValue} ${signal.operator} ${displayThreshold} = ${passed ? '✅ PASS' : '❌ FAIL'}`
    };
  }

  /**
   * Evaluate a PSI-based signal
   */
  evaluatePSISignal(signal, psi) {
    const value = psi[signal.metric];

    // PSI signals are boolean: true = audit failed (issue detected)
    const passed = value === true;

    return {
      passed,
      reason: `${signal.name}: ${passed ? '✅ PASS (audit fails)' : '❌ FAIL (audit passes)'}`
    };
  }

  /**
   * Generate human-readable decision explanation
   */
  explainDecision(agentType, results, rules, passedCount) {
    const passedSignals = results.filter(r => r.passed).map(r => r.name);
    const status = passedCount >= rules.minSignals ? '✅ WILL RUN' : '❌ SKIPPED';

    let explanation = `${AGENT_RULES[agentType].description}\n`;
    explanation += `  Device: ${this.device}\n`;
    explanation += `  Signals: ${passedCount}/${results.length} passed (need ${rules.minSignals}+)\n`;

    if (passedSignals.length > 0) {
      explanation += `  Passed: ${passedSignals.join(', ')}\n`;
    }

    explanation += `  Decision: ${status}`;

    return explanation;
  }

  /**
   * Get current thresholds for reference
   */
  getThresholds() {
    return { ...this.thresholds };
  }

  /**
   * Get rules for a specific agent
   */
  getAgentRules(agentType) {
    return AGENT_RULES[agentType] ? { ...AGENT_RULES[agentType] } : null;
  }
}

/**
 * Export thresholds and rules for testing/documentation
 */
export { UNIFIED_THRESHOLDS, AGENT_RULES };
