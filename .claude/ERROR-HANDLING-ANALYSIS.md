# Error Handling & Dead Code Analysis

**Date**: January 29, 2026
**Phases**: Phase 4 (Error Handling) + Phase 6 (Dead Code Cleanup)

---

## Current State Analysis

### Error Handling Statistics

Across the entire `src/` codebase:
- **Try-catch blocks**: 75
- **Throw statements**: 38
- **Return null**: 66
- **Console.error**: 31
- **Empty catch blocks**: 13 (⚠️ PROBLEMATIC)

### Files with Empty/Ignored Catch Blocks (HIGH PRIORITY)

These files silently swallow errors, making debugging difficult:

1. **config/index.js**: 1 empty catch
2. **core/multi-agents/suggestions-engine.js**: 1 empty catch
3. **core/multi-agents/utils/json-parser.js**: 1 empty catch
4. **rules/critical-path/thirdparty.js**: 1 empty catch
5. **tools/aem.js**: 1 empty catch
6. **tools/lab/cls-attributor.js**: 3 empty catches
7. **tools/lab/index.js**: 3 empty catches
8. **utils.js**: 2 empty catches

**Total**: 13 empty catch blocks that need attention

### Dead Code Analysis

#### TODOs/FIXMEs
- **Total found**: 1
- **Location**: `src/rules/critical-path/thirdparty.js:26` - "TODO understand why this happens"

#### Commented-Out Code
Found in:
- `src/tools/merge.js` (lines 68-71): 4 lines of network timing code
- `src/core/validator.js` (lines 104-107): 4 lines of console.log debugging
- `src/core/agent.js` (lines 107-119): ~13 lines of old LLM invocation code

#### Old Backup Files
- `src/tools/lab/har-collector.old.js` (should be removed)
- `src/tools/lab/coverage-collector.old.js` (should be removed)

---

## Error Handling Patterns Found

### Pattern 1: Silent Failures (WORST)
```javascript
try {
  // operation
} catch (e) {
  // EMPTY - error silently ignored
}
```
**Problem**: Errors disappear completely, making debugging impossible
**Found in**: 13 files

### Pattern 2: Console-Only Error Handling
```javascript
try {
  // operation
} catch (error) {
  console.error('Error:', error);
  return null;
}
```
**Problem**: Errors logged but lost, no structured error info for callers
**Found in**: ~31 instances

### Pattern 3: Return Null on Error
```javascript
try {
  // operation
  return result;
} catch (error) {
  return null;
}
```
**Problem**: Caller can't distinguish between "not found" vs "error occurred"
**Found in**: ~66 instances

### Pattern 4: Throw and Hope (BETTER)
```javascript
async function getData() {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}
```
**Problem**: No structured error info, caller must catch and handle
**Found in**: ~38 instances

---

## Recommended Error Handling Strategy

### Option A: Result Pattern (RECOMMENDED)

Inspired by Rust's `Result<T, E>` type, provides explicit success/failure handling.

#### Implementation

```javascript
// src/utils/result.js
export class Result {
  constructor(value, error) {
    this._value = value;
    this._error = error;
  }

  static ok(value) {
    return new Result(value, null);
  }

  static err(error) {
    return new Result(null, error);
  }

  isOk() {
    return this._error === null;
  }

  isErr() {
    return this._error !== null;
  }

  unwrap() {
    if (this.isErr()) {
      throw new Error(`Called unwrap() on Error: ${this._error.message}`);
    }
    return this._value;
  }

  unwrapOr(defaultValue) {
    return this.isOk() ? this._value : defaultValue;
  }

  map(fn) {
    return this.isOk() ? Result.ok(fn(this._value)) : this;
  }

  mapErr(fn) {
    return this.isErr() ? Result.err(fn(this._error)) : this;
  }

  get value() {
    return this._value;
  }

  get error() {
    return this._error;
  }
}

// Helper for async functions
export async function tryAsync(fn) {
  try {
    const result = await fn();
    return Result.ok(result);
  } catch (error) {
    return Result.err(error);
  }
}

// Helper for sync functions
export function trySync(fn) {
  try {
    const result = fn();
    return Result.ok(result);
  } catch (error) {
    return Result.err(error);
  }
}
```

