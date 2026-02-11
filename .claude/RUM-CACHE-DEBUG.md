# RUM Cache Issue Investigation

## Issue Reported
User reported: "The --skip-cache option does not seem to work with the RUM bundles collection"

## Investigation Results

### Code Flow Analysis

I traced the complete call chain for `--skip-cache` flag:

1. **CLI Parsing** (`index.js:16`)
   - `const skipCache = argv.skipCache;`
   - ✅ Flag is correctly extracted from CLI arguments

2. **processUrl** (`src/core/actions.js:63`)
   - Options object includes `skipCache` correctly
   - ✅ Passed to `runAgentFlow()` for agent action
   - ✅ Passed to `collecetAction()` for collect action

3. **getRUM** (`src/core/collect.js:31`)
   - `await collectRUMData(pageUrl, deviceType, options);`
   - ✅ Options object passed through unchanged

4. **collectRUMData** (`src/tools/rum.js:15`)
   - `const { skipCache = false, rumDomainKey = null, daysBack = 7 } = options;`
   - ✅ Destructuring appears correct

5. **Cache Check** (`src/tools/rum.js:26-31`)
   ```javascript
   if (!skipCache) {
     const cached = getCachedResults(url, deviceType, 'rum');
     if (cached) {
       return { data: cached, fromCache: true };
     }
   }
   ```
   - ✅ Logic appears correct: only read cache when skipCache is false

### Hypothesis

The code flow looks correct, so the issue might be:

**Option A**: The `skipCache` value is not being properly passed in the options object
- Possible destructuring issue
- Options object might be undefined or malformed

**Option B**: Cache file always exists and is always returned
- Need to verify cache file timestamps
- getCachedResults might have a bug

**Option C**: Console messages are misleading
- Cache is actually being skipped
- But console message says "Loaded from cache"
- User perception issue, not actual bug

## Debug Logging Added

I added temporary debug logging to `src/tools/rum.js` to help diagnose:

```javascript
// Line 17-18: At start of function
console.log('[RUM DEBUG] skipCache:', skipCache, 'options:', JSON.stringify(options));

// Line 29-30: When returning cached data
console.log('[RUM DEBUG] Returning cached data');

// Line 32-33: When skipping cache
console.log('[RUM DEBUG] Skipping cache as requested');
```

## Testing Instructions

### Test 1: Verify skipCache is being passed

Run with --skip-cache flag:
```bash
node index.js --action collect \
  --url https://www.krisshop.com/en \
  --device mobile \
  --rum-domain-key YOUR_KEY \
  --skip-cache
```

**Expected Debug Output:**
```
[RUM DEBUG] skipCache: true options: {"skipCache":true,"rumDomainKey":"..."}
[RUM DEBUG] Skipping cache as requested
Fetching RUM data for www.krisshop.com from last 7 days...
  ✓ 2026-01-26: X bundles
  ...
✅ Processed RUM data. Estimated token size: ~ XXX
```

**If Bug Exists, You'll See:**
```
[RUM DEBUG] skipCache: false options: {"rumDomainKey":"..."}
[RUM DEBUG] Returning cached data
✓ Loaded RUM data from cache. Estimated token size: ~ XXX
```

### Test 2: Verify cache file timestamps

Before running test:
```bash
ls -lh .cache/*rum.json
```

Note the timestamp. Then run with `--skip-cache`. Check timestamp again - it should update if cache was bypassed.

### Test 3: Compare with other collectors

Test PSI (known working):
```bash
node index.js --action collect \
  --url https://www.krisshop.com/en \
  --device mobile \
  --skip-cache
```

Check if PSI shows "✅ Processed PSI data" or "✓ Loaded PSI data from cache"

## Possible Root Causes

Based on code analysis, most likely issues:

1. **Options object not including skipCache** (70% probability)
   - Maybe only some actions pass it through
   - Check if `--action agent` vs `--action collect` behave differently

2. **Default value shadowing** (20% probability)
   - Destructuring `const { skipCache = false }` always uses default
   - Options object might have `skipCache: undefined` instead of `skipCache: true`

3. **getCachedResults ignoring null return** (10% probability)
   - Cache function might return stale data even when file missing

## Next Steps

1. **Run Test 1** with debug logging enabled
2. **Examine debug output** to see actual skipCache value
3. **Based on output**:
   - If skipCache is false: Find where options object loses the flag
   - If skipCache is true but cache still used: Bug in getCachedResults
   - If skipCache is true and cache skipped: Console message bug

## Cleanup

Once issue is resolved, remove debug logging:
- `src/tools/rum.js` lines 17-18, 29-30, 32-33

## File Modified

- `src/tools/rum.js` - Added temporary debug logging
