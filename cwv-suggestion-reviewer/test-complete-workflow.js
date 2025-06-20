#!/usr/bin/env node

import { SimpleChatWorkflow } from './simple-chat-workflow.js';

async function testCompleteWorkflow() {
  console.log('🧪 **Testing Complete CWV Suggestion Review Workflow**\n');
  
  const args = process.argv.slice(2);
  const suggestionsFile = args[0] || '../.cache/www-ups-com-lasso-ulError.mobile.suggestions.gemini25pro.json';
  
  console.log(`📄 **Using suggestions file:** ${suggestionsFile}\n`);
  
  try {
    const workflow = new SimpleChatWorkflow(suggestionsFile, { dryRun: true });
    
    // Initialize
    console.log('1. **Initializing workflow...**');
    const initialMessage = await workflow.initialize();
    console.log('✅ Workflow initialized successfully');
    console.log(`📊 Loaded ${workflow.suggestions.length} suggestions from ${workflow.baseUrl}\n`);
    
    // Test different commands
    const testCommands = [
      { command: 'summary', description: 'Check initial summary' },
      { command: 'details', description: 'View detailed first suggestion' },
      { command: 'approve', description: 'Approve first suggestion' },
      { command: 'reject', description: 'Reject second suggestion' },
      { command: 'edit', description: 'Start editing third suggestion' },
      { command: 'Change priority to High and update description: This is a critical performance issue that needs immediate attention', description: 'Edit the suggestion' },
      { command: 'skip', description: 'Skip fourth suggestion' },
      { command: 'approve', description: 'Approve fifth suggestion' },
    ];
    
    for (const test of testCommands) {
      console.log(`2. **Testing command: "${test.command}"** (${test.description})`);
      const response = workflow.processInput(test.command);
      
      if (response.includes('❌') || response.includes('Error')) {
        console.log('❌ Command failed');
        console.log(response.substring(0, 200) + '...\n');
      } else {
        console.log('✅ Command executed successfully');
        console.log(response.substring(0, 150) + '...\n');
      }
      
      if (workflow.state === 'completed') {
        console.log('🎯 **Workflow completed early!**');
        break;
      }
    }
    
    // Get final results
    console.log('3. **Final Results:**');
    const approved = workflow.getApprovedSuggestions();
    const finalSummary = workflow.showProgressSummary();
    
    console.log(`✅ **Approved suggestions:** ${approved.length}`);
    console.log(`📝 **Edited suggestions:** ${workflow.edited.length}`);
    console.log(`❌ **Rejected suggestions:** ${workflow.rejected.length}`);
    console.log(`⏭️ **Remaining suggestions:** ${workflow.suggestions.length - workflow.currentIndex}`);
    
    if (approved.length > 0) {
      console.log('\n📋 **Suggestions ready for SpaceCat upload:**');
      approved.forEach((s, i) => {
        console.log(`   ${i + 1}. ${s.title}`);
        console.log(`      └─ ${s.metric} • ${s.priority} priority • ${s.effort} effort`);
      });
    }
    
    console.log('\n🎉 **Test completed successfully!**');
    console.log('\n💡 **Next steps for production:**');
    console.log('   1. Integrate with your AI Chat interface');  
    console.log('   2. Add SpaceCat API integration for approved suggestions');
    console.log('   3. Train your team on the command interface');
    console.log('   4. Set up automated cwv-agent → chat review → SpaceCat pipeline');
    
  } catch (error) {
    console.error('❌ **Test failed:**', error.message);
    console.error(error.stack);
  }
}

// Run the test
testCompleteWorkflow(); 