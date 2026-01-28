# CWV Agent Project Context

## Project Overview
This is a Core Web Vitals (CWV) performance analysis agent that uses multi-agent AI systems to analyze web page performance and generate actionable optimization suggestions.

## Architecture Principles
- **Multi-agent system**: Parallel specialized agents (CrUX, PSI, HAR, Coverage, Code, etc.)
- **LangChain-based**: Uses LangChain for LLM orchestration with Gemini 2.5 Pro (default, recommended)
- **Data-driven**: Collects comprehensive performance data before analysis
- **Device-aware**: Separate mobile/desktop analysis with different thresholds
- **Conditional execution**: PSI-gated analysis to avoid expensive operations when not needed

## Recommended Models (January 2026)
- **Primary**: `gemini-2.5-pro` (2M context, native JSON mode, best balance)
- **Fast**: `gemini-2.5-flash` (1M context, faster responses)
- **Reasoning**: `o1` or `o1-mini` (OpenAI reasoning models, slower but deeper analysis)
- **Claude**: `claude-sonnet-4-5-20250929` (via Bedrock, excellent for causal reasoning)

## Key Files & Responsibilities
- `src/core/multi-agents.js`: Multi-agent orchestration, parallel execution
- `src/core/collect.js`: Data collection (CrUX, PSI, HAR, Coverage)
- `src/prompts/analysis.js`: Agent prompt templates (8 specialized agents)
- `src/prompts/shared.js`: Shared prompt components and schema definitions
- `src/tools/`: Data collectors (psi.js, crux.js, har-collector.js, coverage-collector.js)
- `src/models/llm-factory.js`: LLM abstraction (Gemini, OpenAI, Claude support)

## Code Quality Standards

### LangChain Patterns (2025 Best Practices)
- **USE** `withStructuredOutput()` with Zod schemas for guaranteed JSON
- **USE** `bindTools()` for native tool calling (not manual shouldUseTool())
- **USE** few-shot examples in prompts for better agent output
- **AVOID** manual JSON parsing with regex (lines like `.replace(/```json|```/gi, "")`)
- **PREFER** LangGraph StateGraph for stateful workflows (dependency installed)

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
1. **Token limits**: Gemini 2.5 Pro has 2M context, but watch for output limits (8K tokens)
2. **Cache invalidation**: Use `--skip-cache` when testing data collection changes
3. **Device thresholds**: Mobile/desktop have different performance thresholds (see DEFAULT_THRESHOLDS)
4. **PSI gating**: Heavy collectors (HAR, Coverage, Code) only run if PSI shows poor metrics
5. **MCP reviewer**: Interactive workflow in Cursor requires MCP server running

## Environment Variables Required
- `GOOGLE_CRUX_API_KEY`: Chrome UX Report API
- `GOOGLE_PAGESPEED_INSIGHTS_API_KEY`: PageSpeed Insights API
- `GOOGLE_APPLICATION_CREDENTIALS`: Vertex AI auth for Gemini models
- Optional: Azure OpenAI keys for GPT models

## Output Files (in .cache/)
- `*.performance.json`: Raw collected data
- `*.suggestions.*.json`: Agent-generated suggestions
- `*.report.*.summary.md`: Human-readable markdown report
- `*.har`: HTTP Archive files

## Integration Points
- **SpaceCat**: Approved suggestions uploaded to Adobe SpaceCat platform
- **MCP Reviewer**: Cursor IDE integration for interactive suggestion review
- **GitHub Actions**: CI/CD workflow for automated CWV checks
