# CWV Agent: Open Decisions & TODO

**Status:** Living Document
**Last Updated:** 2026-02-11

> Centralized tracking of open decisions, deferred work, and what needs attention.

---

## Open Decisions (OPEN)

### 1.1 Should We Add Structured Logging with Pino?

**Status:** OPEN
**Priority:** P2 (Nice to have)
**Decision needed by:** TBD

**Context:**
Currently using 102+ `console.log/warn/error` calls. No structured logs for aggregation/search.

**Options:**
| Option | Pros | Cons |
|--------|------|------|
| Add Pino | Structured JSON logs, correlation IDs, production-ready | New dependency, ~4-6h effort |
| Keep console | Zero effort, works today | Hard to debug multi-agent flows |

**Related Docs:**
- Original analysis in improvement plan (Week 1-6)

**User Feedback:** Deferred (not critical path)

---

### 1.2 Should PSI and Performance Observer Both Run?

**Status:** DECIDED ✅
**Decision:** YES - They provide complementary signals
**Date:** 2026-01-XX

**Context:**
PSI runs Lighthouse (lab metrics), Perf Observer uses PerformanceObserver API (real-time lab).

**Decision:**
Keep both agents. PSI gives average lab metrics, Perf Observer gives immediate session metrics.

**Rationale:**
> "PSI gives us an average of actual field data, while the perf observer API gives us some immediate lab metrics. These feel 2 different signals that complement each other to me." - User feedback

**Related Docs:**
- [design-conditional-gating.md](design-conditional-gating.md)

---

## Deferred Work (DEFERRED)

### 2.1 Merge Coverage + Code Collection

**Status:** DEFERRED
**Reason:** Too risky - both collect same files, hard to refactor without breaking

**Original Proposal:**
Merge coverage and code collection to avoid redundant file fetches (20-30% time savings).

**Why Deferred:**
- Coverage analyzes bytecounts (line-level detail)
- Code collection fetches full source
- Merging requires careful refactoring to preserve both analysis modes

**Related Docs:**
- Original improvement plan

---

### 2.2 Add Test Suite with Vitest

**Status:** DEFERRED
**Reason:** High effort (16-20h), not critical path

**Original Proposal:**
105+ unit tests for signal extraction, gating, validation, causal graph.

**Why Deferred:**
- Project is mature, code works
- Adding tests now = high effort for existing code
- Better to add tests for NEW features going forward

**Related Docs:**
- Original improvement plan

---

### 2.3 Add Structured Logging Mixin

**Status:** DEFERRED
**Reason:** Depends on decision 1.1 (whether to add Pino)

**Original Proposal:**
Extract shared logging patterns from collectors into reusable mixin (reduce ~105 lines duplication).

**Why Deferred:**
- Only makes sense if we adopt Pino (decision 1.1 pending)
- If staying with console.log, mixin has minimal value

---

### 2.4 Add Examples to Rules & Code Agents

**Status:** MAYBE
**Reason:** User not fully convinced this improves output quality

**Original Proposal:**
Rules Agent and Code Review Agent have no few-shot examples. Add 3-4 examples each.

**Why Maybe:**
- User feedback: "maybe" priority
- Worth trying if agent quality becomes issue
- Low effort (1-2 hours)

---

## Completed Decisions (DECIDED)

### 3.1 Prompt Template System

**Status:** IMPLEMENTED ✅
**Date:** 2026-01-XX

**Decision:**
Extract shared prompt content (chain-of-thought, data priority, output format) into reusable templates.

**Implementation:**
- Created `createAgentPrompt()` template function
- Reduced per-agent tokens from ~5000 → ~1600 (68% reduction)
- All 9 agents migrated to template system

**Related Docs:**
- [design-prompt-templates.md](design-prompt-templates.md)

---

### 3.2 Signal Extraction Service

**Status:** IMPLEMENTED ✅
**Date:** 2026-01-XX

**Decision:**
Extract scattered signal extraction logic into testable `SignalExtractor` service class.

**Implementation:**
- Created SignalExtractor service (236 lines, 7 methods)
- Removed ~100 lines of duplicate code from orchestrator + suggestions-engine
- Improved chain detection from fragile regex to robust method

**Related Docs:**
- [design-signal-extractor.md](design-signal-extractor.md)

---

### 3.3 Collector Factory Pattern

**Status:** IMPLEMENTED ✅
**Date:** 2026-02-XX

**Decision:**
Create factory pattern for dependency injection and unified collector interface.

**Implementation:**
- Created CollectorFactory (249 lines)
- Unified interface for LabDataCollector + standalone functions
- Decoupled orchestrator from specific collector imports

**Related Docs:**
- [design-collector-factory.md](design-collector-factory.md)

---

### 3.4 HAR OPTIONS Request Filtering

**Status:** APPROVED (Not yet implemented)
**Priority:** P1
**Effort:** 1-2 hours

**Decision:**
Filter OPTIONS preflight requests at CDP level BEFORE capture (not after).

**Expected Impact:**
5-10% HAR size reduction, less CPU/memory waste.

---

### 3.5 Critical Paths to Synthesis Context

**Status:** APPROVED (Not yet implemented)
**Priority:** P1
**Effort:** 30 minutes

**Decision:**
Pass `criticalPaths` from causal graph to synthesis agent context.

**Expected Impact:**
Better root cause prioritization (synthesis sees longest dependency chains).

---

## What Needs Work (TODO)

### 4.1 Documentation Alignment with SDD Model

**Priority:** P0 (In progress)
**Assignee:** TBD
**Status:** In progress

**Tasks:**
- [x] Create executive-summary.md
- [x] Create this file (ARCHITECTURE-TODO.md)
- [ ] Create implementation-plan.md
- [ ] Restructure CLAUDE.md as navigation index
- [ ] Rename 7 completion docs to design-*.md
- [ ] Add status headers to all docs

**Related Docs:**
- [collaboration-guide.md](collaboration-guide.md)

---

### 4.2 Implement Critical Paths Context

**Priority:** P1 (Approved)
**Assignee:** TBD
**Status:** Not started

**Tasks:**
- [ ] Extract `criticalPaths` from causal graph (already computed)
- [ ] Format as markdown section in synthesis context
- [ ] Pass to synthesis agent (lines 651+ in suggestions-engine.js)

**Expected Impact:**
Better root cause prioritization (synthesis sees longest dependency chains).

---

### 4.3 Implement HAR OPTIONS Filtering

**Priority:** P1 (Approved)
**Assignee:** TBD
**Status:** Not started

**Tasks:**
- [ ] Add request interception to har-collector.js
- [ ] Filter OPTIONS at CDP level (before capture)
- [ ] Remove post-capture filter logic

**Expected Impact:**
5-10% HAR size reduction, less CPU/memory usage.

---

## Navigation

- **Up:** [CLAUDE.md](CLAUDE.md) - Document index
- **Related:** [implementation-plan.md](implementation-plan.md) - What's done/next
- **Related:** [architecture.md](architecture.md) - Core architecture