#### Usage Examples

**Before** (silent failure):
```javascript
async function fetchData(url) {
  try {
    const response = await fetch(url);
    return response.json();
  } catch (e) {
    // Empty catch - error lost
  }
}

// Caller has no idea if error occurred
const data = await fetchData(url);
if (!data) {
  // Was there an error? Or just no data?
}
```

**After** (explicit error handling):
```javascript
import { Result, tryAsync } from '../utils/result.js';

async function fetchData(url) {
  return tryAsync(async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  });
}

// Caller knows exactly what happened
const result = await fetchData(url);
if (result.isOk()) {
  console.log('Success:', result.value);
} else {
  console.error('Failed:', result.error.message);
}

// Or use unwrapOr for fallback
const data = result.unwrapOr({ default: 'fallback' });
```

### Option B: Standardized Error Classes

Create domain-specific error types for better error handling.

```javascript
// src/utils/errors.js
export class CWVAgentError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

export class DataCollectionError extends CWVAgentError {
  constructor(message, details) {
    super(message, 'DATA_COLLECTION_ERROR', details);
  }
}

export class ValidationError extends CWVAgentError {
  constructor(message, details) {
    super(message, 'VALIDATION_ERROR', details);
  }
}

export class LLMError extends CWVAgentError {
  constructor(message, details) {
    super(message, 'LLM_ERROR', details);
  }
}
```

---

## Implementation Plan

### Phase 4: Error Handling

#### Step 1: Create Result Utility ✅ (Design Ready)
- [ ] Create `src/utils/result.js`
- [ ] Add `Result` class with `ok()`, `err()`, `isOk()`, `isErr()`, `unwrap()`, `unwrapOr()`
- [ ] Add `tryAsync()` and `trySync()` helpers
- [ ] Add JSDoc documentation

#### Step 2: Fix Empty Catch Blocks (HIGH PRIORITY)
Fix all 13 empty catch blocks:

**config/index.js** (1 instance):
- [ ] Review empty catch and add proper error handling or logging

**core/multi-agents/suggestions-engine.js** (1 instance):
- [ ] Review JSON parsing catch block
- [ ] Return Result instead of silent failure

**core/multi-agents/utils/json-parser.js** (1 instance):
- [ ] Add error logging for JSON parse failures
- [ ] Return Result with error details

**rules/critical-path/thirdparty.js** (1 instance):
- [ ] Resolve "TODO understand why this happens"
- [ ] Add proper error handling

**tools/aem.js** (1 instance):
- [ ] Add error logging or return Result

**tools/lab/cls-attributor.js** (3 instances):
- [ ] Review all 3 empty catches
- [ ] Add error logging or return Result

**tools/lab/index.js** (3 instances):
- [ ] Review all 3 empty catches (likely browser evaluation errors)
- [ ] Add error logging with context

**utils.js** (2 instances):
- [ ] Review both empty catches
- [ ] Add error logging

#### Step 3: Standardize Error Responses (MEDIUM PRIORITY)
Convert key functions to use Result pattern:

**Data Collectors** (highest value):
- [ ] `src/tools/psi.js` - PSI data fetching
- [ ] `src/tools/crux.js` - CrUX data fetching
- [ ] `src/tools/rum.js` - RUM data fetching
- [ ] `src/tools/lab/index.js` - Lab data collection

**Core Logic**:
- [ ] `src/core/collect.js` - Data collection orchestration
- [ ] `src/core/validator.js` - Validation logic
- [ ] `src/core/multi-agents/suggestions-engine.js` - LLM invocations

