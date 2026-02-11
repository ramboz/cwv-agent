# Phase 1: Structured Agent Outputs with Quality Metrics

## Objectives

**Primary Goal:** Enable quantitative quality measurement by ensuring all agents output structured, validated findings with evidence and confidence scores.

**Key Deliverables:**
1. ✅ Standard `AgentFinding` schema for all 8 agents
2. ✅ Updated agent prompts with structured output requirements
3. ✅ Quality metrics tracking system
4. ✅ Baseline metrics establishment for before/after comparison

## Business Value

- **Quantitative Quality Tracking:** Move from qualitative feedback to measurable metrics
- **False Positive Reduction:** Evidence-based findings reduce speculation
- **Foundation for Validation:** Structured data enables Phase 4 validation agent
- **User Trust:** Confidence scores help users prioritize suggestions

## Agent Finding Schema

### Core Schema Definition

```javascript
// src/core/multi-agents.js
const agentFindingSchema = z.object({
  id: z.string(), // Unique ID for cross-referencing (e.g., "psi-lcp-1")
  type: z.enum(['bottleneck', 'waste', 'opportunity']),
  metric: z.enum(['LCP', 'CLS', 'INP', 'TBT', 'TTFB', 'FCP', 'TTI', 'SI']),
  description: z.string().min(10), // Human-readable finding

  // Evidence structure
  evidence: z.object({
    source: z.string(), // 'psi', 'har', 'coverage', 'perfEntries', etc.
    reference: z.string(), // Specific data point (audit name, file:line, etc.)
    confidence: z.number().min(0).max(1) // 0-1 confidence score
  }),

  // Impact estimation
  estimatedImpact: z.object({
    metric: z.string(), // Which metric improves
    reduction: z.number(), // Estimated improvement (ms, score, etc.)
    confidence: z.number().min(0).max(1), // Confidence in estimate
    calculation: z.string().optional() // Show your work
  }),

  // Causal relationships (for Phase 3 graph building)
  relatedFindings: z.array(z.string()).optional(), // IDs of related findings
  rootCause: z.boolean(), // true = root cause, false = symptom

  // Chain-of-thought reasoning (Phase 2)
  reasoning: z.object({
    symptom: z.string(), // What is observed
    rootCauseHypothesis: z.string(), // Why it occurs
    evidenceSupport: z.string(), // How evidence supports hypothesis
    impactRationale: z.string() // Why this impact estimate
  }).optional()
});

const agentOutputSchema = z.object({
  agentName: z.string(),
  findings: z.array(agentFindingSchema),
  metadata: z.object({
    executionTime: z.number(),
    dataSourcesUsed: z.array(z.string()),
    coverageComplete: z.boolean() // Did agent examine all relevant data?
  })
});
```

### Schema Design Rationale

**Why this structure?**

1. **Unique IDs:** Enable cross-referencing between agents (Phase 3 causal graph)
2. **Type classification:** Helps prioritization (bottlenecks > waste > opportunities)
3. **Evidence structure:** Forces concrete references, reduces speculation
4. **Impact estimation:** Quantifies expected improvement
5. **Root cause flag:** Distinguishes symptoms from fundamental issues
6. **Reasoning (optional):** Phase 2 will populate this for better explanations

## Agent-Specific Implementation

### Agent 1: CrUX Agent ✅

**Data Source:** Chrome UX Report API (field data)

**Responsibilities:**
- Analyze real user p75 metrics (LCP, CLS, INP, TTFB)
- Identify metrics failing thresholds
- Compare to device-specific thresholds

**Example Output:**
```json
{
  "agentName": "CrUX Agent",
  "findings": [
    {
      "id": "crux-inp-1",
      "type": "bottleneck",
      "metric": "INP",
      "description": "Real users experience poor Interaction to Next Paint (p75: 520ms)",
      "evidence": {
        "source": "crux",
        "reference": "p75 INP = 520ms, threshold = 200ms (mobile)",
        "confidence": 0.95
      },
      "estimatedImpact": {
        "metric": "INP",
        "reduction": 320,
        "confidence": 0.7,
        "calculation": "Target 200ms threshold - current 520ms = 320ms improvement needed"
      },
      "rootCause": false,
      "relatedFindings": []
    }
  ],
  "metadata": {
    "executionTime": 1200,
    "dataSourcesUsed": ["crux"],
    "coverageComplete": true
  }
}
```

---

### Agent 2: PSI Agent ✅

**Data Source:** PageSpeed Insights API (lab + Lighthouse audits)

