# Collaboration Guide: Spec-Driven Development with Claude Code

**Status:** Living Document
**Audience:** Engineers and architects joining the blackboard architecture initiative

> This guide explains how we collaborate on architecture design using markdown specifications and Claude Code. It's the "way of working" for this initiative.

---

## Philosophy: Specs as Source of Truth

We practice **Spec-Driven Development (SDD)** - a 2025 methodology where markdown specifications are the authoritative source, not code. AI assists in both spec refinement and implementation.

**Key principle:** *"Specifications don't serve code—code serves specifications."*

```
Traditional:     Code → Documentation (docs rot)
Spec-Driven:     Specification → AI-assisted Code → Specification validates Code
```

**Why this works for architecture:**
- Complex systems need shared understanding before implementation
- Markdown is version-controlled, reviewable, searchable
- Claude Code can read specs and implement consistently
- Multiple architects can iterate asynchronously
- Decisions are documented with rationale, not just outcomes

---

## Getting Started (New Engineer Onboarding)

### 1. Set Up Your Environment

```bash
# Clone the repo
git clone git@git.corp.adobe.com:experience-platform/mystique.git
cd mystique

# Create a feature branch for your work
git checkout -b blackboard-<your-topic>

# Open in your editor with Claude Code
claude  # or use VS Code with Claude extension
```

### 2. Orient Yourself

Start by reading these docs in order:

| Order | Document | Purpose |
|-------|----------|---------|
| 1 | [CLAUDE.md](CLAUDE.md) | Index of all docs, key concepts, visualizations |
| 2 | [executive-summary.md](executive-summary.md) | High-level "what and why" |
| 3 | [architecture.md](architecture.md) | Core architecture (facts, scopes, services) |
| 4 | [ARCHITECTURE-TODO.md](ARCHITECTURE-TODO.md) | Open decisions, gaps, what needs work |
| 5 | [implementation-plan.md](implementation-plan.md) | Current status, phases, what's done |

**Pro tip:** Ask Claude Code to summarize:
```
> Summarize the current state of the blackboard architecture.
> What are the main open decisions?
```

### 3. Explore the Visualizations

Start the local server to see interactive DAGs:

```bash
source localstack.env && cd app && uv run uvicorn asgi:app --port 8080
```

