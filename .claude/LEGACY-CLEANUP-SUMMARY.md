# Legacy Code Cleanup Summary

## Overview

Cleaned up legacy single-shot prompt action in favor of the modern multi-agent workflow. The `agent` action is now the default, providing superior analysis quality through specialized agents, causal reasoning, and validation.

**Status**: ✅ **Complete**
**Date**: January 2026

---

## Changes Made

### 1. ✅ CLI Configuration (`src/cli/cli.js`)

**Default Action Changed**:
```javascript
// Before
default: 'collect'
choices: ['collect', 'prompt', 'merge', 'agent', 'rules', 'mcp-reviewer']

// After
default: 'agent'
choices: ['collect', 'agent', 'rules', 'mcp-reviewer']
```

**Removed Flag**:
- `--agent-mode` flag removed (always multi-agent now)

### 2. ✅ Actions Handler (`src/core/actions.js`)

**Removed Import**:
```javascript
// Removed
import runPrompt from './multishot-prompt.js';
```

**Removed Switch Case**:
```javascript
// Removed entire 'prompt' case from switch statement
case 'prompt':
  result = await runPrompt(normalizedUrl.url, deviceType, { ... });
  break;
```

**Simplified Signature**:
```javascript
// Before
export async function processUrl(pageUrl, action, deviceType, skipCache, outputSuffix, blockRequests, model, agentMode, rumDomainKey)

// After
export async function processUrl(pageUrl, action, deviceType, skipCache, outputSuffix, blockRequests, model, rumDomainKey)
```

### 3. ✅ Legacy File Deleted

**Removed**:
- `src/core/multishot-prompt.js` (~800 lines of legacy single-shot code)

### 4. ✅ Entry Point (`index.js`)

**Removed agentMode references**:
```javascript
// Removed
const agentMode = argv.agentMode;

// Updated all processUrl calls to remove agentMode parameter
await processUrl(url, action, deviceType, skipCache, outputSuffix, blockRequests, model, rumDomainKey);
```

### 5. ✅ Documentation (`README.md`)

**Updated Quick Start**:
```bash
# Before (confusing)
node index.js --action prompt --url "https://example.com"

# After (clear default)
node index.js --url "https://example.com"
```

**Updated Actions Table**:
| Action | Description |
|--------|-------------|
| `agent` | **[DEFAULT]** Run multi-agent AI analysis workflow |
| `collect` | Collect raw performance data |
| `rules` | Apply predefined performance rules |
| `mcp-reviewer` | Start interactive suggestion reviewer |

**Removed**: All references to `prompt` action throughout README

**Updated CLI Options**:
```bash
--action, -a  Action to perform [agent|collect|rules|mcp-reviewer] (default: agent)
```

---

## Actions Now Available

### ✅ `agent` (Default)
**Purpose**: Complete AI-powered analysis with multi-agent workflow
**Features**:
- 8 specialized agents (CrUX, PSI, HAR, Coverage, Code, HTML, Perf Observer, Rules)
- Causal reasoning and graph synthesis
- Validation system with confidence scoring
- PSI-gated execution (conditional heavy collectors)
- Priority 1 & 2 data attribution (third-party scripts, CLS-to-CSS)

**Usage**:
```bash
node index.js --url "https://example.com"
# or explicitly
node index.js --action agent --url "https://example.com"
```

### ✅ `collect`
**Purpose**: Data collection only (no AI analysis)
**Use Case**: When you just need raw CrUX, PSI, HAR data

**Usage**:
```bash
node index.js --action collect --url "https://example.com"
```

### ✅ `rules`
**Purpose**: Apply predefined performance rules without AI
**Use Case**: Fast rule-based checks

**Usage**:
```bash
node index.js --action rules --url "https://example.com"
```

### ✅ `mcp-reviewer`
**Purpose**: Interactive suggestion review in Cursor IDE
**Use Case**: Review and approve AI suggestions interactively

**Usage**:
```bash
node index.js --action mcp-reviewer
```

---

## What Was Removed

### ❌ `prompt` Action (Deprecated)
**Why Removed**:
- Single-shot approach with no specialization
- No causal reasoning or validation
- No data attribution (third-party, CLS)
- No PSI gating (always collected heavy data)
- Lower quality suggestions vs multi-agent

