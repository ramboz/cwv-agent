/**
 * Model configuration for different LLM providers
 */

// Model token limits
export const MAX_TOKENS = {
  // Gemini models
  'gemini-2.5-pro-preview-05-06': { input: 1_048_576, output: 65_535 },
  'gemini-2.5-flash-preview-05-20	': { input: 1_048_576, output: 65_535 },
  
  // OpenAI models
  'gpt-4.1': { input: 1_048_576, output: 32_768 },
  'gpt-4o': { input: 128_000, output: 4_096 },
  
  // Claude models via Amazon Bedrock
  'claude-3-7-sonnet-20250219': { input: 200_000, output: 128_000 },
};

// Default model
export const DEFAULT_MODEL = 'gemini-2.5-pro-preview-05-06';

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