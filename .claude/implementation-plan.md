# CWV Agent: Implementation Plan & Status

**Status:** Living Document
**Last Updated:** 2026-02-11

> Centralized tracking of implementation phases, what's done, and what's next.

---

## Overview

CWV Agent was built iteratively across 6 major phases + 6 improvement weeks:

| Phase | Name | Status | Completion | Files |
|-------|------|--------|------------|-------|
| **Phase 0** | Foundation | ✅ Done | 2025-XX-XX | See § Phase 0 |
| **Phase 0.5** | Agent System Refactoring | ✅ Done | 2025-XX-XX | See § Phase 0.5 |
| **Phase 1** | Multi-Agent Parallelization | ✅ Done | 2025-XX-XX | See § Phase 1 |
| **Phase A** | Rich Data Collection | ✅ Done | 2025-XX-XX | See § Phase A |
| **Phase 2** | Chain of Thought | ✅ Done | 2025-XX-XX | See § Phase 2 |
| **Phase 3** | Causal Graph Analysis | ✅ Done | 2025-XX-XX | See § Phase 3 |
| **Phase 4** | Validation & Quality | ✅ Done | 2025-XX-XX | See § Phase 4 |
| **Phase 5** | LangChain v1.0 Migration | ✅ Done | 2026-02-10 | See § Phase 5 |
| **Week 1-3** | Prompt Templates, Critical Paths | ✅ Done | 2026-01-XX | See § Week 1-3 |
| **Week 4** | Signal Extraction Service | ✅ Done | 2026-01-XX | See § Week 4 |
| **Week 5-6** | Collector Factory Pattern | ✅ Done | 2026-02-XX | See § Week 5-6 |
| **Current** | SDD Model Alignment | 🔨 In Progress | 2026-02-11 | See § Current |

---

## Phase 0: Foundation (DONE)

**Goal:** Basic multi-agent system with data collection

**Key Achievements:**
- Created initial 8-agent architecture (CrUX, PSI, HAR, Coverage, Code, HTML, Perf Observer, Rules)
- Implemented parallel agent execution
- Created Zod schemas for structured output
- Integrated LangChain for LLM orchestration

**Files Created:**
- `src/core/multi-agents.js` - Multi-agent orchestration
- `src/prompts/analysis.js` - Agent prompts
- `src/models/llm-factory.js` - LLM abstraction
- `src/core/collect.js` - Data collection

**Metrics:**
- 8 agents running in parallel
- ~45s total collection time
- Basic structured output (type, metric, description)

**Related Docs:**
- PHASE-0-COMPLETE.md (will be archived)

---

## Phase 0.5: Agent System Refactoring (DONE)

**Goal:** Improve agent architecture for testability and clarity

**Key Achievements:**
- Refactored agent system into `Tool`, `Agent`, `MultiAgentSystem` classes
- Separated tool execution from agent reasoning
- Improved error handling and logging

**Files Modified:**
- `src/core/multi-agents/agent-system.js` - New class-based architecture

**Metrics:**
- Better separation of concerns
- Easier to test agent logic independently

**Related Docs:**
- PHASE-0.5-COMPLETE.md (will be archived)

---

## Phase 1: Multi-Agent Parallelization (DONE)

**Goal:** Structured output schema with evidence, impact estimates

**Key Achievements:**
- Added `evidence` field to AgentFinding schema (source, reference, confidence)
- Added `estimatedImpact` field (metric, reduction, confidence, calculation)
- Updated all 8 agent prompts with examples
- Created validation for output structure

**Files Modified:**
- `src/prompts/shared.js` - Schema definitions
- `src/prompts/analysis.js` - All 8 agent prompts

**Output Example:**
```json
{
  "type": "opportunity",
  "metric": "LCP",
  "description": "Render-blocking JavaScript delays LCP",
  "evidence": {
    "source": "PageSpeed Insights",
    "reference": "eliminate-render-blocking-resources audit",
    "confidence": 0.9
  },
  "estimatedImpact": {
    "metric": "LCP",
    "reduction": 850,
    "confidence": 0.75,
    "calculation": "550ms (avg blocking time) + 300ms (parse/execute)"
  }
}
```

