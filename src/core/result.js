/**
 * Result<T> Pattern for Standardized Error Handling
 *
 * Provides a consistent way to handle success and failure cases across all collectors and agents.
 * Inspired by Rust's Result<T, E> and functional programming patterns.
 *
 * @example Success case
 * const result = Result.ok({ data: 'value' }, { source: 'cache' });
 * if (result.isOk()) {
 *   console.log(result.data);
 * }
 *
 * @example Error case
 * const result = Result.err('NETWORK_ERROR', 'Failed to fetch', { url }, true);
 * if (result.isErr()) {
 *   console.error(result.error.message);
 * }
 */
export class Result {
  /**
   * @param {boolean} success - Whether the operation succeeded
   * @param {*} data - The data if successful, null if error
   * @param {Object} error - Error details if failed, null if success
   * @param {Object} metadata - Additional metadata (source, duration, etc.)
   */
  constructor(success, data = null, error = null, metadata = {}) {
    this.success = success;
    this.data = data;
    this.error = error;
    this.metadata = metadata;
  }

  /**
   * Create a successful Result
   * @param {*} data - The successful data
   * @param {Object} metadata - Optional metadata (source, duration, etc.)
   * @returns {Result}
   */
  static ok(data, metadata = {}) {
    return new Result(true, data, null, metadata);
  }

  /**
   * Create an error Result
   * @param {string} code - Error code from ErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} details - Additional error context
   * @param {boolean} isRetryable - Whether this error is retryable
   * @returns {Result}
   */
  static err(code, message, details = {}, isRetryable = false) {
    return new Result(false, null, {
      code,
      message,
      details,
      isRetryable,
      timestamp: new Date().toISOString()
    }, {});
  }

  /**
   * Check if result is successful
   * @returns {boolean}
   */
  isOk() {
    return this.success;
  }

  /**
   * Check if result is an error
   * @returns {boolean}
   */
  isErr() {
    return !this.success;
  }

  /**
   * Get data or throw if error
   * @throws {Error} If result is an error
   * @returns {*} The data
   */
  unwrap() {
    if (!this.success) {
      throw new Error(`Cannot unwrap error result: ${this.error.message}`);
    }
    return this.data;
  }

  /**
   * Get data or return default value if error
   * @param {*} defaultValue - Value to return if error
   * @returns {*} Data or default value
   */
  unwrapOr(defaultValue) {
    return this.success ? this.data : defaultValue;
  }

  /**
   * Map the data to a new value if successful
   * @param {Function} fn - Function to transform data
   * @returns {Result} New Result with transformed data
   */
  map(fn) {
    if (this.success) {
      return Result.ok(fn(this.data), this.metadata);
    }
    return this;
  }

  /**
   * Map the error to a new value if failed
   * @param {Function} fn - Function to transform error
   * @returns {Result} New Result with transformed error
   */
  mapErr(fn) {
    if (!this.success) {
      const newError = fn(this.error);
      return Result.err(newError.code, newError.message, newError.details, newError.isRetryable);
    }
    return this;
  }
}
