#!/usr/bin/env node

import dotenv from 'dotenv';
import { LLMFactory } from './src/models/llm-factory.js';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

// Load environment variables from .env file
dotenv.config();

console.log('🧪 Testing LLM connection...');
console.log('🔑 GOOGLE_APPLICATION_CREDENTIALS:', process.env.GOOGLE_APPLICATION_CREDENTIALS);

async function testLLM() {
  try {
    // Create LLM instance
    console.log('📡 Creating LLM instance...');
    const llm = LLMFactory.createLLM('gemini-2.5-pro');
    
    // Test with a simple message
    console.log('💬 Sending test message...');
    const messages = [
      new SystemMessage('You are a helpful assistant.'),
      new HumanMessage('Say "Hello, LLM is working!" and nothing else.')
    ];
    
    console.log('⏳ Waiting for response...');
    const startTime = Date.now();
    
    const response = await llm.invoke(messages);
    const endTime = Date.now();
    
    console.log('✅ LLM Response:', response.content);
    console.log(`⏱️  Response time: ${endTime - startTime}ms`);
    console.log('🎉 LLM is working correctly!');
    
  } catch (error) {
    console.error('❌ LLM Test Failed:');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    
    if (error.message.includes('API key')) {
      console.error('🔑 API Key issue detected');
    } else if (error.message.includes('quota')) {
      console.error('📊 Rate limit/quota issue detected');
    } else if (error.message.includes('network')) {
      console.error('🌐 Network issue detected');
    } else {
      console.error('🔍 Unknown error:', error);
    }
  }
}

// Set a timeout for the test
const timeout = setTimeout(() => {
  console.log('⏰ LLM test timeout (30 seconds)');
  process.exit(1);
}, 30000);

testLLM().then(() => {
  clearTimeout(timeout);
  process.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error('💥 Test failed:', error);
  process.exit(1);
});