**Responsibilities:**
- Analyze lab metrics (LCP, TBT, CLS, FCP, SI, TTI)
- Review 50+ Lighthouse audits (expanded in Phase 0)
- Identify optimization opportunities with wastedMs/wastedBytes

**Example Output:**
```json
{
  "agentName": "PSI Agent",
  "findings": [
    {
      "id": "psi-lcp-1",
      "type": "bottleneck",
      "metric": "LCP",
      "description": "Three render-blocking scripts delay LCP by 850ms",
      "evidence": {
        "source": "psi.audits.render-blocking-resources",
        "reference": "app.js (420ms), analytics.js (280ms), vendor.js (150ms)",
        "confidence": 0.85
      },
      "estimatedImpact": {
        "metric": "LCP",
        "reduction": 650,
        "confidence": 0.75,
        "calculation": "850ms blocking time → ~600-700ms LCP improvement (not 1:1 due to cascading)"
      },
      "rootCause": true,
      "relatedFindings": ["coverage-unused-1"]
    }
  ],
  "metadata": {
    "executionTime": 2500,
    "dataSourcesUsed": ["psi"],
    "coverageComplete": true
  }
}
```

---

### Agent 3: HAR Agent ✅

**Data Source:** HTTP Archive (network waterfall)

**Responsibilities:**
- Analyze network timing (DNS, TCP, SSL, Wait, Download)
- Identify large transfers and request counts
- Detect bottleneck phases (enhanced in Phase 0)

**Example Output:**
```json
{
  "agentName": "HAR Agent",
  "findings": [
    {
      "id": "har-ttfb-1",
      "type": "bottleneck",
      "metric": "TTFB",
      "description": "Server processing time (Wait phase) dominates TTFB at 1100ms",
      "evidence": {
        "source": "har",
        "reference": "Timing breakdown: DNS=10ms, TCP=15ms, SSL=20ms, Wait=1100ms (92% of total), Download=55ms",
        "confidence": 0.9
      },
      "estimatedImpact": {
        "metric": "TTFB",
        "reduction": 900,
        "confidence": 0.8,
        "calculation": "Target 300ms Wait time (industry standard) - current 1100ms = 800-900ms reduction"
      },
      "rootCause": true,
      "relatedFindings": []
    }
  ],
  "metadata": {
    "executionTime": 1800,
    "dataSourcesUsed": ["har"],
    "coverageComplete": true
  }
}
```

---

### Agent 4: Coverage Agent ✅

**Data Source:** Puppeteer coverage data

**Responsibilities:**
- Detect unused JS/CSS (post-LCP vs. pre-LCP)
- Identify code segments to split/lazy-load
- Analyze minified files (included in Phase 0)

**Example Output:**
```json
{
  "agentName": "Coverage Agent",
  "findings": [
    {
      "id": "coverage-unused-1",
      "type": "waste",
      "metric": "TBT",
      "description": "65% of app.bundle.js unused (420KB), with 280KB executing post-LCP",
      "evidence": {
        "source": "coverage.app.bundle.js",
        "reference": "Lodash: 98KB (12% used), Moment.js: 67KB (8% used), Others: 255KB unused",
        "confidence": 0.95
      },
      "estimatedImpact": {
        "metric": "TBT",
        "reduction": 420,
        "confidence": 0.85,
        "calculation": "420KB @ ~1ms/KB parse/compile = 420ms blocking time"
      },
      "rootCause": true,
      "relatedFindings": ["psi-lcp-1", "code-bundle-1"]
    }
  ],
  "metadata": {
    "executionTime": 2200,
    "dataSourcesUsed": ["coverage"],
    "coverageComplete": true
  }
}
```

---

### Agent 5: Code Review Agent ✅

**Data Source:** First-party source code

**Responsibilities:**
- Review imports (full library vs. targeted)
- Identify anti-patterns (blocking scripts, sync operations)
- Suggest modern alternatives

**Example Output:**
```json
{
  "agentName": "Code Review Agent",
  "findings": [
    {
      "id": "code-bundle-1",
      "type": "bottleneck",
      "metric": "TBT",
      "description": "Full library imports instead of tree-shakeable targeted imports",
      "evidence": {
        "source": "code.src/utils.js",
        "reference": "Line 3: import _ from 'lodash'; Line 45: _.debounce(...)",
        "confidence": 0.95
      },
      "estimatedImpact": {
        "metric": "TBT",
        "reduction": 165,
        "confidence": 0.9,
        "calculation": "Tree-shakeable imports reduce bundle by ~165KB (Lodash+Moment)"
      },
      "rootCause": true,
      "relatedFindings": ["coverage-unused-1"]
    }
  ],
  "metadata": {
    "executionTime": 3000,
    "dataSourcesUsed": ["code"],
    "coverageComplete": false
  }
}
```

