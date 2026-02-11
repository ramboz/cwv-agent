# CWV Agent: System Architecture Overview

## What is the CWV Agent?

The CWV Agent is an AI-powered Core Web Vitals performance analysis system that uses multiple specialized agents to analyze web page performance and generate actionable, evidence-based optimization suggestions.

## Key Features

- **Multi-Agent System**: 8 specialized agents analyze different aspects of performance
- **Causal Reasoning**: Identifies root causes vs symptoms using causal graph analysis
- **Validation**: Validates findings and blocks low-quality suggestions
- **CMS-Aware**: Tailored recommendations for AEM (CS, AMS, EDS), with practical implementation constraints
- **Evidence-Based**: All suggestions backed by concrete data and code examples
- **Strategic Focus**: Prioritizes root causes with cascading impact analysis

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     DATA COLLECTION                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  CrUX    │  │   PSI    │  │   RUM    │  │  Puppeteer│   │
│  │ (Field)  │  │  (Lab)   │  │ (Field)  │  │   (Lab)   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│       ↓             ↓             ↓              ↓          │
│  ┌────────────────────────────────────────────────────┐    │
│  │  HAR, Coverage, Perf Entries, HTML, Code, Rules   │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                   CONDITIONAL GATING                         │
│  • Always: CrUX, PSI, Perf Observer, HTML, Rules            │
│  • If RUM available: RUM Agent                               │
│  • If poor metrics: HAR, Coverage, Code Review               │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│               MULTI-AGENT ANALYSIS (Parallel)                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  CrUX    │  │   PSI    │  │   RUM    │  │  Perf    │   │
│  │  Agent   │  │  Agent   │  │  Agent   │  │ Observer │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   HTML   │  │  Rules   │  │ Coverage │  │   Code   │   │
│  │  Agent   │  │  Agent   │  │  Agent   │  │  Review  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                                                               │
│  Each agent outputs: findings[] with structured schema      │
│  • Phase 1: Structured output (type, metric, evidence)      │
│  • Phase 2: Chain-of-thought reasoning (4-step)             │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│            QUALITY METRICS COLLECTION (Phase 1)              │
│  • Total findings, average confidence, root cause ratio      │
│  • Pre-validation baseline for comparison                    │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│            CAUSAL GRAPH BUILDER (Phase 3)                    │
│  • Connects findings into dependency graph                   │
│  • Identifies root causes (depth 2+, no incoming edges)      │
│  • Detects relationships: blocks, delays, causes, duplicates │
│  • Finds critical paths: root cause → symptoms → metrics     │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│              VALIDATION AGENT (Phase 4)                      │
│  • Validates evidence quality (file refs, metric values)     │
│  • Validates impact estimates (realistic bounds, cascades)   │
│  • Validates reasoning chains (Phase 2)                      │
│  • Validates root causes (graph depth, concreteness)         │
│  • Blocks/adjusts low-confidence findings                    │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│         POST-VALIDATION QUALITY METRICS (Phase 4)            │
│  • Tracks blocked/adjusted findings                          │
│  • Measures false positive reduction                         │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│          GRAPH-ENHANCED SYNTHESIS (Phase 5)                  │
│  • Extracts root causes from causal graph                    │
│  • Calculates total downstream impact per root cause         │
│  • Orders root causes by impact                              │
│  • Instructs synthesis to:                                   │
│    - Focus on root causes over symptoms                      │
│    - Combine related findings                                │
│    - Show cascading benefits                                 │
│    - Respect graph depth for strategic prioritization        │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                   FINAL OUTPUT                               │
│  • Markdown report (business-friendly)                       │
│  • Structured JSON (automation-ready)                        │
│  • Concrete code examples (AEM-specific, copy-paste ready)  │
│  • Validation report                                         │
│  • Causal graph (DOT export for visualization)              │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Components

### 1. Data Collection (`src/core/collect.js`)

**Purpose**: Gather comprehensive performance data from multiple sources

**Data Sources**:
- **CrUX (Chrome UX Report)**: Real user p75 metrics (LCP, CLS, INP, TTFB)
- **PSI (PageSpeed Insights)**: Lab metrics + Lighthouse audits
- **RUM (Real User Monitoring)**: Helix RUM for granular INP data, interaction patterns
- **HAR (HTTP Archive)**: Network waterfall, resource timing, request/response details
- **Coverage**: Puppeteer JavaScript/CSS coverage (unused code detection)
- **Performance Entries**: Browser performance API (LCP element, CLS sources, long tasks)
- **HTML**: Full rendered DOM structure
- **Code**: First-party JavaScript for code review
- **Rules**: Heuristic-based performance rules

