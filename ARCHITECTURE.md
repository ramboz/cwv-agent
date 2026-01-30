# CWV Agent Architecture

A multi-agent AI system for Core Web Vitals analysis and optimization suggestions.

## Overview

CWV Agent is a Node.js CLI tool that analyzes web pages for Core Web Vitals (CWV) performance issues and generates actionable optimization suggestions. It combines field data (CrUX, RUM), lab data (PSI, Puppeteer), and LLM-powered analysis to identify root causes and provide concrete fixes.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CWV Agent                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────┐   ┌──────────────────┐   ┌────────────────┐   ┌───────────┐  │
│  │    CLI    │──▶│  Data Collection │──▶│  Multi-Agent   │──▶│  Output   │  │
│  │  (yargs)  │   │     Layer        │   │    Analysis    │   │  Layer    │  │
│  └───────────┘   └──────────────────┘   └────────────────┘   └───────────┘  │
│                            │                    │                  │        │
│                            ▼                    ▼                  ▼        │
│                    ┌──────────────┐     ┌──────────────┐    ┌────────────┐  │
│                    │ .cache/      │     │ LLM Factory  │    │ Markdown   │  │
│                    │ (persistent) │     │ (Gemini/GPT) │    │ + JSON     │  │
│                    └──────────────┘     └──────────────┘    └────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
User Input (URL + Device Type + Options)
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 1: Parallel Data Collection (Always)                      │
│   ├─ CrUX API → Field metrics (p75 LCP, CLS, INP, TTFB)        │
│   ├─ PSI API  → Lab metrics + 100+ Lighthouse audits           │
│   └─ RUM API  → Recent real user data (if domain key provided) │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Early Exit Check                                                 │
│   └─ Skip deep analysis if all CWV pass "good" thresholds       │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 2: Conditional Lab Collection (Gated by PSI signals)      │
│   ├─ HAR (Puppeteer)     → Network waterfall, timing, caching  │
│   ├─ Performance Entries → LCP, CLS, Long Tasks, LoAF          │
│   ├─ Code Coverage       → Unused JS/CSS per segment           │
│   ├─ HTML Structure      → CWV-relevant markup extraction      │
│   ├─ Third-Party Analysis→ Script categorization & impact      │
│   ├─ CLS Attribution     → CSS-to-shift mapping                │
│   └─ First-Party Code    → Source code for review              │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 3: AEM Detection                                          │
│   └─ Detect CMS type: EDS, AEM CS, AMS, or non-AEM             │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 4: Rules Engine (Heuristic Analysis)                      │
│   └─ Apply 18 predefined CWV rules → Findings                  │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 5: Multi-Agent Analysis (Parallel LLM Calls)              │
│   ├─ CrUX Agent        → Field data interpretation             │
│   ├─ RUM Agent         → Real user trend analysis              │
│   ├─ PSI Agent         → Lab audit prioritization              │
│   ├─ HAR Agent         → Network bottleneck detection          │
│   ├─ Coverage Agent    → Unused code identification            │
│   ├─ Code Review Agent → Anti-pattern detection                │
│   ├─ Perf Observer Agent → LCP/CLS/Task attribution            │
│   ├─ HTML Agent        → Markup analysis                       │
│   └─ Rules Agent       → Heuristic finding interpretation      │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 6: Causal Graph Construction                              │
│   ├─ Build dependency graph from agent findings                 │
│   ├─ Identify root causes vs symptoms                          │
│   ├─ Deduplicate cross-agent findings                          │
│   └─ Find critical paths (metric → root cause)                 │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 7: Validation                                             │
│   ├─ Check evidence quality                                     │
│   ├─ Calibrate confidence by source reliability                │
│   ├─ Validate impact estimates                                  │
│   └─ Block/adjust low-quality suggestions                      │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 8: Synthesis (Final LLM Call)                             │
│   ├─ Aggregate validated findings                               │
│   ├─ Generate structured JSON (Zod schema)                     │
│   └─ Format markdown report                                     │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
Output
    ├─ .cache/{url}.{device}.report.{model}.summary.md
    ├─ .cache/{url}.{device}.suggestions.json
    └─ .cache/{url}.{device}.quality-metrics.json
