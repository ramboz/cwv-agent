# CWV Agent Project Context

## Project Overview
This is a Core Web Vitals (CWV) performance analysis agent that uses multi-agent AI systems to analyze web page performance and generate actionable optimization suggestions.

## Architecture Principles
- **Multi-agent system**: Parallel specialized agents (CrUX, PSI, HAR, Coverage, Code, HTML, Perf Observer, Rules, RUM)
- **LangChain v1.0**: Uses LangChain v1.0 for LLM orchestration with Gemini 2.5 Pro (default, recommended)
- **Data-driven**: Collects comprehensive performance data before analysis
- **Device-aware**: Separate mobile/desktop analysis with different thresholds
- **Conditional execution**: PSI-gated analysis to avoid expensive operations when not needed
- **Causal analysis**: Deduplicates findings, identifies root causes vs symptoms

## Recommended Models (February 2026)
- **Primary**: `gemini-2.5-pro` (2M context, native JSON mode, best balance)
- **Fast**: `gemini-2.5-flash` (1M context, faster responses)
- **Reasoning**: `o1` or `o1-mini` (OpenAI reasoning models, slower but deeper analysis)
- **Claude**: `claude-sonnet-4-5-20250929` (via Bedrock, excellent for causal reasoning)

## Key Files & Responsibilities

### Core Orchestration
- `src/core/multi-agents.js`: Barrel exports for the multi-agent system
- `src/core/multi-agents/orchestrator.js`: Main orchestration flow (runAgentFlow), signal extraction, conditional gating
- `src/core/multi-agents/suggestions-engine.js`: Multi-agent execution, synthesis, final suggestion generation
- `src/core/multi-agents/schemas.js`: Zod schemas for structured LLM outputs (suggestionSchema, agentFindingSchema)
- `src/core/multi-agents/agent-system.js`: Tool, Agent, and MultiAgentSystem classes

### Analysis & Validation
- `src/core/causal-graph-builder.js`: Deduplication, root cause identification, critical path analysis
- `src/core/validator.js`: Evidence quality checks, confidence calibration, impact validation
- `src/core/gating.js`: Conditional agent/collector gating based on PSI signals

### Data Collection
- `src/core/collect.js`: Orchestrates data collection (CrUX, PSI, HAR, Coverage, etc.)
- `src/tools/crux.js`: Chrome UX Report API client
- `src/tools/psi.js`: PageSpeed Insights API client
- `src/tools/rum.js`: RUM Bundler client
- `src/tools/lab/har-collector.js`: Puppeteer HAR collection
- `src/tools/lab/coverage-collector.js`: Code coverage collection
- `src/tools/lab/performance-collector.js`: Performance entries (LCP, CLS, LoAF)
- `src/tools/lab/html-extractor.js`: CWV-relevant HTML extraction
- `src/tools/lab/third-party-attributor.js`: Third-party script analysis

### Prompts & Context
- `src/prompts/analysis.js`: Agent prompt templates (9 specialized agents)
- `src/prompts/shared.js`: Shared prompt components and formatting
- `src/prompts/contexts/`: CMS-specific contexts (eds.js, aemcs.js, ams.js)

### MCP & Integration
- `src/core/mcp-reviewer.js`: MCP server for Cursor IDE integration
- `src/core/suggestion-manager.js`: Suggestion state management
- `src/core/spacecat-client.js`: SpaceCat API client for uploads

### Models
- `src/models/llm-factory.js`: LLM abstraction (Gemini, OpenAI, Claude support)

## Code Quality Standards

### LangChain v1.0 Patterns (February 2026)
- **USE** `withStructuredOutput()` with Zod schemas for guaranteed JSON
  - **CRITICAL**: Use `method: 'jsonSchema'` (camelCase), NOT `'json_schema'` (v0.3 syntax)
  - Valid methods: `'jsonSchema'` or `'functionCalling'`