**Conditional Gating**:
- Lightweight collectors always run (CrUX, PSI, HTML, Rules, Perf Observer)
- Heavy collectors (HAR, Coverage, Code) only run if PSI shows poor metrics
- Saves 70% cost on sites that already pass thresholds

### 2. Multi-Agent Analysis (`src/core/multi-agents.js`)

**Purpose**: Parallel specialized analysis of different performance aspects

**Agents** (8 total):
1. **CrUX Agent**: Analyzes real user field data
2. **RUM Agent**: Analyzes real user INP and interaction patterns (if available)
3. **PSI Agent**: Analyzes lab metrics and Lighthouse audits
4. **Perf Observer Agent**: Analyzes browser performance entries (LCP element, CLS sources, long tasks)
5. **HTML Agent**: Analyzes DOM structure, resource hints, critical rendering path
6. **Rules Agent**: Applies heuristic performance rules
7. **Coverage Agent**: Identifies unused JavaScript/CSS
8. **Code Review Agent**: Reviews first-party code patterns

**Agent Output Schema** (Phase 1):
```json
{
  "agentName": "PSI Agent",
  "findings": [
    {
      "id": "psi-lcp-1",
      "type": "bottleneck | waste | opportunity",
      "metric": "LCP | CLS | INP | TBT | ...",
      "description": "Human-readable finding",
      "evidence": {
        "source": "psi | har | coverage | ...",
        "reference": "Specific data point",
        "confidence": 0.85
      },
      "estimatedImpact": {
        "metric": "LCP",
        "reduction": 800,
        "confidence": 0.75,
        "calculation": "Show your work"
      },
      "reasoning": {
        "observation": "What you observed",
        "diagnosis": "Why this is a problem",
        "mechanism": "How it impacts the metric",
        "solution": "Why the fix will work"
      },
      "rootCause": true | false
    }
  ]
}
```

### 3. Causal Graph Builder (`src/core/causal-graph-builder.js`)

**Purpose**: Connect isolated findings into dependency graph

**Data Structures**:
- **Nodes**: Performance issues (bottleneck, waste, opportunity) and metrics
- **Edges**: Relationships (blocks, delays, causes, contributes, depends, duplicates, compounds)
- **Root Causes**: Issues with no incoming edges (fundamental problems)
- **Critical Paths**: Chains from root causes to metrics

**Algorithm**:
1. Create metric nodes (LCP, CLS, INP at depth 0)
2. Convert agent findings to nodes
3. Connect findings to affected metrics
4. Detect relationships between findings (duplicate detection, file relationships, metric cascades)
5. Calculate node depths (BFS from metrics)
6. Identify root causes (depth > 0, no incoming edges)
7. Find critical paths (DFS backwards from metrics)

**Output**:
```json
{
  "nodes": { "finding-id": { ...node } },
  "edges": [ { "from": "cause-id", "to": "effect-id", "relationship": "causes" } ],
  "rootCauses": ["id1", "id2"],
  "criticalPaths": [ ["root", "bottleneck", "metric"] ],
  "summary": { "totalIssues": 31, "rootCauses": 26, "relationships": 41 }
}
```

### 4. Validation System (`src/core/validator.js`)

**Purpose**: Quality assurance for agent findings

**Validation Rules** (`src/models/validation-rules.js`):
- **Evidence Quality**: File references, metric values, concrete data required
- **Impact Estimation**: Realistic bounds (LCP max 2000ms, INP max 500ms, etc.)
- **Reasoning Quality**: All 4 steps present (observation, diagnosis, mechanism, solution)
- **Root Cause Validation**: Graph depth, concreteness, actionable fix

**Validation Actions**:
- **Errors** → **BLOCK** (remove from output)
- **Warnings** → **ADJUST** (modify impact/confidence)
- **No issues** → **APPROVE** (pass through)

**Configuration**:
```javascript
{
  blockingMode: true,   // Block invalid findings (default)
  adjustMode: true,     // Apply adjustments (default)
  strictMode: false,    // Block warnings too (optional)
}
```

### 5. Graph-Enhanced Synthesis (`src/core/multi-agents.js`)

**Purpose**: Prioritize root causes and show cascading impact

**Process**:
1. Extract root causes from causal graph
2. Calculate total downstream impact per root cause (sum of all effects)
3. Sort by impact (highest first)
4. Build enhanced context with root cause prioritization
5. Instruct synthesis to focus on root causes, combine related findings

**Output Enhancement**:
- Fewer suggestions (30-40% reduction via deduplication)
- Root causes prioritized (appear first, marked high priority)
- Cascading impact shown ("fixing A improves B and C")
- Related findings combined into holistic suggestions

