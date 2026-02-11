/**
 * Model configuration for different LLM providers
 * Updated February 2026
 *
 * This is the SINGLE SOURCE OF TRUTH for model token limits, provider mappings,
 * and capability flags. All other modules derive from these definitions.
 */

// ============================================================================
// Model token limits
// ============================================================================

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

// ============================================================================
// Provider types and detection
// ============================================================================

export const PROVIDERS = {
  GEMINI: 'gemini',
  OPENAI: 'openai',
  BEDROCK: 'bedrock',
};

/**
 * Model name prefix → provider mapping
 * Order matters: more specific prefixes should come first
 */
const MODEL_PREFIX_TO_PROVIDER = [
  { prefix: 'gemini', provider: PROVIDERS.GEMINI },
  { prefix: 'gpt', provider: PROVIDERS.OPENAI },
  { prefix: 'o1', provider: PROVIDERS.OPENAI },
  { prefix: 'o3', provider: PROVIDERS.OPENAI },
  { prefix: 'claude', provider: PROVIDERS.BEDROCK },
];

/**
 * Get the provider for a given model
 * @param {String} model - The model name
 * @return {String} The provider name
 */
export function getProviderForModel(model) {
  for (const { prefix, provider } of MODEL_PREFIX_TO_PROVIDER) {
    if (model.startsWith(prefix)) {
      return provider;
    }
  }
  throw new Error(`Unknown model: ${model}`);
}

// ============================================================================
// Model capabilities (non-token features)
// ============================================================================

/**
 * Provider-level capability defaults
 * These apply to all models from a given provider unless overridden
 */
const PROVIDER_CAPABILITIES = {
  [PROVIDERS.GEMINI]: {
    nativeJSON: true,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
  },
  [PROVIDERS.OPENAI]: {
    nativeJSON: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
  },
  [PROVIDERS.BEDROCK]: {
    nativeJSON: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
  },
};

/**
 * Model-specific capability overrides (exceptions to provider defaults)
 * Only list models that differ from their provider defaults
 */
const MODEL_CAPABILITY_OVERRIDES = {
  // Gemini 1.5 and experimental models don't support native JSON
  'gemini-1.5-flash': { nativeJSON: false },
  'gemini-exp-1206': { nativeJSON: false },

  // OpenAI reasoning models support native JSON but not tool calling
  'o1': { nativeJSON: true, supportsTools: false },
  'o1-mini': { nativeJSON: true, supportsTools: false },
  'o3-mini': { nativeJSON: true, supportsTools: false },
};

/** Default capability fallbacks for unknown providers */
const DEFAULT_CAPABILITIES = {
  nativeJSON: false,
  supportsTools: true,
  supportsStreaming: true,
  supportsVision: false,
};

/** Default token limits for unknown models */
const DEFAULT_TOKEN_LIMITS = { input: 128_000, output: 4_096 };

/**
 * Get full capabilities for a model (token limits + feature flags)
 * Merges: default → provider defaults → model overrides → token limits
 *
 * @param {String} model - The model name
 * @return {Object} Complete capabilities object
 */
export function getModelCapabilities(model) {
  const tokenLimits = MAX_TOKENS[model] || DEFAULT_TOKEN_LIMITS;

  let providerDefaults = DEFAULT_CAPABILITIES;
  try {
    const provider = getProviderForModel(model);
    providerDefaults = PROVIDER_CAPABILITIES[provider] || DEFAULT_CAPABILITIES;
  } catch {
    // Unknown provider — use defaults
    console.warn(`getModelCapabilities: unknown provider for model "${model}", using defaults`);
  }

  const modelOverrides = MODEL_CAPABILITY_OVERRIDES[model] || {};

  return {
    ...DEFAULT_CAPABILITIES,
    ...providerDefaults,
    ...modelOverrides,
    maxContextTokens: tokenLimits.input,
    maxOutputTokens: tokenLimits.output,
  };
}

/**
 * Get the token limits for a model
 * @param {String} model - The model name
 * @return {Object} The token limits { input, output }
 */
export function getTokenLimits(model) {
  if (!MAX_TOKENS[model]) {
    throw new Error(`Unknown model: ${model}`);
  }
  return MAX_TOKENS[model];
}