import { ChatVertexAI } from '@langchain/google-vertexai';
import { AzureChatOpenAI } from '@langchain/openai';
import { Bedrock } from '@langchain/community/llms/bedrock';
import { getProviderForModel, getTokenLimits } from './config.js';

/**
 * Factory for creating LLM instances
 */
export class LLMFactory {
  /**
   * Create an LLM instance based on the model name
   * @param {string} model - The model name
   * @returns {Object} The LLM instance
   */
  static createLLM(model) {
    const provider = getProviderForModel(model);
    const tokenLimits = getTokenLimits(model);
    
    switch (provider) {
      case 'gemini':
        // Check for Google Cloud credentials
        if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
          throw new Error('Missing required environment variable: GOOGLE_APPLICATION_CREDENTIALS');
        }
        return new ChatVertexAI({
          model,
          maxOutputTokens: tokenLimits.output,
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
        
        const basePath = `https://${process.env.AZURE_OPENAI_API_INSTANCE_NAME}.openai.azure.com`;
        return new AzureChatOpenAI({
          model,
          maxTokens: tokenLimits.output,
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