Then visit:
- [localhost:8080/bb/](http://localhost:8080/bb/) - Future architecture vision
- [localhost:8080/bb/live-code.html](http://localhost:8080/bb/live-code.html) - Current code state
- [localhost:8080/bb/live-explorer.html](http://localhost:8080/bb/live-explorer.html) - Browse facts in DB

---

## How We Work: The Collaboration Loop

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     SPEC-DRIVEN DEVELOPMENT LOOP                         │
│                                                                          │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐         │
│   │  DRAFT   │───►│  REVIEW  │───►│  DECIDE  │───►│IMPLEMENT │         │
│   │          │    │          │    │          │    │          │         │
│   │ Write MD │    │ PR + AI  │    │ Update   │    │ AI-assist│         │
│   │ proposal │    │ review   │    │ TODO.md  │    │ from spec│         │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘         │
│        │                                               │                 │
│        └───────────────────────────────────────────────┘                │
│                         Iterate                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Step 1: Draft a Proposal

When you have an idea, design decision, or research finding:

1. **Create a new markdown file** with appropriate prefix:
   - `proposal-*.md` - New feature or approach proposals
   - `design-*.md` - Detailed design decisions
   - `research-*.md` - Exploratory research (may not lead to implementation)
   - `review-*.md` - Critical analysis of existing proposals
   - `context-*.md` - Background information for reference

2. **Use this template:**

```markdown
# [Title]

**Status:** Draft | Review | Decided | Implemented
**Author:** [Your name]
**Date:** YYYY-MM-DD

> One-line summary of what this document proposes/decides.

---

## Problem Statement

What problem are we solving? Why does it matter?

## Proposal

What are we proposing? Be specific.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Option A | ... | ... |
| Option B | ... | ... |

## Decision

[After review] What we decided and why.

## Open Questions

- [ ] Question 1?
- [ ] Question 2?

## Related Documents

- [link](link) - How this relates
```

3. **Use Claude Code to help draft:**

```
> I want to propose a new approach for handling fact versioning.
> Help me draft a proposal doc that considers the existing
> architecture in docs/blackboard/architecture.md
```

### Step 2: Review Process

1. **Push your branch and create a PR**
   ```bash
   git add docs/blackboard/your-doc.md
   git commit -m "docs(blackboard): add proposal for X"
   git push -u origin blackboard-your-topic
   ```

2. **Request review from other architects**
   - Tag relevant people in the PR
   - Use GitHub's review features for inline comments

3. **AI-assisted review** - Reviewers can use Claude Code:
   ```
   > Review docs/blackboard/proposal-X.md for consistency with
   > our existing architecture. Check for conflicts with
   > service-interfaces.md and ARCHITECTURE-TODO.md
   ```

4. **Iterate based on feedback**
   - Update the doc directly
   - Add "Review Notes" section if helpful
   - Resolve comments

### Step 3: Decision & TODO Tracking

Once a proposal is accepted:

1. **Update the doc status** to `Decided`

2. **Update [ARCHITECTURE-TODO.md](ARCHITECTURE-TODO.md)**:
   - Add action items from the decision
   - Mark related items as `DECIDED`
   - Link to the proposal doc

3. **Update [CLAUDE.md](CLAUDE.md)** index if it's a significant doc

4. **Update [implementation-plan.md](implementation-plan.md)** if it affects phases

### Step 4: Implementation

When implementing from specs:

1. **Point Claude Code at the spec:**
   ```
   > Implement the fact versioning system as specified in
   > docs/blackboard/design-fact-versioning.md
   ```

2. **Claude Code will:**
   - Read the spec
   - Understand the requirements
   - Generate code that matches the spec
   - Reference the spec in code comments if helpful

3. **Validate implementation matches spec:**
   ```
   > Compare the implementation in app/services/blackboard/
   > with the spec in docs/blackboard/design-X.md.
   > Are there any gaps or deviations?
   ```

---

## Document Conventions

### File Naming

| Prefix | Purpose | Example |
|--------|---------|---------|
| `architecture*.md` | Core architecture docs | `architecture.md` |
| `design-*.md` | Specific design decisions | `design-fact-granularity.md` |
| `proposal-*.md` | New proposals (pre-decision) | `proposal-batch-processing.md` |
| `research-*.md` | Exploratory research | `research-claude-sdk.md` |
| `review-*.md` | Critical analysis | `review-data-service.md` |
| `context-*.md` | Background reference | `context-spacecat.md` |
| `roadmap-*.md` | Future plans | `roadmap-migration.md` |
| `mvp-*.md` | MVP-specific docs | `mvp-scope.md` |
| `CLAUDE.md` | Index/navigation (per folder) | `dev-experience/CLAUDE.md` |

### Document Status

Always include status in the header:

| Status | Meaning |
|--------|---------|
| **Draft** | Work in progress, not ready for review |
| **Review** | Ready for peer review |
| **Decided** | Decision made, ready for implementation |
| **Implemented** | Code exists that implements this |
| **Superseded** | Replaced by another doc (link to it) |
| **Research** | Exploratory, may not lead to implementation |

### Linking Between Docs

- Use relative links: `[architecture](architecture.md)`
- Link to specific sections: `[fact scoping](architecture.md#fact-scoping)`
- Reference in ARCHITECTURE-TODO.md: `**Source:** [doc.md](doc.md) § Section Name`

### Diagrams

Use Mermaid for diagrams (renders in GitHub):

```markdown
​```mermaid
graph LR
    A[Control] --> B[Blackboard]
    B --> C[Reasoning]
​```
```

For complex diagrams, create separate `.mmd` files.

---

## Using Claude Code Effectively

### Discovery & Understanding

```
# Find all docs about a topic
> What docs in docs/blackboard/ discuss fact dependencies?

# Understand current state
> Summarize the open decisions in ARCHITECTURE-TODO.md
> that relate to the Data Service

# Check for conflicts
> Does proposal-X.md conflict with anything in service-interfaces.md?
```

### Drafting & Iteration

```
# Draft a new proposal
> Help me write a design doc for implementing retry logic
> in the Reasoning service. Consider the patterns in
> service-interfaces.md

# Improve existing doc
> Review design-subscope-aggregation.md and suggest
> improvements. Are there gaps in the open questions?

# Generate alternatives table
> For the event bus decision (SNS vs EventBridge),
> create a detailed comparison table with our specific
> requirements in mind
```

### Implementation from Specs

```
# Implement from spec
> Implement the FactStore interface as specified in
> architecture.md. Use the patterns from existing
> code in app/services/

# Validate implementation
> Check if app/services/blackboard/fact_store.py
> implements everything specified in architecture.md

# Generate tests from spec
> Generate test cases for the fact store based on
> the requirements in architecture.md
```

### Review Assistance

```
# Cross-reference check
> Check this PR's changes against the specs in
> docs/blackboard/. Are there any deviations?

# Consistency check
> Are there any contradictions between
> service-interfaces.md and service-commands-events.md?
```

---

## Workflow Examples

### Example 1: Proposing a New Feature

**Scenario:** You want to add fact compression to reduce storage costs.

```bash
# 1. Create branch
git checkout -b blackboard-fact-compression

# 2. Draft proposal with Claude Code
claude
> Help me draft a proposal for fact compression.
> I want to compress large fact payloads before storing.
> Consider the existing architecture in docs/blackboard/architecture.md

# 3. Claude creates docs/blackboard/proposal-fact-compression.md

# 4. Review and refine
> Add a section on compression algorithm options.
> Compare zstd vs lz4 vs gzip for our use case.

# 5. Commit and PR
git add docs/blackboard/proposal-fact-compression.md
git commit -m "docs(blackboard): propose fact compression"
git push -u origin blackboard-fact-compression
# Create PR, request reviews
```

### Example 2: Researching External Integration

**Scenario:** Investigating how to integrate with a new external service.

```bash
# 1. Create research doc
claude
> Create a research doc for integrating with Adobe Target.
> I need to understand what data we'd fetch and how it
> maps to our fact model.

# 2. Claude creates docs/blackboard/research-target-integration.md
# with Status: Research

# 3. After research, if we decide to proceed:
> Convert research-target-integration.md into a design doc.
> Add concrete API contracts and fact definitions.

# 4. Rename or create new doc with Status: Review
```

### Example 3: Resolving an Open Decision

**Scenario:** The ARCHITECTURE-TODO.md has an OPEN decision about event naming.

```bash
# 1. Read the context
claude
> Summarize the event naming decision in ARCHITECTURE-TODO.md.
> Show me the current state in both service-interfaces.md
> and service-commands-events.md

# 2. Draft resolution
> Help me write a short decision doc that resolves the
> event naming convention. I prefer namespaced events
> (blackboard.fact.created) for clarity.

# 3. Claude creates docs/blackboard/design-event-naming.md

# 4. After review/approval, update TODO
> Update ARCHITECTURE-TODO.md section 1.3 to DECIDED.
> Add a link to design-event-naming.md

# 5. Update the affected docs
> Update service-interfaces.md to use namespaced event names
> as specified in design-event-naming.md
```

---

## Common Pitfalls

### Don't: Write code without specs

```
# Bad
> Implement fact versioning

# Good
> Implement fact versioning as specified in
> docs/blackboard/design-fact-versioning.md
```

### Don't: Let docs rot

- Update docs when implementation diverges
- Mark superseded docs clearly
- Keep ARCHITECTURE-TODO.md current

### Don't: Skip the review process

Even small changes benefit from review:
- Catches inconsistencies early
- Builds shared understanding
- Creates decision history

### Don't: Duplicate existing docs

Before writing, ask:
```
> Is there already a doc in docs/blackboard/ that
> covers fact caching?
```

---

## Quick Reference

### Key Files to Know

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Start here - index of everything |
| `ARCHITECTURE-TODO.md` | Open decisions, what needs work |
| `implementation-plan.md` | Current status, phases |
| `architecture.md` | Core architecture reference |
| `service-interfaces.md` | Service contracts |

### Common Claude Code Commands

```bash
# Orient yourself
> Summarize docs/blackboard/CLAUDE.md

# Find relevant docs
> What docs discuss [topic]?

# Check for conflicts
> Are there contradictions between [doc1] and [doc2]?

# Draft new content
> Help me write a [proposal|design|research] doc for [topic]

# Implement from spec
> Implement [feature] as specified in [doc]

# Update after decision
> Update ARCHITECTURE-TODO.md to mark [section] as DECIDED
```

### Branch Naming

```
blackboard-<topic>           # General architecture work
blackboard-design-<feature>  # Specific design work
blackboard-impl-<feature>    # Implementation work
```

---

## Getting Help

- **Slack:** #mystique-blackboard (or your team's channel)
- **Architecture questions:** Tag architects in PR
- **Claude Code issues:** Check [Claude Code docs](https://docs.anthropic.com/claude-code)

---

## Further Reading

**On Spec-Driven Development:**
- [GitHub Blog: Spec-driven development with Markdown](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-using-markdown-as-a-programming-language-when-building-with-ai/)
- [Thoughtworks: Spec-driven development - 2025's key new practice](https://www.thoughtworks.com/en-us/insights/blog/agile-engineering-practices/spec-driven-development-unpacking-2025-new-engineering-practices)
- [Martin Fowler: Understanding Spec-Driven-Development](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)

**Related Docs:**
- [dev-experience/ai-assisted-workflow.md](dev-experience/ai-assisted-workflow.md) - Technical agent development with Claude
- [dev-experience/manual-workflow.md](dev-experience/manual-workflow.md) - Agent development without AI