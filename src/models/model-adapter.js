import { getConfig } from '../config/index.js';
import { getModelCapabilities } from './config.js';

/**
 * Model capabilities detection and abstraction
 * Derives all values from the centralized config (models/config.js)
 *
 * All capability flags (nativeJSON, supportsTools, etc.) and token limits
 * (maxContextTokens, maxOutputTokens) are exposed as direct properties.
 */
export class ModelCapabilities {
  /**
   * @param {String} modelName - The model identifier
   */
  constructor(modelName) {
    this.modelName = modelName;
    // Expose all capabilities as direct properties on this instance
    Object.assign(this, getModelCapabilities(modelName));
  }

  /**
   * Check if model can handle a specific requirement
   * @param {String} requirement - Requirement key
   * @return {Boolean} Whether the model supports the requirement
   */
  canHandle(requirement) {
    switch (requirement) {
      case 'large_context':
        return this.maxContextTokens >= 500000;
      case 'native_json':
        return this.nativeJSON;
      case 'tools':
        return this.supportsTools;
      case 'vision':
        return this.supportsVision;
      default:
        return false;
    }
  }
}

/**
 * Model adapter with unified interface and fallback support
 */
export class ModelAdapter {
  constructor(modelName, llmInstance, options = {}) {
    this.modelName = modelName;
    this._baseLLM = llmInstance;  // Renamed from 'llm' to avoid confusion
    this.fallbackAdapter = null;
    this.retryAttempts = options.retryAttempts || 2;
    this.retryDelay = options.retryDelay || 1000;

    this.capabilities = new ModelCapabilities(modelName);

    // Track costs
    const config = getConfig();
    this.costs = config.models.costTracking[modelName] || { input: 0, output: 0 };
    this.totalCost = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }

  /**
   * Get the underlying LangChain LLM instance for use with RunnableSequence, bindTools, etc.
   * @returns {Object} The base LLM instance
   */
  getBaseLLM() {
    return this._baseLLM;
  }

  /**
   * Backward compatibility: allow access to base LLM via .llm property
   * @deprecated Use getBaseLLM() instead
   */
  get llm() {
    return this._baseLLM;
  }

  /**
   * Set fallback model adapter
   * @param {ModelAdapter} adapter - Fallback adapter
   */
  setFallback(adapter) {
    this.fallbackAdapter = adapter;
  }

  /**
   * Invoke the model with automatic retries and fallback
   * @param {Array} messages - Messages to send
   * @param {Object} options - Invocation options
   * @returns {Promise<Object>} Model response
   */
  async invoke(messages, options = {}) {
    let lastError = null;

    // Try primary model with retries
    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      try {
        const response = await this._baseLLM.invoke(messages, options);

        // Debug: Log empty generation detection
        if (!response.content && !response.generations?.[0]?.[0]) {
          console.warn('⚠️  Empty generation detected:', {
            hasContent: !!response.content,
            hasGenerations: !!response.generations?.[0]?.[0],
            responseMetadata: response.response_metadata,
            modelName: this.modelName
          });
        }

        // Track token usage and cost
        if (response.response_metadata?.usage) {
          const usage = response.response_metadata.usage;
          this.totalInputTokens += usage.input_tokens || usage.prompt_tokens || 0;
          this.totalOutputTokens += usage.output_tokens || usage.completion_tokens || 0;

          const inputCost = (this.totalInputTokens / 1000) * this.costs.input;
          const outputCost = (this.totalOutputTokens / 1000) * this.costs.output;
          this.totalCost = inputCost + outputCost;
        }

        return response;
      } catch (error) {
        lastError = error;

        // Enhanced error logging with full details
        console.error('❌ LLM invoke failed:', {
          message: error.message,
          errorType: error.constructor.name,
          model: this.modelName,
          attempt: attempt + 1,
          partialResponse: error?.response?.data,
          generations: error?.response?.data?.generations
        });

        // Don't retry on certain errors
        if (this.isNonRetryableError(error)) {
          break;
        }

        // Wait before retry
        if (attempt < this.retryAttempts - 1) {
          await this.sleep(this.retryDelay * (attempt + 1));
        }
      }
    }