```

## Agent Specialization

| Agent | Data Sources | Responsibility |
|-------|--------------|----------------|
| **CrUX Agent** | Chrome UX Report API | Analyze real user p75 metrics (LCP, CLS, INP, TTFB), identify field vs lab discrepancies |
| **RUM Agent** | Helix RUM Bundler | Analyze recent real user data, identify trends, compare with CrUX |
| **PSI Agent** | PageSpeed Insights API | Lab metrics + prioritize from 100+ Lighthouse audits |
| **HAR Agent** | Puppeteer HAR | Network timing breakdown (DNS/TCP/SSL/Wait), large transfers, caching, Server-Timing |
| **Coverage Agent** | Puppeteer Coverage | Pre-LCP vs post-LCP code usage, unused JS/CSS segments |
| **Code Review Agent** | First-party source | Anti-patterns, blocking resources, async/defer usage |
| **Perf Observer Agent** | Performance entries | LCP element attribution, CLS sources, LoAF (Long Animation Frames) |
| **HTML Agent** | DOM HTML | Resource hints, preload/preconnect, script loading, font strategy |
| **Rules Agent** | Heuristic rules engine | 18 predefined CWV rules with deterministic findings |

## Agent Gating System

Expensive agents (HAR, Coverage, Code) run conditionally based on PSI signals:

```javascript
// Coverage Agent triggers if ANY:
- PSI unused-javascript audit fails
- TBT > threshold (250ms mobile, 300ms desktop)
- LCP > threshold (3000ms mobile, 2800ms desktop)
- Long tasks (>200ms) before LCP

// HAR Agent triggers if ANY:
- Request count > threshold (150 mobile, 180 desktop)
- Transfer size > threshold (3MB mobile, 3.5MB desktop)
- PSI redirects audit fails
- PSI server-response-time audit fails
- PSI render-blocking-resources audit fails

// Code Review Agent triggers if:
- Coverage agent runs AND (unused JS + high TBT)
```

## Causal Graph Builder

Constructs dependency graphs to identify root causes:

```
┌─────────────────────────────────────────────────────────────┐
│ Metric Layer (Observable Symptoms)                          │
│   LCP: 4.2s    CLS: 0.18    INP: 450ms                     │
└─────────────────────────────────────────────────────────────┘
        │              │             │
        ▼              ▼             ▼
┌─────────────────────────────────────────────────────────────┐
│ Finding Layer (Agent Outputs)                               │
│   - Large hero image (2.1MB)     [affects LCP]             │
│   - Missing image dimensions     [affects CLS]             │
│   - Unused JS bundle (480KB)     [affects LCP, INP]        │
│   - Third-party consent script   [affects INP]             │
└─────────────────────────────────────────────────────────────┘
        │              │             │
        ▼              ▼             ▼
┌─────────────────────────────────────────────────────────────┐
│ Root Cause Layer (Actionable Issues)                        │
│   - Image not optimized for web  [root cause]              │
│   - CSS doesn't reserve space    [root cause]              │
│   - No code splitting            [root cause]              │
│   - Consent loaded synchronously [root cause]              │
└─────────────────────────────────────────────────────────────┘
```

### Deduplication

The causal graph deduplicates findings from multiple agents:

```javascript
// Finding type classification
classifyFindingType(finding) → 'lcp-image' | 'unused-code' | 'font-format' | ...

// Merge key generation
getMergeKey(finding) → `${type}:${metric}:${fileName || 'general'}`