#### Step 4: Add Error Context (OPTIONAL)
- [ ] Add structured error details (file, line, operation)
- [ ] Add error categorization (retryable vs fatal)
- [ ] Add error codes for programmatic handling

### Phase 6: Dead Code Cleanup

#### Step 1: Remove Old Backup Files
- [ ] Delete `src/tools/lab/har-collector.old.js`
- [ ] Delete `src/tools/lab/coverage-collector.old.js`

#### Step 2: Clean Up Commented Code
- [ ] Review `src/tools/merge.js` lines 68-71 (network timing) - delete if not needed
- [ ] Review `src/core/validator.js` lines 104-107 (debug logs) - delete if not needed
- [ ] Review `src/core/agent.js` lines 107-119 (old LLM code) - delete if not needed

#### Step 3: Resolve TODOs
- [ ] Fix `src/rules/critical-path/thirdparty.js:26` - "TODO understand why this happens"
  - Investigate the root cause
  - Add proper error handling
  - Document or remove the TODO

---

## Success Criteria

### Phase 4: Error Handling
- ✅ Zero empty catch blocks (down from 13)
- ✅ Result utility created and documented
- ✅ Key data collectors return Result instead of null
- ✅ All errors are logged with context
- ✅ Callers can distinguish "not found" from "error"

### Phase 6: Dead Code
- ✅ Zero `.old.js` backup files
- ✅ Zero commented-out code blocks
- ✅ Zero unresolved TODOs
- ✅ Cleaner, more maintainable codebase

---

## Priority Order

### High Priority (Do First)
1. ✅ Fix 13 empty catch blocks (debugging nightmare)
2. ✅ Create Result utility pattern
3. ✅ Remove .old.js backup files

### Medium Priority (Do Next)
4. ✅ Convert data collectors to use Result
5. ✅ Clean up commented code
6. ✅ Resolve TODO

### Low Priority (Nice to Have)
7. ⚠️ Add structured error classes
8. ⚠️ Add error categorization (retryable/fatal)

---

## Testing Strategy

### Before Refactoring
1. Run full test suite: `npm test`
2. Capture baseline: all tests passing

### During Refactoring
1. Fix one file at a time
2. Run tests after each file
3. Verify backward compatibility

### After Refactoring
1. Run full test suite again
2. Test error scenarios manually
3. Verify error messages are helpful

---

## Estimated Impact

### Error Handling Improvements
- **Better Debugging**: Errors no longer silently disappear
- **Better UX**: Meaningful error messages for users
- **Better Reliability**: Callers can handle errors gracefully
- **Better Monitoring**: Structured errors can be tracked/alerted

### Dead Code Cleanup
- **Reduced Complexity**: ~20-30 lines removed
- **Less Confusion**: No more "why is this commented out?"
- **Faster Onboarding**: Cleaner code for new developers

---

## Next Steps

1. Review and approve this plan
2. Create `src/utils/result.js` utility
3. Fix empty catch blocks (one file at a time)
4. Remove dead code
5. Test thoroughly
6. Document new error handling patterns in README

---

## Files to Modify

### Create New:
- `src/utils/result.js` (Result pattern utility)

### Fix Empty Catches (13 files):
- `src/config/index.js`
- `src/core/multi-agents/suggestions-engine.js`
- `src/core/multi-agents/utils/json-parser.js`
- `src/rules/critical-path/thirdparty.js`
- `src/tools/aem.js`
- `src/tools/lab/cls-attributor.js`
- `src/tools/lab/index.js`
- `src/utils.js`

### Remove Dead Code (3 files):
- `src/tools/merge.js`
- `src/core/validator.js`
- `src/core/agent.js`

### Delete Backups (2 files):
- `src/tools/lab/har-collector.old.js`
- `src/tools/lab/coverage-collector.old.js`

**Total**: 1 new file, 13 fixes, 3 cleanups, 2 deletions = **19 file changes**
