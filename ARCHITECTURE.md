# CWV Agent Architecture

## Data Flow

```
User Input (URL + Device)
    ↓
Conditional Data Collection
    ├─ Always: CrUX + PSI
    ├─ If PSI shows issues: HAR + Coverage + Code
    └─ Cache results (.cache/)
    ↓
Multi-Agent Analysis (Parallel)
    ├─ CrUX Agent: Real user metrics analysis
    ├─ PSI Agent: Lab metrics + audit findings
    ├─ HAR Agent: Network waterfall + resource timing
    ├─ Coverage Agent: Unused code detection
    ├─ Code Agent: First-party code review
    ├─ Perf Observer Agent: Browser performance entries
    ├─ HTML Agent: DOM structure analysis
    └─ Rules Agent: Apply predefined heuristic rules
    ↓
Synthesis
    ├─ Aggregate findings from all agents
    ├─ Extract structured JSON (suggestions schema)
    └─ Generate markdown report
    ↓
Output
    ├─ Markdown report (.md)
    ├─ JSON suggestions (.suggestions.json)
    └─ Interactive MCP reviewer (optional)
```

## Agent Specialization

| Agent | Data Sources | Responsibility |
|-------|--------------|----------------|
| CrUX Agent | Chrome UX Report API | Analyze real user p75 metrics (LCP, CLS, INP, TTFB) |
| PSI Agent | PageSpeed Insights API | Lab metrics + Lighthouse audits (20 prioritized) |
| HAR Agent | Puppeteer HAR | Network timing, large transfers, request counts |
| Coverage Agent | Puppeteer coverage | Unused JS/CSS detection, segment analysis |
| Code Agent | First-party source | Code review (imports, patterns, anti-patterns) |
| Perf Observer Agent | Performance entries | LCP element, CLS sources, long tasks (LoAF) |
| HTML Agent | DOM HTML | HTML structure, preload hints, critical path |
| Rules Agent | Heuristic rules | Apply predefined CWV best practices |

## Current Limitations (Phase 0 Will Fix)

### Data Loss Issues
- PSI: Only 20/100+ audits checked → 80% coverage loss
- HAR: "Top 5" filtering hides 6th+ large files
- Coverage: Minified files excluded, segments truncated
- No HAR timing breakdown (DNS/TCP/SSL/Wait)

### Missing Data
- INP: CrUX has it, not exposed; RUM would be better
- Image attributes: No loading/fetchpriority/preload parsing
- CSS-CLS attribution: Can't identify which CSS caused shift
- Server headers: No Cache-Control/Server-Timing extraction

### Architectural Gaps
- No causal graph (agents work in isolation)
- No validation (impact estimates unchecked)
- Manual tool calling (should use bindTools())
- No few-shot examples in prompts

## Planned Enhancements (This Implementation Plan)

**Phase 0:** Fix data collection (stop loss, collect missing data)
**Phase 0.5:** Modernize LangChain patterns
**Phase 1:** Structured agent outputs + quality metrics
**Phase 2:** Chain-of-thought reasoning prompts
**Phase 3:** Causal graph builder agent
**Phase 4:** Validation agent with blocking mode
**Phase 5:** Graph-enhanced synthesis