// Cross-agent deduplication
'lcp-image:LCP:hero.jpg' from [HAR Agent, HTML Agent, PSI Agent] → 1 finding
```

## Validation System

Validates and adjusts findings before synthesis:

### Evidence Reliability Tiers

| Tier | Sources | Max Confidence | Description |
|------|---------|----------------|-------------|
| Field | CrUX, RUM | 0.95 | Real user measurements |
| Lab | PSI, HAR, PerfEntries, Coverage | 0.80-0.85 | Controlled environment |
| Static | HTML, Rules | 0.75 | Static analysis |
| Speculative | Code Review | 0.65 | Requires human judgment |

### Validation Checks

1. **Evidence Quality**: Reference length, file mentions, metric values
2. **Impact Bounds**: Max realistic improvements (e.g., LCP max 2s improvement)
3. **Cascade Efficiency**: How improvements propagate (e.g., TTFB→FCP: 80%)
4. **Root Cause Verification**: Cross-reference with causal graph

## LLM Integration

### Supported Models

| Provider | Models | Token Limits |
|----------|--------|--------------|
| **Gemini** (Vertex AI) | gemini-2.5-pro, gemini-2.5-flash | 2M input, 8K output |
| **OpenAI** (Azure) | o1, o1-mini, gpt-4o | 128K-200K input, 16K-100K output |
| **Bedrock** (AWS) | claude-opus-4.5, claude-sonnet-4.5 | 200K input, 16K-128K output |

### Structured Output

Uses LangChain's `withStructuredOutput()` with Zod schemas:

```javascript
const suggestionSchema = z.object({
  deviceType: z.enum(['mobile', 'desktop']),
  suggestions: z.array(z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    solution: z.string().min(1),         // Plain language fix explanation
    metric: z.enum(['LCP', 'CLS', 'INP', 'TBT', 'TTFB', 'FCP']).optional(),
    priority: z.enum(['High', 'Medium', 'Low']).optional(),
    effort: z.enum(['Easy', 'Medium', 'Hard']).optional(),
    estimatedImpact: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    evidence: z.array(z.string()).optional(),
    codeChanges: z.array(z.object({
      file: z.string(),
      line: z.number().optional(),
      before: z.string().optional(),
      after: z.string().optional()
    })).optional(),
    validationCriteria: z.array(z.string()).optional()
  }))
});
```

## Rules Engine

18 predefined heuristic rules organized by category:

### CLS Rules
- `cls.js` - Layout shift detection and attribution

### Critical Path Rules
- `kb100.js` - Pre-LCP asset size limits (100KB mobile, 200KB desktop)
- `lcp.js` - LCP element optimization
- `fonts.js` - Font loading sequence
- `size.js` - Resource size limits (JS: 20KB, CSS: 10KB)
- `thirdparty.js` - Third-party impact (>60ms duration)
- `no-extra-media.js` - Unnecessary media detection
- `no-header-footer.js` - Above-fold component loading
- `no-inline-svg.js` - Inline SVG detection
- `images-loading.js` - Image loading optimization
- `redirects.js` - Redirect chain detection

### Main Thread Rules
- `blocking.js` - Render-blocking resource detection
- `loaf.js` - Long Animation Frames (>90ms)
- `tbt.js` - Total Blocking Time analysis

### TTFB Rules
- `http-version.js` - HTTP/2+ detection
- `ttfb.js` - Server response time analysis

### Font Rules
- `fonts.js` - font-display, preload, format optimization

### Config Rules
- `csp.js` - Content Security Policy analysis

## CMS-Specific Contexts

### AEM Edge Delivery Services (EDS)
- Block-based architecture (`.block`, `.section`)
- Lazy loading patterns
- `/scripts/scripts.js` as critical path
- Helix RUM integration

### AEM Cloud Service (CS)
- Sling Model optimization
- Dispatcher caching
- Adobe Target/Launch integration
- CDN configuration (Fastly, Akamai)

### Adobe Managed Services (AMS)
- Dispatcher configuration
- AEM replication
- Legacy component optimization

## CLI Actions

```bash
# Full agent analysis (default)
node index.js --action agent --url https://example.com --device mobile

# Data collection only (no LLM)
node index.js --action collect --url https://example.com

# Rules engine only (deterministic)
node index.js --action rules --url https://example.com

# MCP interactive reviewer
node index.js --action mcp-reviewer
```

### CLI Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--action` | `-a` | Action to perform | `agent` |
| `--url` | `-u` | Single URL to analyze | - |
| `--urls` | - | Path to JSON file with URLs | - |
| `--device` | `-d` | Device type | `mobile` |
| `--skip-cache` | `-s` | Force fresh data collection | `false` |
| `--model` | `-m` | LLM model to use | `gemini-2.5-pro` |
| `--output-suffix` | `-o` | Output file suffix | `''` |
| `--block-requests` | `-b` | Comma-separated URL patterns to block | `''` |
| `--rum-domain-key` | `-r` | RUM domain key for authentication | - |

