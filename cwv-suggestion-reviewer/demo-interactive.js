#!/usr/bin/env node

import readline from 'readline';
import { SimpleChatWorkflow } from './simple-chat-workflow.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function runInteractiveDemo() {
  const args = process.argv.slice(2);
  const suggestionsFile = args[0];
  const isDryRun = args.includes('--dry-run');
  
  if (!suggestionsFile) {
    console.error('Usage: node demo-interactive.js <suggestions-file.json> [--dry-run]');
    console.error('Example: node demo-interactive.js ../report.suggestions.json --dry-run');
    process.exit(1);
  }
  
  console.log('🎯 **Interactive CWV Suggestion Review Demo**\n');
  
  try {
    const workflow = new SimpleChatWorkflow(suggestionsFile, { dryRun: isDryRun });
    let message = await workflow.initialize();
    
    console.log(message);
    console.log('\n' + '='.repeat(80));
    
    // Interactive loop
    while (workflow.state !== 'completed') {
      const userInput = await askQuestion('\n👤 **Your command:** ');
      
      if (userInput.toLowerCase() === 'quit' || userInput.toLowerCase() === 'exit') {
        console.log('\n👋 **Demo ended. Thanks for testing!**');
        break;
      }
      
      const response = workflow.processInput(userInput);
      console.log('\n🤖 **AI Response:**');
      console.log(response);
      console.log('\n' + '='.repeat(80));
      
      if (workflow.state === 'completed') {
        console.log('\n🎉 **Workflow Complete!**');
        const approved = workflow.getApprovedSuggestions();
        if (approved.length > 0) {
          console.log(`\n📋 **${approved.length} suggestions ready for SpaceCat upload:**`);
          approved.forEach((s, i) => {
            console.log(`   ${i + 1}. ${s.title} (${s.metric}, ${s.priority} priority)`);
          });
        }
        break;
      }
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    rl.close();
  }
}

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

// Run the demo
runInteractiveDemo(); 