---

## File Structure

```
src/
├── core/
│   ├── actions.js              # Entry point for agent action
│   ├── collect.js              # Data collection orchestration
│   ├── multi-agents.js         # Multi-agent system orchestration
│   ├── causal-graph-builder.js # Causal graph construction (Phase 3)
│   └── validator.js            # Validation executor (Phase 4)
├── models/
│   ├── config.js               # Token limits, model configuration
│   ├── llm-factory.js          # LLM abstraction (Gemini, OpenAI, Claude)
│   ├── causal-graph.js         # Causal graph data structures (Phase 3)
│   └── validation-rules.js     # Validation criteria (Phase 4)
├── prompts/
│   ├── action.js               # Final synthesis prompt
│   ├── analysis.js             # Agent prompts (8 agents)
│   ├── shared.js               # Shared schema definitions, output format
│   ├── contexts/
│   │   ├── aemcs.js            # AEM CS context (practical constraints)
│   │   ├── ams.js              # AEM AMS context
│   │   └── eds.js              # AEM EDS context
│   └── initialize.js           # System initialization
├── tools/
│   ├── crux.js                 # Chrome UX Report API
│   ├── psi.js                  # PageSpeed Insights API
│   ├── rum.js                  # Real User Monitoring (Helix RUM)
│   ├── rules.js                # Heuristic performance rules
│   ├── lab/
│   │   ├── har-collector.js    # HTTP Archive collection
│   │   ├── coverage-collector.js # JS/CSS coverage
│   │   ├── performance-collector.js # Performance entries
│   │   └── image-analyzer.js   # Image attribute parsing
│   └── aem.js                  # AEM version detection
└── utils.js                    # Caching, token estimation
```

---

## Key Concepts

### Conditional Gating

**Why**: Avoid expensive operations when not needed (70% cost savings)

**Logic**:
- Always run: CrUX, PSI, Perf Observer, HTML, Rules (lightweight)
- Run HAR if: 2+ signals (high requests, high transfer, redirects, slow TTFB, render blocking)
- Run Coverage if: 2+ signals (reduce unused JS, high TBT, long tasks pre-LCP)
- Run Code Review if: Coverage runs OR (reduce unused JS AND high TBT)

**Thresholds**:
- Mobile: >150 requests, >3MB transfer, >3000ms LCP, >250ms TBT
- Desktop: >180 requests, >3.5MB transfer, >2800ms LCP, >300ms TBT

### Root Cause vs Symptom

**Root Cause**: Fundamental issue (depth 2+, no incoming edges in causal graph)
- Example: "Full library imports instead of targeted imports"

**Symptom**: Observable effect (depth 0-1, has incoming edges)
- Example: "High TBT of 850ms"

**Causal Chain**: Root cause → intermediary → symptom → metric
- Example: "Full imports" → "1147KB unused code" → "400ms blocking" → "850ms TBT"

### Cascading Impact

**Definition**: Fixing one issue improves multiple metrics due to dependencies

**Example**:
- Root cause: Remove 1147KB unused code
- Direct impact: TBT -400ms
- Cascading impact: INP -200ms (TBT improvement reduces interaction delay)
- Total impact: ~600ms across metrics

**Cascade Efficiency Factors** (not 1:1):
- TTFB → FCP: 80%
- FCP → LCP: 60%
- TBT → INP: 50%
- Blocking → LCP: 70%

---

## Configuration

### Environment Variables

Required:
```bash
GOOGLE_CRUX_API_KEY=<CrUX API key>
GOOGLE_PAGESPEED_INSIGHTS_API_KEY=<PSI API key>
GOOGLE_APPLICATION_CREDENTIALS=<path to Vertex AI credentials>
```

Optional:
```bash
AZURE_OPENAI_API_KEY=<Azure OpenAI key>
AZURE_OPENAI_API_DEPLOYMENT_NAME=<deployment name>
AZURE_OPENAI_API_VERSION=<API version>
RUM_DOMAIN_KEY=<Helix RUM domain key>
```

### Model Selection

Default: `gemini-2.5-pro` (2M context, best balance)

Alternatives:
- `gemini-2.5-flash`: Faster, less expensive
- `o1` / `o1-mini`: OpenAI reasoning models
- `claude-sonnet-4-5`: Via Bedrock

### Cache Directory

`.cache/` - All collected data and results cached here:
- `*.performance.json` - Raw collected data
- `*.suggestions.*.json` - Agent-generated suggestions
- `*.report.*.summary.md` - Markdown report
- `*.causal-graph.*.json` - Causal graph (Phase 3)
- `*.validation.*.json` - Validation results (Phase 4)
- `*.quality-metrics.*.json` - Quality metrics (Phase 1, pre/post validation)

