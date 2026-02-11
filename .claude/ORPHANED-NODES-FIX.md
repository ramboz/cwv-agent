# Fixing Orphaned Causal Graph Nodes

## Problem Statement

The causal graph has orphaned nodes that create a discrepancy between:
- **23 items in `rootCauses` array** (structural analysis: nodes with no incoming edges)
- **21 nodes with `isRootCause: true`** (LLM semantic classification)

### Specific Orphaned Nodes

1. **coverage-js-third-party-1**: Large third-party scripts (otBannerSdk.js, gtm.js, 1MB+ each)
   - `isRootCause: false` (correctly identified as symptom)
   - 0 incoming edges (appears to be root cause structurally)
   - 6 outgoing edges to metrics (TBT, INP)

2. **coverage-js-embed-1**: embed/v4.js with 87% unused code
   - `isRootCause: false` (correctly identified as symptom)
   - 1 incoming edge (DUPLICATES relationship, filtered out)
   - 5 outgoing edges to metrics (TBT, INP)

## Root Cause Analysis

### Why Are These Nodes Orphaned?

The HTML agent is NOT creating findings about third-party script loading patterns because:

1. **Hardcoded Domain List**: `src/tools/lab/index.js` lines 119-127 use a hardcoded list of third-party domains:
   ```javascript
   const thirdPartyDomains = ['googletagmanager.com', 'google-analytics.com', 'facebook.net',
                              'doubleclick.net', 'pushengage.com', 'hotjar.com', 'gtag'];
   ```

2. **Missing Domains**: Critical third-party providers are NOT in the list:
   - ❌ `cookielaw.org` (OneTrust consent - 119KB otBannerSdk.js)
   - ❌ `onetrust.com` (OneTrust)
   - ❌ `adobedtm.com` (Adobe Launch - 90KB+)
   - ❌ Many other common providers

3. **Data Available But Unused**: PSI audit `third-parties-insight` contains comprehensive third-party data with transfer sizes and main-thread time.

## Solution: Three-Layer Approach

### Layer 1: Enhanced Data Collection

**File**: `src/tools/lab/index.js`
**Change**: Replace hardcoded domain list with hostname-based detection

### Layer 2: Enhanced HTML Agent Prompt

**File**: `src/prompts/shared.js`
**Change**: Add third-party script analysis instructions

### Layer 3: Enhanced Causal Graph Builder

**File**: `src/prompts/analysis.js`
**Change**: Add configuration→waste→performance chain guidance

## Expected Results

- Orphaned nodes: 2 → 0
- Root causes array matches isRootCause count: 23 → 21
- Complete causal chains: HTML finding → Coverage finding → Metric

See full implementation details in the document.