## MCP Integration

The `mcp-reviewer` action starts a Model Context Protocol server for interactive suggestion review:

```javascript
// Available MCP Tools
- load_cwv_suggestions          // Load from single JSON file
- load_multi_device_suggestions // Merge mobile + desktop
- load_suggestions_by_url       // Auto-discover from cache
- get_suggestions_by_url_and_type // Query SpaceCat API
- create_category_editor        // Edit suggestion categories
- save_category_edits           // Persist changes
- submit_suggestions            // Push to SpaceCat
```

## Caching Strategy

All data is cached in `.cache/` with the naming convention:
```
{normalized-url}.{device}.{data-type}.json
```

| Data Type | Description | Size |
|-----------|-------------|------|
| `crux` | CrUX API response | ~2KB |
| `psi` | PSI API response | ~50-200KB |
| `rum` | RUM data | ~5-20KB |
| `har` | HAR file + summary | ~500KB-5MB |
| `perf` | Performance entries | ~50-200KB |
| `html` | CWV-relevant HTML extract | ~30-100KB |
| `coverage` | Code coverage data | ~100-500KB |
| `third-party` | Third-party analysis | ~5-20KB |
| `cls-attribution` | CLS-to-CSS mapping | ~5-20KB |
| `suggestions` | Final suggestions JSON | ~5-20KB |
| `report.*.summary.md` | Markdown report | ~10-30KB |

## Environment Variables

### Required (per provider)

**Gemini (Google Cloud)**
```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

**OpenAI (Azure)**
```bash
AZURE_OPENAI_API_INSTANCE_NAME=your-instance
AZURE_OPENAI_API_DEPLOYMENT_NAME=your-deployment
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_API_VERSION=2024-02-15-preview
```

**Bedrock (AWS)**
```bash
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_REGION=us-east-1
```

### Optional
```bash
CRUX_API_KEY=your-crux-key           # CrUX API authentication
RUM_DOMAIN_KEY=your-rum-key          # Helix RUM Bundler auth
SKIP_HAR_ANALYSIS=true               # Skip HAR collection
SKIP_COVERAGE_ANALYSIS=true          # Skip coverage collection
SKIP_CODE_ANALYSIS=true              # Skip code review
SKIP_PERFORMANCE_ENTRIES=true        # Skip perf entries
SKIP_FULL_HTML=true                  # Skip HTML extraction
```

## Performance Thresholds

From `src/config/thresholds.js`:

### Core Web Vitals "Good" Thresholds
| Metric | Good | Needs Improvement |
|--------|------|-------------------|
| LCP | ≤2.5s | ≤4.0s |
| CLS | ≤0.1 | ≤0.25 |
| INP | ≤200ms | ≤500ms |
| TBT | ≤200ms | ≤600ms |
| TTFB | ≤800ms | ≤1.8s |
| FCP | ≤1.8s | ≤3.0s |

### Gating Thresholds (Mobile)
| Metric | Threshold |
|--------|-----------|
| LCP | 3000ms |
| TBT | 250ms |
| Requests | 150 |
| Transfer Size | 3MB |
| Unused Bytes | 300KB |
| Unused Ratio | 30% |

## Token Limits & Data Limits

To prevent LLM context overflow:

| Limit | Value |
|-------|-------|
| Max HAR entries | 10,000 |
| Max Perf entries | 10,000 |
| Max Coverage entries | 10,000 |
| Max Large Files displayed | 15 |
| Max Domains displayed | 15 |
| Max HTML length | 10,000 chars |

## Error Handling

1. **LLM Failures**: ModelAdapter provides fallback to secondary model
2. **Data Collection Failures**: Graceful degradation (continue without failed data source)
3. **Validation Failures**: Block or adjust findings; never crash
4. **Cache Misses**: Auto-collect fresh data
5. **API Rate Limits**: Exponential backoff with retry
