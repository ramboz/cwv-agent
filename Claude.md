# CWV Agent: Documentation Index

**Navigation guide for engineers working with the CWV Agent project.**

---

## Quick Start

**New Contributors** - Read these docs in order:

1. [Executive Summary](.claude/executive-summary.md) - **Start here** for high-level overview
2. [Architecture](.claude/architecture.md) - Core system design (after creating from SYSTEM-OVERVIEW.md)
3. [ARCHITECTURE-TODO](.claude/ARCHITECTURE-TODO.md) - Open decisions & what needs work
4. [Implementation Plan](.claude/implementation-plan.md) - Current status & phases

---

## Core Architecture

| Document | Purpose |
|----------|---------|
| [architecture.md](.claude/architecture.md) | Core architecture reference (multi-agent system, data flow, services) |
| [ARCHITECTURE-TODO.md](.claude/ARCHITECTURE-TODO.md) | Open decisions, deferred work, what needs attention |
| [implementation-plan.md](.claude/implementation-plan.md) | Phase completion status, roadmap, metrics |
| [executive-summary.md](.claude/executive-summary.md) | High-level "what and why" for quick orientation |

---

## Design Decisions (Status: Implemented)

| Document | Description | Date |
|----------|-------------|------|
| [design-signal-extractor.md](.claude/design-signal-extractor.md) | Signal extraction service (PSI, HAR, performance) | 2026-01-XX |
| [design-collector-factory.md](.claude/design-collector-factory.md) | Collector DI pattern (factory + adapters) | 2026-02-XX |
| [design-prompt-templates.md](.claude/design-prompt-templates.md) | Shared prompt templates (68% token reduction) | 2026-01-XX |
| [design-conditional-gating.md](.claude/design-conditional-gating.md) | PSI-gated collection (unified gating module) | 2025-XX-XX |
| [design-json-schema.md](.claude/design-json-schema.md) | LangChain v1.0 schemas (JSON-first architecture) | 2026-01-28 |
| [design-validation-rules.md](.claude/design-validation-rules.md) | Evidence quality checks (3-tier validation) | 2026-01-29 |
| [design-spacecat-integration.md](.claude/design-spacecat-integration.md) | Adobe SpaceCat upload (format mapping) | 2026-01-28 |

---

## Research & Analysis

| Document | Description | Type |
|----------|-------------|------|
| [research-quality-metrics.md](.claude/research-quality-metrics.md) | Analysis quality tracking (validation metrics) | Research |
| [research-token-optimization.md](.claude/research-token-optimization.md) | Token reduction strategies (data collection) | Research |
| [research-error-patterns.md](.claude/research-error-patterns.md) | Error handling patterns (dead code analysis) | Research |
| [research-code-filtering.md](.claude/research-code-filtering.md) | Code resource filtering (optimization opportunities) | Research |

---

## Reference Guides

| Document | Purpose |
|----------|---------|
| [user-guide.md](.claude/user-guide.md) | How to use CWV Agent (CLI, options, workflows) |
| [context-testing.md](.claude/context-testing.md) | Testing patterns & best practices |
| [context-css-optimization.md](.claude/context-css-optimization.md) | CSS loading best practices reference |
| [collaboration-guide.md](.claude/collaboration-guide.md) | Spec-Driven Development model (SDD) |

---

## Code & Configuration

### Key Source Files

**Core Orchestration:**
- `src/core/multi-agents.js` - Barrel exports for multi-agent system
- `src/core/multi-agents/orchestrator.js` - Main orchestration flow (runAgentFlow)
- `src/core/multi-agents/suggestions-engine.js` - Multi-agent execution, synthesis
- `src/core/multi-agents/agent-system.js` - Tool, Agent, MultiAgentSystem classes
- `src/core/multi-agents/schemas.js` - Zod schemas for structured outputs

**Analysis & Validation:**
- `src/core/causal-graph-builder.js` - Deduplication, root cause identification
- `src/core/validator.js` - Evidence quality checks, confidence calibration
- `src/core/gating.js` - Conditional agent/collector gating

**Data Collection:**
- `src/core/collect.js` - Orchestrates data collection
- `src/tools/crux.js` - Chrome UX Report API client
- `src/tools/psi.js` - PageSpeed Insights API client
- `src/tools/lab/har-collector.js` - Puppeteer HAR collection
- `src/tools/lab/coverage-collector.js` - Code coverage collection
- `src/tools/lab/performance-collector.js` - Performance entries

**Factories & Services:**
- `src/core/factories/collector-factory.js` - Collector DI factory
- `src/core/services/signal-extractor.js` - Signal extraction service

**Prompts:**
- `src/prompts/analysis.js` - Agent prompt templates (9 specialized agents)
- `src/prompts/shared.js` - Shared prompt components
- `src/prompts/templates/base-agent-template.js` - Template function

### Configuration

- `.env` - Environment variables (API keys, credentials)
- `package.json` - Dependencies and scripts
- `index.js` - CLI entry point

---

## Code Quality Standards

### LangChain v1.0 Patterns (February 2026)
- **USE** `withStructuredOutput()` with Zod schemas for guaranteed JSON
  - **CRITICAL**: Use `method: 'jsonSchema'` (camelCase), NOT `'json_schema'` (v0.3 syntax)
- **USE** `bindTools()` for native tool calling
- **USE** few-shot examples in prompts
- **AVOID** union types in schemas (Gemini v1.0 rejects anyOf/oneOf)

### Agent Design Principles
- **Root cause over symptoms**: Identify WHY issues occur, not just THAT they occur
- **Evidence-based**: All findings require concrete data references
- **Confidence scoring**: All estimates include confidence levels (0-1)
- **Causal attribution**: Distinguish root causes from symptoms

### Testing & Verification
- **Test on real sites**: Use www.qualcomm.com, www.adobe.com as reference
- **Validate schemas**: Ensure JSON outputs match Zod schemas 100%

---

## Environment Setup

### Required Environment Variables
- `GOOGLE_CRUX_API_KEY` - Chrome UX Report API
- `GOOGLE_PAGESPEED_INSIGHTS_API_KEY` - PageSpeed Insights API
- `GOOGLE_APPLICATION_CREDENTIALS` - Vertex AI auth for Gemini models

### Optional
- Azure OpenAI keys for GPT models
- AWS credentials for Bedrock (Claude models)

---

## Common Tasks

**Run analysis on a site:**
```bash
node index.js --url https://example.com --device mobile
```

**Skip cache (force fresh collection):**
```bash
node index.js --url https://example.com --device mobile --skip-cache
```

**Use different LLM model:**
```bash
node index.js --url https://example.com --device mobile --analysis-model gemini25flash
```

**MCP server (Cursor integration):**
```bash
node src/core/mcp-reviewer.js
```

---

## Getting Help

- **Architecture questions:** See [architecture.md](.claude/architecture.md) or [ARCHITECTURE-TODO.md](.claude/ARCHITECTURE-TODO.md)
- **Implementation status:** See [implementation-plan.md](.claude/implementation-plan.md)
- **Code examples:** See design docs in `.claude/design-*.md`
- **SDD workflow:** See [collaboration-guide.md](.claude/collaboration-guide.md)

---

## Archived Documentation

Historical phase summaries and old completion docs were archived during SDD migration (February 2026). Current docs follow Spec-Driven Development naming conventions (design-*, research-*, context-*).