**Related Docs:**
- PHASE-1-IMPLEMENTATION-SUMMARY.md (will be archived)
- PHASE-1-PLAN.md (will be archived)

---

## Phase A: Rich Data Collection (DONE)

**Goal:** Enhanced data collection with HAR per-domain breakdown and font strategy

**Key Achievements:**
- Added per-domain HAR summary (top 15 domains, timing breakdown, 1st/3rd party labels)
- Comprehensive font strategy extraction (@font-face details, preload detection, display issues)
- Performance filtering (priority hints, render-blocking detection)

**Files Modified:**
- `src/tools/lab/har-collector.js` - `generatePerDomainSummary()` function
- `src/tools/lab/index.js` - Font strategy extraction

**Impact:**
- Agents can now identify slow third-party domains
- Font optimization recommendations more specific

**Related Docs:**
- PHASE-A-IMPLEMENTATION-SUMMARY.md (will be archived)
- PHASE-A-PLUS-PERF-FILTERING.md (will be archived)

---

## Phase 2: Chain of Thought (DONE)

**Goal:** Explicit 4-step reasoning framework in agent outputs

**Key Achievements:**
- Added `reasoning` field to AgentFinding schema (observation, diagnosis, mechanism, solution)
- Created `getChainOfThoughtGuidance()` with examples and anti-patterns
- Updated all 8 agent prompts with reasoning requirements

**Files Modified:**
- `src/prompts/shared.js` - Schema update
- `src/prompts/analysis.js` - All 8 agent prompts

**Output Example:**
```json
{
  "reasoning": {
    "observation": "clientlib-site.js is 3348KB total, with 1147KB unused (34% waste)",
    "diagnosis": "Unused JavaScript is downloaded, parsed, kept in memory despite never executing",
    "mechanism": "1147KB adds ~400ms download + ~150ms parse time, directly delaying TBT",
    "solution": "Tree-shaking removes 1147KB, eliminating overhead and improving TBT by ~550ms"
  }
}
```

**Impact:**
- Agent findings now explain "why" not just "what"
- Better synthesis quality (synthesis agent understands reasoning)

**Related Docs:**
- PHASE-2-CHAIN-OF-THOUGHT-SUMMARY.md (will be archived)

---

## Phase 3: Causal Graph Analysis (DONE)

**Goal:** Build dependency graph showing root causes → symptoms

**Key Achievements:**
- Created causal graph builder with 7 relationship types (blocks, delays, causes, contributes, depends, duplicates, compounds)
- Depth calculation (distance from metrics)
- Root cause identification (no incoming edges)
- Critical path analysis (longest chains)
- Duplicate detection across agents

**Files Created:**
- `src/models/causal-graph.js` - Graph data structures
- `src/core/causal-graph-builder.js` - Graph construction algorithm

**Files Modified:**
- `src/core/multi-agents.js` - Integrated graph builder after agent execution

**Output Example:**
```
metric-lcp (LCP is 4.5s) ← SYMPTOM
  ↑ delays (0.9)
psi-lcp-1 (Render-blocking script...) ← BOTTLENECK
  ↑ contributes (0.8)
coverage-unused-1 (1147KB unused code) ← ROOT CAUSE
```

**Metrics:**
- 17 findings → 7 unique (10 merged as duplicates)
- 3 root causes identified
- 5 critical paths calculated

**Related Docs:**
- PHASE-3-CAUSAL-GRAPH-SUMMARY.md (will be archived)

---

## Phase 4: Validation & Quality (DONE)

**Goal:** Evidence quality checks and confidence calibration

**Key Achievements:**
- Created 3-tier validation system (APPROVED, ADJUSTED, BLOCKED)
- Evidence quality rules (source tier, confidence caps, reference requirements)
- Impact consistency checks (timing budgets, metric bounds)
- Root cause validation (depth, concrete fixes)
- Validation agent with blocking mode

