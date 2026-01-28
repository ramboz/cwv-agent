import { ChatVertexAI } from '@langchain/google-vertexai';
import { AzureChatOpenAI } from '@langchain/openai';
import { Bedrock } from '@langchain/community/llms/bedrock';
import { getProviderForModel, getTokenLimits } from './config.js';
import { ModelAdapter, modelRegistry } from './model-adapter.js';
import { getConfig } from '../config/index.js';

/**
 * Factory for creating LLM instances with abstraction layer
 */
export class LLMFactory {
  /**
   * Create an LLM instance based on the model name
   * @param {string} model - The model name
   * @param {Object} options - Additional options
   * @returns {ModelAdapter} The model adapter instance
   */
  static createLLM(model, options = {}) {
    // Check if adapter already exists in registry
    const existing = modelRegistry.get(model);
    if (existing && !options.forceNew) {
      return existing;
    }

    const provider = getProviderForModel(model);
    const tokenLimits = getTokenLimits(model);

    // Create base LLM instance
    const llmInstance = this.createBaseLLM(model, provider, tokenLimits);

    // Wrap in adapter
    const adapter = new ModelAdapter(model, llmInstance, options);

    // Setup fallback if configured
    const config = getConfig();
    if (config.models.fallback && config.models.fallback !== model) {
      try {
        const fallbackAdapter = this.createLLM(config.models.fallback, { ...options, forceNew: true });
        adapter.setFallback(fallbackAdapter);
      } catch (error) {
        console.warn(`Failed to create fallback model ${config.models.fallback}:`, error.message);
      }
    }

    // Register adapter
    modelRegistry.register(model, adapter);

    return adapter;
  }

  /**
   * Create base LLM instance without adapter wrapper
   * @param {string} model - Model name
   * @param {string} provider - Provider name
   * @param {Object} tokenLimits - Token limits
   * @returns {Object} Base LLM instance
   */
  static createBaseLLM(model, provider, tokenLimits) {
    switch (provider) {
      case 'gemini':
        // Check for Google Cloud credentials
        if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
          throw new Error('Missing required environment variable: GOOGLE_APPLICATION_CREDENTIALS');
        }
        return new ChatVertexAI({
          model,
          maxOutputTokens: tokenLimits.output,
          temperature: 0, // Deterministic for consistency
          topP: 0.95,
          topK: 40,
          // Use native JSON mode for Gemini 2.5+ models
          ...(model.startsWith('gemini-2.5') && {
            modelKwargs: {
              response_mime_type: "application/json"
            }
          })
        });
      
      case 'openai':
        // Check for Azure OpenAI environment variables
        const requiredAzureVars = [
          'AZURE_OPENAI_API_INSTANCE_NAME',
          'AZURE_OPENAI_API_DEPLOYMENT_NAME',
          'AZURE_OPENAI_API_KEY',
          'AZURE_OPENAI_API_VERSION'
        ];
        
        const missingAzureVars = requiredAzureVars.filter(varName => !process.env[varName]);
        if (missingAzureVars.length > 0) {
          throw new Error(`Missing required environment variables for Azure OpenAI: ${missingAzureVars.join(', ')}`);
        }
        
        const basePath = `https://${process.env.AZURE_OPENAI_API_INSTANCE_NAME}.${model === 'gpt-5' ? 'cognitiveservices' : 'openai'}.azure.com`;
        return new AzureChatOpenAI({
          model,
          ...(model === 'gpt-5'
            ? { max_completion_tokens: tokenLimits.output }
            : {maxTokens: tokenLimits.output}),
          openAIApiKey: process.env.AZURE_OPENAI_API_KEY,
          openAIBasePath: basePath,
          configuration: { basePath }
        });
      
      case 'bedrock':
        // Check for AWS credentials
        const requiredAwsVars = [
          'AWS_ACCESS_KEY_ID',
          'AWS_SECRET_ACCESS_KEY',
          'AWS_REGION',
        ];
        const missingAwsVars = requiredAwsVars.filter(varName => !process.env[varName]);
        if (missingAwsVars.length > 0) {
          throw new Error(`Missing required environment variables for AWS Bedrock: ${missingAwsVars.join(', ')}`);
        }
        
        return new Bedrock({
          model: `anthropic.${model}`,
          maxTokens: tokenLimits.output,
          region: process.env.AWS_REGION || 'us-east-1',
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        });

      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }
} 