---

## Output Files

### 1. Markdown Report (`*.report.*.summary.md`)
- Executive summary
- Prioritized recommendations table
- Detailed technical recommendations
- Implementation roadmap

### 2. Structured JSON (`*.suggestions.*.json`)
- Machine-readable suggestions
- Each suggestion includes: title, description, metric, priority, effort, impact, implementation, codeExample, category
- Validation criteria for verification
- Root cause attribution

### 3. Causal Graph (`*.causal-graph.*.json`)
- Nodes (findings + metrics)
- Edges (relationships)
- Root causes list
- Critical paths
- Can be visualized with Graphviz: `dot -Tpng causal-graph.dot -o graph.png`

### 4. Validation Report (`*.validation-report.*.md`)
- Summary statistics
- Blocked findings with reasons
- Adjusted findings with changes
- Confidence scores

---

## Performance Characteristics

- **Latency**: 60-120s typical (depends on site complexity, conditional gating)
- **Token Usage**: 40-70K tokens (depends on data collected)
- **Cost**: ~$0.10-0.30 per analysis with Gemini 2.5 Pro
- **Parallelization**: Agents run in batches (2-4 per batch, 10s delay between batches)

---

## Integration Points

### SpaceCat
- Approved suggestions can be uploaded to Adobe SpaceCat platform
- Via `--action spacecat` command

### MCP Reviewer
- Interactive suggestion review in Cursor IDE
- Requires MCP server running

### GitHub Actions
- CI/CD workflow for automated CWV checks
- Can fail builds based on thresholds

---

## Quality Metrics

Tracked automatically (Phase 1):
- Total findings
- Findings by type (bottleneck, waste, opportunity)
- Findings by metric (LCP, CLS, INP, etc.)
- Average confidence
- Root cause ratio
- Evidence quality (concrete references, impact estimates)
- Agent execution times

Post-validation (Phase 4):
- Approved/adjusted/blocked counts
- False positive reduction
- Confidence calibration

---

## Known Limitations

1. **HAR Collection Gating**: May not trigger on some sites due to strict conditional gating (requires 2+ signals)
2. **Lab vs Field Data**: INP cannot be measured in lab (Puppeteer), requires RUM or CrUX
3. **CMS Detection**: AEM version detection relies on heuristics (may mis-detect)
4. **Token Limits**: Very large sites may exceed context limits (Gemini 2.5 Pro: 2M input, 8K output)
5. **Cache Invalidation**: Must use `--skip-cache` when data collection logic changes

---

## Success Criteria

| Metric | Target | Status |
|--------|--------|--------|
| Structured outputs | 100% | ✅ Phase 1 |
| Chain-of-thought reasoning | 100% | ✅ Phase 2 |
| Causal relationships | >80% | ✅ Phase 3 |
| Validated findings | 100% | ✅ Phase 4 |
| Root cause focus | >80% | ✅ Phase 5 |
| Code examples | 100% | ✅ Practical improvements |
| False positive reduction | -70% | ⏳ Needs baseline |

---

## Future Enhancements

1. **LLM-Based Validation**: Optional nuanced validation using LLM (currently rule-based)
2. **Interactive Graph Visualization**: D3.js interactive causal graph
3. **Impact Propagation**: Calculate exact cascading impact using efficiency factors
4. **ROI Ranking**: Combine effort + impact for ROI-based prioritization
5. **Historical Tracking**: Track improvements over time, calibrate confidence scores
6. **Multi-Page Analysis**: Analyze site-wide patterns across multiple pages
7. **A/B Testing Integration**: Measure actual vs estimated improvements

---

## Related Documentation

- `.claude/PHASE-2-CHAIN-OF-THOUGHT-SUMMARY.md` - Chain-of-thought reasoning
- `.claude/PHASE-3-CAUSAL-GRAPH-SUMMARY.md` - Causal graph builder
- `.claude/PHASE-4-VALIDATION-SUMMARY.md` - Validation agent
- `.claude/PHASE-5-GRAPH-SYNTHESIS-SUMMARY.md` - Graph-enhanced synthesis
- `.claude/PRACTICAL-RECOMMENDATIONS-IMPROVEMENTS.md` - AEM-specific improvements
- `.claude/PHASES-COMPLETE-SUMMARY.md` - Complete implementation summary
- `ARCHITECTURE.md` - High-level architecture overview
- `CLAUDE.md` - Project context for Claude Code sessions