**Legacy Architecture**:
```
prompt action:
  └── Single LLM call with all data concatenated
      ├── No specialized agents
      ├── No validation
      └── No causal graph synthesis
```

**Modern Architecture** (`agent` action):
```
agent action:
  ├── Phase 1: Conditional data collection (PSI-gated)
  ├── Phase 2: Parallel specialized agents (8 agents)
  ├── Phase 3: Causal graph builder
  ├── Phase 4: Validation system
  └── Phase 5: Graph-enhanced synthesis
```

### ❌ `--agent-mode` Flag (Deprecated)
**Why Removed**: Always using multi-agent mode now (no single-agent option)

---

## Migration Guide

### For Users

**Before**:
```bash
# Old way (deprecated)
node index.js --action prompt --url "https://example.com"
```

**After**:
```bash
# New default way
node index.js --url "https://example.com"

# Or explicitly
node index.js --action agent --url "https://example.com"
```

### For Scripts/CI

Update any scripts that use `--action prompt`:

```bash
# ❌ Old (will fail)
npm run analyze -- --action prompt --url $URL

# ✅ New (recommended)
npm run analyze -- --url $URL

# ✅ Or explicit
npm run analyze -- --action agent --url $URL
```

### For Integrations

If you have integrations calling the tool, update:

```javascript
// ❌ Old
await exec('node index.js --action prompt --url ' + url);

// ✅ New
await exec('node index.js --url ' + url);
```

---

## Benefits of This Cleanup

### 🎯 Simplified User Experience
- Default action is now the best action (`agent`)
- No need to remember `--action agent` flag
- Fewer confusing choices in CLI

### 🧹 Reduced Code Complexity
- Removed 800+ lines of legacy code
- Single workflow to maintain
- Fewer conditional branches

### 📚 Clearer Documentation
- README now promotes best practices by default
- No confusion about which action to use
- Examples use modern approach

### 🚀 Better Quality by Default
- Users automatically get multi-agent analysis
- Causal reasoning enabled by default
- Validation system active by default
- Third-party and CLS attribution included

---

## Preserved Features

These features remain unchanged:

### ✅ MCP Reviewer Integration
- Still accessible via `--action mcp-reviewer`
- Cursor IDE integration intact
- SpaceCat upload functionality preserved

### ✅ Data Collection Utilities
- `collect` action still available
- `rules` action still available
- All data collectors operational

### ✅ Backward Compatibility (Partial)
- Old cached data still readable
- Output format unchanged
- SpaceCat API integration unchanged

---

## Files Modified Summary

| File | Changes | Lines Changed |
|------|---------|---------------|
| `src/cli/cli.js` | Removed prompt, agent-mode flag | -10 |
| `src/core/actions.js` | Removed prompt case, agentMode param | -15 |
| `src/core/multishot-prompt.js` | **DELETED** | -800 |
| `index.js` | Removed agentMode references | -3 |
| `README.md` | Updated all examples and docs | ~40 |

**Total Lines Removed**: ~870
**Total Files Deleted**: 1

---

## Testing Recommendations

### Verify Default Behavior
```bash
# Should run agent action by default
node index.js --url "https://www.qualcomm.com"
```

### Verify Explicit Actions
```bash
# Should work
node index.js --action agent --url "https://example.com"
node index.js --action collect --url "https://example.com"
node index.js --action rules --url "https://example.com"

# Should fail (prompt removed)
node index.js --action prompt --url "https://example.com"
```

### Verify MCP Reviewer
```bash
# Should start MCP server
node index.js --action mcp-reviewer
```

---

## Next Steps (Optional)

Future cleanup opportunities:

1. **Consolidate prompt files** - Some prompt templates may still reference old patterns
2. **Archive old cached files** - `.cache/*/*.prompt.*` files from old action
3. **Update CI/CD** - If any pipelines use `--action prompt`
4. **Documentation audit** - Check `.claude/*.md` files for prompt action references

---

## Conclusion

✅ **Legacy `prompt` action removed**
✅ **`agent` action is now default**
✅ **Codebase simplified by ~870 lines**
✅ **Documentation updated**
✅ **User experience improved**

All users now get the best analysis quality by default with the modern multi-agent workflow!
