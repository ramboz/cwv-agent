# HAR Agent Gating Debug Output - Example

## What to Look For

When you run the agent, you'll now see this debug output in the console:

```
📊 HAR Agent Gating Analysis:
  Device: mobile
  Signal 1 - Request Count: 85 > 150 = ❌ FAIL
  Signal 2 - Transfer Size: 2200KB > 3000KB = ❌ FAIL
  Signal 3 - Redirects (PSI): ❌ FAIL
  Signal 4 - Server Response Slow (PSI): ❌ FAIL
  Signal 5 - Render Blocking (PSI): ❌ FAIL
  Signals Passed: 0/5 (need 2+)
  HAR Agent: ❌ SKIPPED
```

## What Each Signal Means

### Signal 1: Request Count
- **Checks**: Number of HTTP requests > threshold
- **Current Thresholds**:
  - Mobile: >150 requests
  - Desktop: >180 requests
- **Typical Site**: 50-100 requests
- **Pass Rate**: Very low (~10-20% of sites)

### Signal 2: Transfer Size
- **Checks**: Total transfer bytes > threshold
- **Current Thresholds**:
  - Mobile: >3000 KB (3 MB)
  - Desktop: >3500 KB (3.5 MB)
- **Typical Site**: 1500-2500 KB (1.5-2.5 MB)
- **Pass Rate**: Low (~20-30% of sites)

### Signal 3: Redirects (PSI Audit)
- **Checks**: PSI `redirects` audit score < 1
- **Meaning**: Site has redirect chains that impact performance
- **Pass Rate**: Low (~10-15% of sites have issues)

### Signal 4: Server Response Slow (PSI Audit)
- **Checks**: PSI `server-response-time` audit score < 1
- **Meaning**: TTFB is slow (typically >600ms)
- **Pass Rate**: Low-Medium (~20-30% of sites)

### Signal 5: Render Blocking (PSI Audit)
- **Checks**: PSI `render-blocking-resources` audit score < 1
- **Meaning**: CSS/JS blocking initial render
- **Pass Rate**: Medium (~30-40% of sites)

## Expected Results on Typical Sites

### Scenario 1: Average E-Commerce Site
```
📊 HAR Agent Gating Analysis:
  Device: mobile
  Signal 1 - Request Count: 85 > 150 = ❌ FAIL          ← Below threshold
  Signal 2 - Transfer Size: 2200KB > 3000KB = ❌ FAIL   ← Below threshold
  Signal 3 - Redirects (PSI): ❌ FAIL                    ← No redirects
  Signal 4 - Server Response Slow (PSI): ❌ FAIL         ← Fast server
  Signal 5 - Render Blocking (PSI): ✅ PASS              ← Has blocking resources
  Signals Passed: 1/5 (need 2+)
  HAR Agent: ❌ SKIPPED                                  ← NOT ENOUGH SIGNALS
```

**Result**: HAR agent skipped despite having third-party scripts!

### Scenario 2: Heavy Corporate Site
```
📊 HAR Agent Gating Analysis:
  Device: mobile
  Signal 1 - Request Count: 180 > 150 = ✅ PASS         ← Many requests
  Signal 2 - Transfer Size: 3500KB > 3000KB = ✅ PASS   ← Large transfer
  Signal 3 - Redirects (PSI): ❌ FAIL
  Signal 4 - Server Response Slow (PSI): ❌ FAIL
  Signal 5 - Render Blocking (PSI): ✅ PASS
  Signals Passed: 3/5 (need 2+)
  HAR Agent: ✅ WILL RUN                                 ← RUNS!
```

**Result**: HAR agent runs (3 signals passed)

### Scenario 3: Poorly Optimized Site
```
📊 HAR Agent Gating Analysis:
  Device: mobile
  Signal 1 - Request Count: 120 > 150 = ❌ FAIL         ← Below threshold
  Signal 2 - Transfer Size: 2800KB > 3000KB = ❌ FAIL   ← Below threshold
  Signal 3 - Redirects (PSI): ✅ PASS                    ← Has redirects
  Signal 4 - Server Response Slow (PSI): ✅ PASS         ← Slow TTFB
  Signal 5 - Render Blocking (PSI): ✅ PASS              ← Blocking resources
  Signals Passed: 3/5 (need 2+)
  HAR Agent: ✅ WILL RUN                                 ← RUNS!
```

**Result**: HAR agent runs (3 PSI signals passed, despite low size)

## Testing Instructions

### 1. Run Against Multiple Sites

Test a variety of sites to gather data:

```bash
# Test typical sites
node index.js --url "https://www.example.com" --device mobile --skip-cache 2>&1 | grep -A 10 "HAR Agent Gating"

# Test known heavy sites
node index.js --url "https://www.cnn.com" --device mobile --skip-cache 2>&1 | grep -A 10 "HAR Agent Gating"

# Test optimized sites
node index.js --url "https://web.dev" --device mobile --skip-cache 2>&1 | grep -A 10 "HAR Agent Gating"
```

### 2. Record Results

For each site, note:
- Request count vs threshold
- Transfer size vs threshold
- Which PSI signals passed
- Whether HAR agent ran

### 3. Analyze Patterns

Look for:
- How many sites pass Signal 1 (request count)?
- How many sites pass Signal 2 (transfer size)?
- Which PSI signals are most common?
- What % of sites trigger HAR agent?

## Example Test Results Template

| Site | Requests | Transfer (KB) | Signal 1 | Signal 2 | Signal 3 | Signal 4 | Signal 5 | Total | HAR Runs? |
|------|----------|---------------|----------|----------|----------|----------|----------|-------|-----------|
| example.com | 85 | 2200 | ❌ | ❌ | ❌ | ❌ | ✅ | 1/5 | ❌ |
| cnn.com | 180 | 3500 | ✅ | ✅ | ❌ | ❌ | ✅ | 3/5 | ✅ |
| web.dev | 45 | 800 | ❌ | ❌ | ❌ | ❌ | ❌ | 0/5 | ❌ |

## What This Will Prove

After testing 10-15 sites, you'll see:

1. **If Signal 1 & 2 thresholds are too high**:
   - Most sites will show ❌ for both signals
   - Only very large sites pass

2. **If PSI signals compensate**:
   - Sites may pass via Signal 3/4/5 even if size is low
   - But this is inconsistent (depends on optimization level)

3. **Overall HAR trigger rate**:
   - Expected: 10-20% of typical sites run HAR agent
   - With recommended changes: 70-80% would run

## Recommended Threshold Adjustments (Based on Data)

After confirming current thresholds are too high, implement:

```javascript
const DEFAULT_THRESHOLDS = {
    mobile: {
        REQUESTS: 60,               // Was: 150 → 2.5x lower
        TRANSFER_BYTES: 1_500_000,  // Was: 3MB → 2x lower
    },
    desktop: {
        REQUESTS: 80,               // Was: 180 → 2.25x lower
        TRANSFER_BYTES: 2_000_000,  // Was: 3.5MB → 1.75x lower
    }
};
```

And change to single-signal requirement OR use OR logic for size signals.
