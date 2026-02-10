/**
 * Model configuration for different LLM providers
 * Updated January 2026
 */

// Model token limits
export const MAX_TOKENS = {
  // Gemini models (Google Vertex AI)
  // Note: Increased output from 8_192 to 16_384 for v1.0 - synthesis needs ~4000-5000 tokens for 5-7 suggestions
  'gemini-2.5-pro': { input: 2_000_000, output: 16_384 },
  'gemini-2.5-pro-preview-05-06': { input: 1_048_576, output: 65_535 }, // Legacy preview
  'gemini-2.5-flash': { input: 1_000_000, output: 8_192 },
  'gemini-2.5-flash-preview-05-20': { input: 1_048_576, output: 65_535 }, // Legacy preview
  'gemini-1.5-flash': { input: 1_000_000, output: 8_192 }, // Still supported
  'gemini-exp-1206': { input: 2_000_000, output: 8_192 }, // Experimental 2.0 Flash Thinking

  // OpenAI models (Azure)
  'o1': { input: 200_000, output: 100_000 }, // Latest reasoning model
  'o1-mini': { input: 128_000, output: 65_536 }, // Faster reasoning
  'gpt-4o': { input: 128_000, output: 16_384 }, // Updated output limit
  'gpt-4o-mini': { input: 128_000, output: 16_384 },
  'o3-mini': { input: 200_000, output: 100_000 }, // Latest (if available)

  // Legacy OpenAI models (deprecated, will be removed)
  'gpt-5': { input: 227_000, output: 128_000 }, // Deprecated - use o1 instead
  'gpt-4.1': { input: 1_048_576, output: 32_768 }, // Deprecated
  'gpt-o3': { input: 1_048_576, output: 32_768 }, // Deprecated

  // Claude models via Amazon Bedrock
  'claude-opus-4-5-20251101': { input: 200_000, output: 16_000 }, // Latest Opus
  'claude-sonnet-4-5-20250929': { input: 200_000, output: 16_000 }, // Latest Sonnet (this is Claude Sonnet 4.5)
  'claude-3-7-sonnet-20250219': { input: 200_000, output: 128_000 }, // Previous version
  'claude-haiku-4-0-20250514': { input: 200_000, output: 16_000 }, // Latest Haiku
};

// Default model - Use gemini-2.5-pro for best balance of performance and cost
export const DEFAULT_MODEL = 'gemini-2.5-pro';

// Model provider types
export const PROVIDERS = {
  GEMINI: 'gemini',
  OPENAI: 'openai',
  BEDROCK: 'bedrock',
};

/**
 * Get the provider for a given model
 * @param {string} model - The model name
 * @returns {string} The provider name
 */
export function getProviderForModel(model) {
  if (model.startsWith('gemini-')) {
    return PROVIDERS.GEMINI;
  } else if (model.startsWith('gpt-')) {
    return PROVIDERS.OPENAI;
  } else if (model.startsWith('claude-')) {
    return PROVIDERS.BEDROCK;
  }
  throw new Error(`Unknown model: ${model}`);
}

/**
 * Get the token limits for a model
 * @param {string} model - The model name
 * @returns {Object} The token limits
 */
export function getTokenLimits(model) {
  if (!MAX_TOKENS[model]) {
    throw new Error(`Unknown model: ${model}`);
  }
  return MAX_TOKENS[model];
} 