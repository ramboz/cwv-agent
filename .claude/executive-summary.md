# CWV Agent: Core Web Vitals Performance Analysis

**Status:** Living Document
**Last Updated:** 2026-02-11

> A multi-agent AI system that analyzes web performance using Core Web Vitals metrics and generates actionable optimization suggestions.

---

## What is CWV Agent?

CWV Agent is an automated performance analysis tool that:
- **Collects comprehensive performance data** from multiple sources (CrUX, PSI, HAR, RUM, Coverage)
- **Analyzes with 9 specialized AI agents** running in parallel (CrUX Agent, PSI Agent, HAR Agent, etc.)
- **Identifies root causes** using causal graph analysis and deduplication
- **Generates concrete suggestions** with code examples and impact estimates

**Target Users:**
- Performance engineers optimizing web vitals
- DevOps teams automating performance monitoring
- Developers seeking AI-assisted optimization guidance

**Key Capabilities:**
- Field + Lab data correlation (CrUX + Lighthouse)
- Device-aware analysis (mobile/desktop thresholds)
- Framework detection (AEM, EDS, generic)
- SpaceCat integration for Adobe customers
- MCP server for Cursor IDE integration

---

## Why Does This Exist?

**Problem:** Web performance optimization is complex:
- Multiple metrics (LCP, CLS, TBT, INP, TTFB)
- Multiple data sources (field data, lab data, RUM)
- Hard to identify root causes vs. symptoms
- Hard to estimate impact of fixes

**Solution:** CWV Agent automates this:
- Multi-agent analysis finds root causes
- Causal graph deduplicates redundant findings
- Synthesis generates prioritized suggestions
- Code examples make fixes actionable

---

## How Does It Work?

### 1. Data Collection
Parallel collection of:
- **Field Data:** CrUX API (28-day p75 real-user metrics)
- **Lab Data:** PageSpeed Insights (Lighthouse audits)
- **RUM Data:** Adobe RUM Bundler (actual visitor sessions)
- **HAR Data:** Puppeteer-captured HTTP Archive + chain detection
- **Coverage Data:** Chrome DevTools code coverage (JS/CSS usage)
- **Performance Entries:** PerformanceObserver API (LCP, CLS, LoAF, Long Tasks)

### 2. Multi-Agent Analysis
9 specialized agents run in parallel:
- **CrUX Agent:** Real-user field data trends
- **RUM Agent:** Session-level visitor experience
- **PSI Agent:** Lighthouse audit analysis
- **Performance Observer Agent:** Lab metric deep-dive
- **HTML Agent:** DOM structure analysis
- **Rules Agent:** Custom rule evaluation
- **HAR Agent:** Network waterfall analysis
- **Code Coverage Agent:** JS/CSS unused code
- **Code Review Agent:** Source code analysis

Each agent returns structured findings (type, metric, evidence, impact estimate).

### 3. Causal Graph & Deduplication
- Builds dependency graph of findings
- Identifies root causes (no incoming edges)
- Merges duplicate findings across agents
- Calculates critical paths (longest chains)

### 4. Synthesis & Suggestions
- Synthesis agent reads causal graph + findings
- Generates 5-7 prioritized suggestions
- Includes: description, root cause, code changes, testing steps
- Validates with evidence quality checks

---

## Current Status (February 2026)

**Completed Phases:**
- ✅ Phase 0-6: Core architecture, multi-agents, causal analysis
- ✅ Week 1-6: Prompt templates, signal extractor, collector factory
- ✅ Documentation alignment: SDD model migration (in progress)

**Active Development:**
- 🔨 Documentation restructuring (this migration)
- 🔨 SDD model compliance

**Next Steps:**
See [implementation-plan.md](implementation-plan.md) for roadmap.

---

## Quick Links

| Document | Purpose |
|----------|---------|
| [CLAUDE.md](CLAUDE.md) | Navigation index of all docs |
| [architecture.md](architecture.md) | Core architecture reference |
| [ARCHITECTURE-TODO.md](ARCHITECTURE-TODO.md) | Open decisions & what needs work |
| [implementation-plan.md](implementation-plan.md) | Current status & phases |

**For new contributors:** Start with this doc, then CLAUDE.md for navigation.