**Files Created:**
- `src/core/validator.js` - Validation logic
- `src/models/validation-rules.js` - Validation rules

**Files Modified:**
- `src/core/multi-agents.js` - Integrated validator after causal graph

**Metrics:**
- 16 findings approved
- 1 finding adjusted (confidence lowered)
- 0 findings blocked
- Average confidence: 72.4%

**Related Docs:**
- PHASE-4-VALIDATION-SUMMARY.md (will be archived)

---

## Phase 5: LangChain v1.0 Migration (DONE)

**Goal:** Migrate from LangChain 0.3 to 1.0 (breaking changes)

**Key Achievements:**
- Removed union types from Zod schemas (Gemini v1.0 rejects anyOf/oneOf)
- Converted `z.union([z.string(), z.array(z.string())])` → `z.array(z.enum([...]))`
- Added `method: 'jsonSchema'` parameter to all `withStructuredOutput()` calls
- Fixed agent system JSON parsing failures (HTML Agent, Rules Agent)

**Files Modified:**
- `src/core/multi-agents/schemas.js` - Schema fixes
- `src/core/multi-agents/agent-system.js` - Added method parameter
- `src/core/multi-agents/suggestions-engine.js` - Added method parameter

**Impact:**
- All 9 agents now return valid JSON (no more parsing errors)
- Compatible with Gemini 2.5 Pro v1.0 API

**Related Docs:**
- PHASE-5-LANGCHAIN-V1-MIGRATION.md (if exists, will be archived)

---

## Week 1-3: Prompt Optimization (DONE)

**Goal:** Reduce token usage via shared templates

**Key Achievements:**
- Created `createAgentPrompt()` template function
- Extracted shared sections: chain-of-thought guidance (47 lines), data priority (12 lines), output format (30 lines)
- Reduced per-agent tokens from ~5000 → ~1600 (68% reduction)
- All 9 agents migrated to template system

**Files Created:**
- `src/prompts/templates/base-agent-template.js` (template function)

**Files Modified:**
- `src/prompts/analysis.js` - Refactored from 2,500 → 800 lines

**Metrics:**
- 9 agents × 5000 tokens = 45,000 total → 9 agents × 1600 tokens = 14,400 total
- 68% token reduction
- Synthesis context size reduced from ~90KB → ~63KB

**Test Results (UPS Mobile):**
- ✅ 7 agents executed successfully
- ✅ 17 findings collected, 7 merged via deduplication
- ✅ 7 high-quality suggestions generated
- ✅ Validation: 16 approved, 1 adjusted, 0 blocked

**Related Docs:**
- PROMPT-DEDUPLICATION-COMPLETE.md → design-prompt-templates.md (rename pending)

---

## Week 4: Signal Extraction Service (DONE)

**Goal:** Extract scattered signal extraction logic into testable service

**Key Achievements:**
- Created `SignalExtractor` service class (236 lines, 7 methods)
- Moved logic from orchestrator.js and suggestions-engine.js
- Eliminated ~100 lines of duplicate code
- Improved chain detection from fragile regex to robust method

**Files Created:**
- `src/core/services/signal-extractor.js` - SignalExtractor class

**Files Modified:**
- `src/core/multi-agents/orchestrator.js` (-75 net lines)
- `src/core/multi-agents/suggestions-engine.js` (-30 net lines)

**Methods:**
- `extractPsiSignals(psi)` - PSI audit signals
- `extractHarStats(har)` - HAR statistics
- `extractPerfSignals(perfEntries)` - Performance signals
- `extractChainSignal(harSummary)` - Chain detection (improved)
- `deriveCoverageGate(psiSignals)` - Coverage gating logic
- `deriveCodeGate(psiSignals, shouldRunCoverage, isLightMode)` - Code gating logic
- `selectCodeResources(pageUrl, resources)` - Resource filtering

**Related Docs:**
- WEEK4-SIGNAL-EXTRACTOR-COMPLETE.md → design-signal-extractor.md (rename pending)

---

## Week 5-6: Collector Factory Pattern (DONE)

