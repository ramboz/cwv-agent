# Unified Gating Module - Implementation Code

**Complete implementation for `src/core/gating.js`**

---

## Full Module Code

```javascript
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
 *
 * Usage:
 *   const gating = new AgentGating('mobile');
 *   const decision = gating.shouldRunAgent('har', { data: {...}, psi: {...} });
 *   if (decision.shouldRun) { ... }
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
   * Generate detailed debug output for logging
   */
  getDebugOutput(agentType, signals) {
    const decision = this.shouldRunAgent(agentType, signals);

    let output = `\n📊 ${AGENT_RULES[agentType].description} Gating Analysis:\n`;
    output += `  Device: ${this.device}\n\n`;

    // Show each signal result
    decision.signalResults.forEach((result, index) => {
      output += `  Signal ${index + 1} - ${result.reason}\n`;
    });

    output += `\n  Signals Passed: ${decision.signalsPassed}/${decision.signalsTotal} (need ${AGENT_RULES[agentType].minSignals}+)\n`;
    output += `  Agent: ${decision.shouldRun ? '✅ WILL RUN' : '❌ SKIPPED'}\n`;

    return output;
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
```

---

## Usage Examples

### Example 1: HAR Agent Decision (Typical Site)

```javascript
import { AgentGating } from './gating.js';

const gating = new AgentGating('mobile');

const harDecision = gating.shouldRunAgent('har', {
  data: {
    entriesCount: 85,      // 85 requests
    transferBytes: 2_200_000  // 2.2 MB
  },
  psi: {
    redirects: false,      // No redirects
    serverResponseSlow: false,  // Fast server
    renderBlocking: false  // No blocking resources
  }
});

console.log(harDecision.shouldRun);  // true
console.log(harDecision.signalsPassed);  // 2 (entriesCount + transferBytes)
console.log(harDecision.reason);
// Output:
// HAR Network Analysis Agent
//   Device: mobile
//   Signals: 2/5 passed (need 1+)
//   Passed: Request Count, Transfer Size
//   Decision: ✅ WILL RUN
```

### Example 2: Coverage Agent Decision

```javascript
const coverageDecision = gating.shouldRunAgent('coverage', {
  data: {
    unusedBytes: 450_000,   // 450 KB unused
    unusedRatio: 0.38       // 38% unused
  },
  psi: {
    reduceUnusedJS: true,   // PSI audit fails
    renderBlocking: false
  }
});

console.log(coverageDecision.shouldRun);  // true
console.log(coverageDecision.signalsPassed);  // 3 (all data + 1 PSI)
```

### Example 3: Debug Output

```javascript
const debugOutput = gating.getDebugOutput('har', {
  data: { entriesCount: 85, transferBytes: 2_200_000 },
  psi: { redirects: false, serverResponseSlow: false, renderBlocking: false }
});

console.log(debugOutput);
// Output:
// 📊 HAR Network Analysis Agent Gating Analysis:
//   Device: mobile
//
//   Signal 1 - Request Count: 85 > 60 = ✅ PASS
//   Signal 2 - Transfer Size: 2148KB > 1464KB = ✅ PASS
//   Signal 3 - Redirects: ❌ FAIL (audit passes)
//   Signal 4 - Server Response Slow: ❌ FAIL (audit passes)
//   Signal 5 - Render Blocking: ❌ FAIL (audit passes)
//
//   Signals Passed: 2/5 (need 1+)
//   Agent: ✅ WILL RUN
```

---

## Integration with Existing Code

### Replace in `src/core/multi-agents.js`

**Lines 643-715 (Late gate logic)**:

```javascript
// BEFORE (delete this):
const TH = DEFAULT_THRESHOLDS[device];
const harSignals = [
    harStats.entriesCount > TH.REQUESTS,
    harStats.transferBytes > TH.TRANSFER_BYTES,
    signals.redirects,
    signals.serverResponseSlow,
    signals.renderBlocking,
];
const shouldRunHar = harSignals.filter(Boolean).length >= 2;

// ... similar for coverage and code ...

// AFTER (replace with this):
import { AgentGating } from './gating.js';

const gating = new AgentGating(pageData.device);

// HAR Agent
const harDecision = gating.shouldRunAgent('har', {
  data: {
    entriesCount: pageData.labData?.harStats?.entriesCount || 0,
    transferBytes: pageData.labData?.harStats?.transferBytes || 0
  },
  psi: {
    redirects: signals.redirects,
    serverResponseSlow: signals.serverResponseSlow,
    renderBlocking: signals.renderBlocking
  }
});

console.log(gating.getDebugOutput('har', ...));  // Debug logging

if (harDecision.shouldRun && pageData.labData?.harData) {
  agents.push({
    name: 'HAR Agent',
    role: 'Network Performance Analyst',
    systemPrompt: agentPrompts.har,
    humanPrompt: pageData.labData.harData,
    globalSystemPrompt,
    llm,
    tools: []
  });
}

// Coverage Agent
const coverageDecision = gating.shouldRunAgent('coverage', {
  data: {
    unusedBytes: pageData.labData?.coverageData?.summary?.unusedBytes || 0,
    unusedRatio: (pageData.labData?.coverageData?.summary?.unusedPercent || 0) / 100
  },
  psi: {
    reduceUnusedJS: signals.reduceUnusedJS,
    renderBlocking: signals.renderBlocking
  }
});

console.log(gating.getDebugOutput('coverage', ...));

if (coverageDecision.shouldRun && pageData.labData?.coverageData) {
  agents.push({ /* ... */ });
}

// Code Agent (no longer depends on coverage)
const codeDecision = gating.shouldRunAgent('code', {
  data: {
    firstPartyBytes: pageData.labData?.codeData?.summary?.firstPartyBytes || 0,
    bundleCount: pageData.labData?.codeData?.summary?.bundleCount || 0
  },
  psi: {
    reduceUnusedJS: signals.reduceUnusedJS
  }
});

console.log(gating.getDebugOutput('code', ...));

if (codeDecision.shouldRun && pageData.labData?.codeData) {
  agents.push({ /* ... */ });
}
```

