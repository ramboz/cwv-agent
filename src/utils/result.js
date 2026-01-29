/**
 * Result Pattern for Explicit Error Handling
 *
 * Inspired by Rust's Result<T, E> type, this provides a way to handle errors
 * explicitly without throwing exceptions or returning null/undefined.
 *
 * @example
 * // Async operation
 * async function fetchData(url) {
 *   return tryAsync(async () => {
 *     const response = await fetch(url);
 *     if (!response.ok) {
 *       throw new Error(`HTTP ${response.status}`);
 *     }
 *     return response.json();
 *   });
 * }
 *
 * const result = await fetchData(url);
 * if (result.isOk()) {
 *   console.log('Data:', result.value);
 * } else {
 *   console.error('Error:', result.error.message);
 * }
 *
 * @example
 * // Sync operation
 * function parseJSON(text) {
 *   return trySync(() => JSON.parse(text));
 * }
 *
 * const result = parseJSON(jsonString);
 * const data = result.unwrapOr({ default: 'value' });
 */

export class Result {
  /**
   * Creates a Result instance (use Result.ok() or Result.err() instead)
   * @private
   * @param {*} value - The success value
   * @param {Error|null} error - The error (if any)
   */
  constructor(value, error) {
    this._value = value;
    this._error = error;
  }

  /**
   * Creates a successful Result
   * @param {*} value - The success value
   * @returns {Result}
   */
  static ok(value) {
    return new Result(value, null);
  }

  /**
   * Creates an error Result
   * @param {Error|string} error - The error (will be wrapped in Error if string)
   * @returns {Result}
   */
  static err(error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return new Result(null, err);
  }

  /**
   * Checks if this is a successful result
   * @returns {boolean}
   */
  isOk() {
    return this._error === null;
  }

  /**
   * Checks if this is an error result
   * @returns {boolean}
   */
  isErr() {
    return this._error !== null;
  }

  /**
   * Returns the value if Ok, throws if Err
   * @throws {Error} If this is an error result
   * @returns {*}
   */
  unwrap() {
    if (this.isErr()) {
      throw new Error(`Called unwrap() on Error: ${this._error.message}`);
    }
    return this._value;
  }

  /**
   * Returns the value if Ok, or a default value if Err
   * @param {*} defaultValue - The default value to return on error
   * @returns {*}
   */
  unwrapOr(defaultValue) {
    return this.isOk() ? this._value : defaultValue;
  }

  /**
   * Returns the value if Ok, or computes a default from error if Err
   * @param {function(Error): *} fn - Function to compute default from error
   * @returns {*}
   */
  unwrapOrElse(fn) {
    return this.isOk() ? this._value : fn(this._error);
  }

  /**
   * Maps the value if Ok, passes through if Err
   * @param {function(*): *} fn - Transform function
   * @returns {Result}
   */
  map(fn) {
    return this.isOk() ? Result.ok(fn(this._value)) : this;
  }

  /**
   * Maps the error if Err, passes through if Ok
   * @param {function(Error): Error} fn - Transform function
   * @returns {Result}
   */
  mapErr(fn) {
    return this.isErr() ? Result.err(fn(this._error)) : this;
  }

  /**
   * Chains another Result-returning operation if Ok
   * @param {function(*): Result} fn - Function returning a Result
   * @returns {Result}
   */
  andThen(fn) {
    return this.isOk() ? fn(this._value) : this;
  }

  /**
   * Gets the success value (or null if error)
   * @returns {*|null}
   */
  get value() {
    return this._value;
  }

  /**
   * Gets the error (or null if success)
   * @returns {Error|null}
   */
  get error() {
    return this._error;
  }

  /**
   * Converts to a plain object for serialization
   * @returns {{ok: boolean, value: *, error: string|null}}
   */
  toJSON() {
    return {
      ok: this.isOk(),
      value: this._value,
      error: this._error ? this._error.message : null
    };
  }
}

/**
 * Wraps an async function to return Result instead of throwing
 * @param {function(): Promise<*>} fn - Async function to wrap
 * @returns {Promise<Result>}
 *
 * @example
 * const result = await tryAsync(async () => {
 *   const data = await fetchData();
 *   return processData(data);
 * });
 */
export async function tryAsync(fn) {
  try {
    const result = await fn();
    return Result.ok(result);
  } catch (error) {
    return Result.err(error);
  }
}

/**
 * Wraps a sync function to return Result instead of throwing
 * @param {function(): *} fn - Sync function to wrap
 * @returns {Result}
 *
 * @example
 * const result = trySync(() => JSON.parse(text));
 * if (result.isErr()) {
 *   console.error('Parse failed:', result.error);
 * }
 */
export function trySync(fn) {
  try {
    const result = fn();
    return Result.ok(result);
  } catch (error) {
    return Result.err(error);
  }
}

/**
 * Combines multiple Results into one
 * Returns Ok with array of values if all are Ok
 * Returns Err with first error if any are Err
 * @param {Result[]} results - Array of Results
 * @returns {Result}
 *
 * @example
 * const results = [result1, result2, result3];
 * const combined = Result.all(results);
 * if (combined.isOk()) {
 *   const [val1, val2, val3] = combined.value;
 * }
 */
Result.all = function(results) {
  const values = [];
  for (const result of results) {
    if (result.isErr()) {
      return result;
    }
    values.push(result.value);
  }
  return Result.ok(values);
};

/**
 * Returns the first Ok result, or the last Err if all are Err
 * @param {Result[]} results - Array of Results
 * @returns {Result}
 *
 * @example
 * const result = Result.any([
 *   trySync(() => parseJSON(text)),
 *   trySync(() => parseXML(text)),
 *   Result.ok({ default: 'fallback' })
 * ]);
 */
Result.any = function(results) {
  let lastErr = null;
  for (const result of results) {
    if (result.isOk()) {
      return result;
    }
    lastErr = result;
  }
  return lastErr || Result.err(new Error('No results provided'));
};