---

### Agent 6: Performance Observer Agent ✅

**Data Source:** Browser Performance API entries

**Responsibilities:**
- Identify LCP element and attribution
- Analyze CLS sources with enhanced CSS attribution (Phase 0)
- Detect long tasks (LoAF)

**Example Output:**
```json
{
  "agentName": "Performance Observer Agent",
  "findings": [
    {
      "id": "perf-cls-1",
      "type": "bottleneck",
      "metric": "CLS",
      "description": "Hero image causes 0.25 layout shift due to missing dimensions",
      "evidence": {
        "source": "perfEntries.layout-shift",
        "reference": "Element: IMG.hero-image, shift value: 0.25, CSS: width=auto height=auto",
        "confidence": 0.95
      },
      "estimatedImpact": {
        "metric": "CLS",
        "reduction": 0.25,
        "confidence": 0.9,
        "calculation": "Adding width/height prevents this specific shift (0.35 total → 0.10)"
      },
      "rootCause": true,
      "relatedFindings": ["html-img-1"]
    }
  ],
  "metadata": {
    "executionTime": 1500,
    "dataSourcesUsed": ["perfEntries"],
    "coverageComplete": true
  }
}
```

---

### Agent 7: HTML Agent ✅

**Data Source:** Rendered HTML DOM

**Responsibilities:**
- Parse image attributes (loading, fetchpriority, dimensions) - Phase 0
- Detect missing preload hints
- Identify critical path issues

**Example Output:**
```json
{
  "agentName": "HTML Agent",
  "findings": [
    {
      "id": "html-img-1",
      "type": "opportunity",
      "metric": "LCP",
      "description": "LCP image lacks preload hint and fetchpriority=high",
      "evidence": {
        "source": "html.img",
        "reference": "IMG.hero-image: no preload, fetchpriority=auto, loading=eager",
        "confidence": 0.9
      },
      "estimatedImpact": {
        "metric": "LCP",
        "reduction": 200,
        "confidence": 0.7,
        "calculation": "Preload + fetchpriority=high typically saves 150-250ms on LCP images"
      },
      "rootCause": false,
      "relatedFindings": ["perf-cls-1"]
    }
  ],
  "metadata": {
    "executionTime": 1200,
    "dataSourcesUsed": ["html"],
    "coverageComplete": true
  }
}
```

---

### Agent 8: Rules Agent ✅

**Data Source:** Predefined heuristic rules

**Responsibilities:**
- Apply CWV best practices
- Check for common anti-patterns
- Validate against known performance guidelines

**Example Output:**
```json
{
  "agentName": "Rules Agent",
  "findings": [
    {
      "id": "rules-cache-1",
      "type": "opportunity",
      "metric": "TTFB",
      "description": "Static assets lack long-term cache headers",
      "evidence": {
        "source": "rules",
        "reference": "20 static assets with Cache-Control: max-age=3600 (should be ≥31536000)",
        "confidence": 0.85
      },
      "estimatedImpact": {
        "metric": "TTFB",
        "reduction": 50,
        "confidence": 0.6,
        "calculation": "Repeat visits avoid network latency (~50ms avg)"
      },
      "rootCause": false,
      "relatedFindings": []
    }
  ],
  "metadata": {
    "executionTime": 800,
    "dataSourcesUsed": ["rules"],
    "coverageComplete": true
  }
}
```

## Quality Metrics System

### Metrics to Track

```javascript
// src/core/multi-agents.js
interface QualityMetrics {
  runId: string;
  timestamp: string;
  url: string;
  deviceType: string;
  model: string;

  // Suggestion counts
  totalFindings: number;
  findingsByType: { bottleneck: number, waste: number, opportunity: number };
  findingsByMetric: { LCP: number, CLS: number, INP: number, TBT: number, TTFB: number, FCP: number };

  // Evidence quality
  averageConfidence: number;
  withConcreteReference: number; // % with specific data references
  withImpactEstimate: number; // % with quantified impact

  // Root cause analysis
  rootCauseCount: number;
  rootCauseRatio: number; // % marked as root cause vs symptoms

  // Agent performance
  agentExecutionTimes: { [agentName: string]: number };
  totalExecutionTime: number;

  // Coverage completeness
  agentCoverageComplete: { [agentName: string]: boolean };

  // Validation (Phase 4 will populate)
  validationStatus?: {
    passed: boolean;
    issueCount: number;
    blockedCount: number;
  };
}
```

### Metrics Collection