    // Try fallback if available
    if (this.fallbackAdapter) {
      console.warn(`Primary model ${this.modelName} failed, trying fallback ${this.fallbackAdapter.modelName}`);
      try {
        return await this.fallbackAdapter.invoke(messages, options);
      } catch (fallbackError) {
        console.error('Fallback model also failed:', fallbackError.message);
        throw lastError; // Throw original error
      }
    }

    throw lastError;
  }

  /**
   * Check if error is non-retryable
   * @param {Error} error - Error object
   * @returns {boolean} True if non-retryable
   */
  isNonRetryableError(error) {
    const message = error.message?.toLowerCase() || '';

    // Authentication errors
    if (message.includes('authentication') || message.includes('api key')) {
      return true;
    }

    // Invalid request errors
    if (message.includes('invalid') || message.includes('bad request')) {
      return true;
    }

    // Context length errors
    if (message.includes('context length') || message.includes('too long')) {
      return true;
    }

    return false;
  }

  /**
   * Get model with structured output
   * @param {Object} schema - Zod or JSON schema
   * @returns {Object} Model with structured output
   */
  withStructuredOutput(schema) {
    if (this.capabilities.nativeJSON) {
      // Use native JSON mode if supported
      return this._baseLLM.withStructuredOutput(schema);
    }

    // Fallback to prompt-based JSON parsing
    console.log(`Model ${this.modelName} doesn't support native JSON, using prompt-based parsing`);
    return this._baseLLM.withStructuredOutput(schema);
  }

  /**
   * Bind tools to the model
   * @param {Array} tools - Tools to bind
   * @returns {Object} Model with tools
   */
  bindTools(tools) {
    if (!this.capabilities.supportsTools) {
      throw new Error(`Model ${this.modelName} doesn't support tool calling`);
    }
    return this._baseLLM.bindTools(tools);
  }

  /**
   * Get cost summary
   * @returns {Object} Cost summary
   */
  getCostSummary() {
    return {
      modelName: this.modelName,
      totalCost: this.totalCost.toFixed(4),
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      costPerInputToken: this.costs.input,
      costPerOutputToken: this.costs.output,
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Model registry for managing available models
 */
export class ModelRegistry {
  constructor() {
    this.adapters = new Map();
  }

  /**
   * Register a model adapter
   * @param {string} modelName - Model name
   * @param {ModelAdapter} adapter - Model adapter
   */
  register(modelName, adapter) {
    this.adapters.set(modelName, adapter);
  }

  /**
   * Get model adapter by name
   * @param {string} modelName - Model name
   * @returns {ModelAdapter|null} Model adapter or null
   */
  get(modelName) {
    return this.adapters.get(modelName) || null;
  }

  /**
   * Get all registered models
   * @returns {Array<string>} Model names
   */
  list() {
    return Array.from(this.adapters.keys());
  }

  /**
   * Find best model for requirements
   * @param {Array<string>} requirements - Required capabilities
   * @returns {ModelAdapter|null} Best matching adapter
   */
  findBestModel(requirements) {
    for (const adapter of this.adapters.values()) {
      const meetsAll = requirements.every(req => adapter.capabilities.canHandle(req));
      if (meetsAll) {
        return adapter;
      }
    }
    return null;
  }

  /**
   * Get total cost across all models
   * @returns {number} Total cost
   */
  getTotalCost() {
    let total = 0;
    for (const adapter of this.adapters.values()) {
      total += adapter.totalCost;
    }
    return total;
  }

  /**
   * Get cost summary for all models
   * @returns {Array<Object>} Cost summaries
   */
  getCostSummaries() {
    return Array.from(this.adapters.values()).map(adapter => adapter.getCostSummary());
  }
}

// Export singleton registry
export const modelRegistry = new ModelRegistry();