---

## Unit Tests

```javascript
// tests/gating.test.js

import { AgentGating, UNIFIED_THRESHOLDS, AGENT_RULES } from '../src/core/gating.js';

describe('AgentGating', () => {
  let gating;

  beforeEach(() => {
    gating = new AgentGating('mobile');
  });

  describe('HAR Agent', () => {
    test('should run when request count exceeds threshold', () => {
      const decision = gating.shouldRunAgent('har', {
        data: { entriesCount: 70, transferBytes: 1_000_000 },
        psi: { redirects: false, serverResponseSlow: false, renderBlocking: false }
      });

      expect(decision.shouldRun).toBe(true);
      expect(decision.signalsPassed).toBe(1);
    });

    test('should run when transfer size exceeds threshold', () => {
      const decision = gating.shouldRunAgent('har', {
        data: { entriesCount: 50, transferBytes: 2_000_000 },
        psi: { redirects: false, serverResponseSlow: false, renderBlocking: false }
      });

      expect(decision.shouldRun).toBe(true);
      expect(decision.signalsPassed).toBe(1);
    });

    test('should run when PSI audit fails', () => {
      const decision = gating.shouldRunAgent('har', {
        data: { entriesCount: 40, transferBytes: 1_000_000 },
        psi: { redirects: true, serverResponseSlow: false, renderBlocking: false }
      });

      expect(decision.shouldRun).toBe(true);
      expect(decision.signalsPassed).toBe(1);
    });

    test('should not run when all signals fail', () => {
      const decision = gating.shouldRunAgent('har', {
        data: { entriesCount: 30, transferBytes: 500_000 },
        psi: { redirects: false, serverResponseSlow: false, renderBlocking: false }
      });

      expect(decision.shouldRun).toBe(false);
      expect(decision.signalsPassed).toBe(0);
    });
  });

  describe('Coverage Agent', () => {
    test('should run when unused bytes exceeds threshold', () => {
      const decision = gating.shouldRunAgent('coverage', {
        data: { unusedBytes: 400_000, unusedRatio: 0.20 },
        psi: { reduceUnusedJS: false, renderBlocking: false }
      });

      expect(decision.shouldRun).toBe(true);
    });

    test('should run when unused ratio exceeds threshold', () => {
      const decision = gating.shouldRunAgent('coverage', {
        data: { unusedBytes: 200_000, unusedRatio: 0.40 },
        psi: { reduceUnusedJS: false, renderBlocking: false }
      });

      expect(decision.shouldRun).toBe(true);
    });
  });

  describe('Code Agent', () => {
    test('should run independently of coverage', () => {
      const decision = gating.shouldRunAgent('code', {
        data: { firstPartyBytes: 600_000, bundleCount: 2 },
        psi: { reduceUnusedJS: false }
      });

      expect(decision.shouldRun).toBe(true);
    });
  });

  describe('Device Awareness', () => {
    test('should use correct thresholds for mobile', () => {
      const mobileGating = new AgentGating('mobile');
      expect(mobileGating.getThresholds().requests).toBe(60);
    });

    test('should use correct thresholds for desktop', () => {
      const desktopGating = new AgentGating('desktop');
      expect(desktopGating.getThresholds().requests).toBe(80);
    });
  });
});
```

---

## Configuration Options

### Override Thresholds

If you need to adjust thresholds without changing the code:

```javascript
// Optional: Custom thresholds
import { AgentGating, UNIFIED_THRESHOLDS } from './gating.js';

// Modify thresholds for testing
UNIFIED_THRESHOLDS.mobile.requests = 50;  // Lower for testing

const gating = new AgentGating('mobile');
// Will use modified threshold
```

### Environment Variable Support

```javascript
// Enhanced constructor with env var support
export class AgentGating {
  constructor(deviceType) {
    this.device = deviceType;

    // Allow environment variable overrides
    this.thresholds = {
      ...UNIFIED_THRESHOLDS[deviceType],
      requests: parseInt(process.env.GATING_REQUESTS) || UNIFIED_THRESHOLDS[deviceType].requests,
      transferBytes: parseInt(process.env.GATING_TRANSFER_BYTES) || UNIFIED_THRESHOLDS[deviceType].transferBytes,
      // ... etc
    };
  }
}

// Usage:
// GATING_REQUESTS=80 node index.js --url ...
```

---

## Next Steps

1. **Create the file**: Copy code above to `src/core/gating.js`
2. **Run tests**: Verify logic works as expected
3. **Integrate**: Replace old gates in multi-agents.js
4. **Test with URLs**: Verify agents trigger correctly
5. **Adjust thresholds**: Fine-tune based on real-world results