```javascript
// After agent execution, before synthesis
function collectQualityMetrics(agentOutputs, pageUrl, deviceType, model) {
  const allFindings = agentOutputs.flatMap(a => a.findings);

  const metrics = {
    runId: generateRunId(),
    timestamp: new Date().toISOString(),
    url: pageUrl,
    deviceType,
    model,

    totalFindings: allFindings.length,
    findingsByType: {
      bottleneck: allFindings.filter(f => f.type === 'bottleneck').length,
      waste: allFindings.filter(f => f.type === 'waste').length,
      opportunity: allFindings.filter(f => f.type === 'opportunity').length
    },
    findingsByMetric: {
      LCP: allFindings.filter(f => f.metric === 'LCP').length,
      CLS: allFindings.filter(f => f.metric === 'CLS').length,
      INP: allFindings.filter(f => f.metric === 'INP').length,
      TBT: allFindings.filter(f => f.metric === 'TBT').length,
      TTFB: allFindings.filter(f => f.metric === 'TTFB').length,
      FCP: allFindings.filter(f => f.metric === 'FCP').length
    },

    averageConfidence: allFindings.reduce((sum, f) => sum + f.evidence.confidence, 0) / allFindings.length,
    withConcreteReference: allFindings.filter(f => f.evidence.reference.length > 10).length / allFindings.length,
    withImpactEstimate: allFindings.filter(f => f.estimatedImpact?.reduction > 0).length / allFindings.length,

    rootCauseCount: allFindings.filter(f => f.rootCause).length,
    rootCauseRatio: allFindings.filter(f => f.rootCause).length / allFindings.length,

    agentExecutionTimes: Object.fromEntries(
      agentOutputs.map(a => [a.agentName, a.metadata.executionTime])
    ),
    totalExecutionTime: agentOutputs.reduce((sum, a) => sum + a.metadata.executionTime, 0),

    agentCoverageComplete: Object.fromEntries(
      agentOutputs.map(a => [a.agentName, a.metadata.coverageComplete])
    )
  };

  // Save metrics alongside suggestions
  cacheResults(pageUrl, deviceType, 'quality-metrics', metrics, '', model);

  return metrics;
}
```

### Baseline Establishment

Run on 10 test URLs before Phase 1 → Run same 10 URLs after Phase 1 → Compare

**Key Metrics to Compare:**
- False positive rate (requires manual evaluation)
- Average confidence score
- % with concrete evidence
- Root cause identification accuracy

## Implementation Plan

### Step 1: Define Schemas (Day 1) ✅

**Files:**
- `src/core/multi-agents.js` - Add `agentFindingSchema`, `agentOutputSchema`, `qualityMetricsSchema`

### Step 2: Update Agent Prompts (Days 2-5) ✅

**For each of 8 agents:**
1. Add structured output requirements
2. Show example JSON output
3. Emphasize evidence + confidence + impact estimation

**Files:**
- `src/prompts/analysis.js` - Update all 8 agent prompt functions

### Step 3: Implement Quality Metrics (Day 6) ✅

**Files:**
- `src/core/multi-agents.js` - Add `collectQualityMetrics()` function
- Integrate into `runMultiAgents()` after agent execution

### Step 4: Use withStructuredOutput() (Day 7) ✅

**Files:**
- `src/core/multi-agents.js` - Replace manual JSON parsing with `withStructuredOutput()`

### Step 5: Testing & Baseline (Days 8-10) ✅

**Tasks:**
- Run on 10 test URLs
- Collect baseline metrics
- Validate schema compliance
- Compare with Phase 0 outputs

## Success Criteria

- [x] All 8 agents output structured findings matching schema
- [x] Quality metrics collected and saved for every run
- [x] Baseline metrics established (before/after comparison available)
- [x] Schema validation passes 100% of time (or fails gracefully)
- [x] No breaking changes to existing MCP reviewer workflow
- [x] Documentation updated with new schema

## Risks & Mitigation

**Risk:** Agent outputs don't match schema initially
**Mitigation:** Use warnings-only validation (like Phase 0.5), iterate on prompts

**Risk:** withStructuredOutput() fails or is too strict
**Mitigation:** Keep fallback to manual JSON parsing, log failures

**Risk:** Quality metrics slow down execution
**Mitigation:** Metrics collection is post-processing, adds <100ms

## Next Steps After Phase 1

**Phase 2:** Chain-of-thought reasoning prompts (populate `reasoning` field)
**Phase 3:** Causal graph builder (use `relatedFindings` and `rootCause`)
**Phase 4:** Validation agent (block invalid findings, improve quality metrics)

---

**Phase 1 Status:** Ready to implement
**Estimated Completion:** 1.5 weeks (10 working days)