- **USE** `bindTools()` for native tool calling (not manual shouldUseTool())
- **USE** few-shot examples in prompts for better agent output
- **AVOID** manual JSON parsing with regex (lines like `.replace(/```json|```/gi, "")`)
- **AVOID** shared Zod constants across schemas (Gemini doesn't support $ref in JSON Schema)
- **AVOID** union types in schemas (z.union, z.discriminatedUnion) - Gemini v1.0 rejects anyOf/oneOf
  - Use arrays instead: `z.array(z.enum([...]))` not `z.union([z.enum([...]), z.array(...)])`

### Performance Data Handling
- **NEVER** truncate data arbitrarily (no "top 5" filtering without justification)
- **ALWAYS** preserve timing breakdowns (DNS, TCP, SSL, Wait, Download in HAR)
- **INCLUDE** minified files in coverage analysis (they're production code)
- **EXPOSE** all collected metrics to agents (don't hide CrUX INP data)
- **VALIDATE** impact estimates sum correctly (timing consistency checks)

### Agent Design Principles
- **Root cause over symptoms**: Agents should identify WHY issues occur, not just THAT they occur
- **Evidence-based**: All findings require concrete data references (file:line, audit name, timing values)
- **Confidence scoring**: All estimates include confidence levels (0-1)
- **Causal attribution**: Distinguish root causes from symptoms, mark explicitly
- **Structured output**: All agents return consistent schema (type, metric, evidence, estimatedImpact)

### Testing & Verification
- **Test on real sites**: Use www.qualcomm.com, www.adobe.com as reference sites
- **Validate schemas**: Ensure JSON outputs match Zod schemas 100%
- **Check data completeness**: Verify no "top N" truncation in outputs
- **Measure quality**: Track false positive rate, confidence calibration

## Common Gotchas
1. **Token limits**: Gemini 2.5 Pro has 2M input, 16K output tokens (increased from 8K for v1.0)
   - Synthesis needs ~4000-5000 tokens for 5-7 detailed suggestions with codeChanges
   - If hitting limits, the fallback strategy is to reduce suggestions (drop lowest confidence)
2. **Cache invalidation**: Use `--skip-cache` when testing data collection changes
3. **Device thresholds**: Mobile/desktop have different performance thresholds (see DEFAULT_THRESHOLDS)
4. **PSI gating**: Heavy collectors (HAR, Coverage, Code) only run if PSI shows poor metrics
5. **MCP reviewer**: Interactive workflow in Cursor requires MCP server running
6. **Zod schemas**: Don't use shared enum constants - inline them to avoid $ref in JSON Schema

## Environment Variables Required
- `GOOGLE_CRUX_API_KEY`: Chrome UX Report API
- `GOOGLE_PAGESPEED_INSIGHTS_API_KEY`: PageSpeed Insights API
- `GOOGLE_APPLICATION_CREDENTIALS`: Vertex AI auth for Gemini models
- Optional: Azure OpenAI keys for GPT models
- Optional: AWS credentials for Bedrock (Claude models)

## Output Files (in .cache/)
- `*.crux.json`: CrUX API field data
- `*.psi.json`: PageSpeed Insights lab data
- `*.rum.json`: RUM metrics (if domain key provided)
- `*.har.json`: HTTP Archive + summary
- `*.perf.json`: Performance entries (LCP, CLS, LoAF, Long Tasks)
- `*.html.json`: CWV-relevant HTML extract
- `*.coverage.json`: Code coverage data
- `*.third-party.json`: Third-party script analysis
- `*.cls-attribution.json`: CLS-to-CSS mapping
- `*.suggestions.json`: Final structured suggestions
- `*.report.*.summary.md`: Human-readable markdown report
- `*.quality-metrics.json`: Analysis quality metrics

## Integration Points
- **SpaceCat**: Approved suggestions uploaded to Adobe SpaceCat platform
- **MCP Reviewer**: Cursor IDE integration for interactive suggestion review
- **GitHub Actions**: CI/CD workflow for automated CWV checks