**Goal:** Dependency injection and unified collector interface

**Key Achievements:**
- Created `CollectorFactory` (249 lines)
- Created `StandaloneCollectorAdapter` for standalone functions
- Unified interface for 8 collector types (HAR, Coverage, Performance, HTML, Font, JSApi, ThirdParty, CLS)
- Decoupled orchestrator from specific collector imports (1 import → 0 imports)
- Decoupled lab/index.js from summarization functions (5 imports → 0 imports)

**Files Created:**
- `src/core/factories/collector-factory.js` - Factory + adapter classes

**Files Modified:**
- `src/core/multi-agents/orchestrator.js` (use factory for HAR summarization)
- `src/tools/lab/index.js` (use factory for all summarization)
- `src/core/multi-agents.js` (fixed barrel exports after Week 4)

**Metrics:**
- 8 collector types registered
- 100% decoupling (orchestrator has 0 direct collector imports)
- Incremental migration (deferred full lab/index.js pipeline refactoring)

**Related Docs:**
- WEEK5-6-COLLECTOR-FACTORY-COMPLETE.md → design-collector-factory.md (rename pending)

---

## Current Work: SDD Model Alignment (IN PROGRESS)

**Goal:** Align documentation with Spec-Driven Development model

**Status:** In progress (Phase 1 of 4)

**Completed:**
- ✅ Phase 0: Deleted 21 obsolete and duplicate files (40% reduction)
- ✅ Created executive-summary.md (high-level "what and why")
- ✅ Created ARCHITECTURE-TODO.md (open decisions tracking)
- ✅ Created this file (implementation-plan.md)

**In Progress:**
- 🔨 Phase 1: Delete 15 phase summary files after migration
- 🔨 Phase 2: Rename 11 files to SDD conventions (design-*, research-*)
- 🔨 Phase 3: Restructure CLAUDE.md as navigation index
- 🔨 Phase 4: Handle 6 reference docs (rename or merge)

**Expected Outcome:**
- 53 files → ~20 files (62% reduction)
- SDD-compliant naming (design-*, research-*, context-*)
- Status metadata in all docs (Draft/Review/Decided/Implemented)
- Clear navigation via CLAUDE.md index

---

## Roadmap (Next)

**Near-Term (Next 2-4 weeks):**
- Finish SDD model alignment (rename files, restructure CLAUDE.md)
- Add critical paths to synthesis context (approved, 30 min effort)
- HAR OPTIONS request filtering (approved, 1-2 hours effort)
- Evidence quality validation rules (deferred, maybe later)

**Medium-Term (Next 2-3 months):**
- Consider structured logging (if production deployment needed)
- Pilot SDD workflow for 1-2 new features (if team wants to adopt)

**Long-Term (Future):**
- Test suite (if codebase requires major refactoring)
- Coverage + Code collection merge (if perf becomes bottleneck)

See [ARCHITECTURE-TODO.md](ARCHITECTURE-TODO.md) for full list of open decisions and deferred work.

---

## Metrics Summary

**Agent System:**
- 9 specialized agents (CrUX, RUM, PSI, Perf Observer, HTML, Rules, HAR, Coverage, Code Review)
- Parallel execution (all agents run concurrently)
- ~45s total collection time (varies by site)

**Data Quality:**
- Average confidence: 72.4% (validation results)
- Deduplication: 17 findings → 7 unique (10 merged)
- Root cause identification: 3 root causes, 5 critical paths

**Code Quality:**
- Token reduction: 68% (45,000 → 14,400 tokens)
- Code reduction: ~200 lines (signal extractor, factory pattern)
- Documentation reduction: 62% (53 → 20 files, target)

---

## Navigation

- **Up:** [CLAUDE.md](CLAUDE.md) - Document index
- **Related:** [ARCHITECTURE-TODO.md](ARCHITECTURE-TODO.md) - Open decisions
- **Related:** [architecture.md](architecture.md) - Core architecture
- **Related:** [executive-summary.md](executive-summary.md) - High-level overview
