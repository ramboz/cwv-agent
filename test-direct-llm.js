#!/usr/bin/env node

import dotenv from 'dotenv';
import { ChatVertexAI } from '@langchain/google-vertexai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

// Load environment variables
dotenv.config();

console.log('🧪 Testing Direct LLM with CWV Analysis...');

async function testDirectCWV() {
  try {
    // Create LLM instance directly
    console.log('📡 Creating LLM instance...');
    const llm = new ChatVertexAI({
      model: 'gemini-2.5-pro',
      maxOutputTokens: 65535,
    });
    
    // Test with a simple CWV analysis prompt
    console.log('💬 Sending CWV analysis prompt...');
    const messages = [
      new SystemMessage('You are a Core Web Vitals performance expert. Analyze the given data and provide specific, actionable suggestions for improving LCP, CLS, and INP metrics.'),
      new HumanMessage(`
Analyze this Core Web Vitals data and provide 3-5 specific suggestions for improvement:

URL: https://www.krisshop.com/en/store/preorder
Device: Desktop

CrUX Data:
- LCP: 4.1s (Poor)
- CLS: 0.677 (Poor) 
- INP: 670ms (Poor)

PSI Data:
- Performance Score: 30/100
- LCP: 4.1s
- CLS: 0.677
- TBT: 670ms

Please provide specific, actionable suggestions with implementation details.
      `)
    ];
    
    console.log('⏳ Waiting for response...');
    const startTime = Date.now();
    
    const response = await llm.invoke(messages);
    const endTime = Date.now();
    
    console.log('✅ LLM Response:');
    console.log('='.repeat(50));
    console.log(response.content);
    console.log('='.repeat(50));
    console.log(`⏱️  Response time: ${endTime - startTime}ms`);
    console.log('🎉 Direct CWV analysis completed successfully!');
    
  } catch (error) {
    console.error('❌ Direct CWV Test Failed:');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
  }
}

// Set a timeout for the test
const timeout = setTimeout(() => {
  console.log('⏰ Direct CWV test timeout (2 minutes)');
  process.exit(1);
}, 120000);

testDirectCWV().then(() => {
  clearTimeout(timeout);
  process.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error('💥 Test failed:', error);
  process.exit(1);
});
