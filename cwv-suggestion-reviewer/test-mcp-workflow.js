#!/usr/bin/env node

import { CWVSuggestionManager } from './mcp-server.js';

async function testMCPWorkflow() {
  console.log('🧪 **Testing MCP Workflow**\n');
  
  const manager = new CWVSuggestionManager();
  
  // 1. Load suggestions
  console.log('1. Loading suggestions...');
  const loadResult = manager.loadSuggestions('../.cache/www-ups-com-lasso-ulError.mobile.suggestions.gemini25pro.json');
  if (!loadResult.success) {
    console.error('❌ Failed to load suggestions:', loadResult.error);
    return;
  }
  
  console.log(`✅ Loaded ${loadResult.totalSuggestions} suggestions from ${loadResult.url}\n`);
  console.log('📊 **Summary by Priority:**');
  Object.entries(loadResult.summary).forEach(([priority, suggestions]) => {
    if (suggestions.length > 0) {
      console.log(`**${priority} Priority (${suggestions.length}):**`);
      suggestions.forEach(s => {
        console.log(`   ${s.index}. ${s.title} - ${s.metric} (${s.effort} effort)`);
      });
    }
  });
  
  // 2. Create editor for first suggestion
  console.log('\n2. Creating editor for suggestion 1...');
  const editorResult = manager.createSuggestionEditor('1');
  if (!editorResult.success) {
    console.error('❌ Failed to create editor:', editorResult.error);
    return;
  }
  
  console.log(`✅ ${editorResult.message}`);
  console.log(`📝 Editor file: ${editorResult.filePath}\n`);
  
  // Show the generated markdown content
  console.log('📖 **Generated markdown content:**');
  console.log('-'.repeat(80));
  
  const fs = await import('fs');
  const content = fs.readFileSync(editorResult.filePath, 'utf8');
  console.log(content.substring(0, 500) + '...\n');
  
  // 3. Simulate editing by modifying the file
  console.log('3. Simulating user edits...');
  const editedContent = content.replace(
    'Several JavaScript files are loaded synchronously',
    'CRITICAL ISSUE: Several JavaScript files are loaded synchronously'
  ).replace(
    'High',
    'Critical'
  );
  
  fs.writeFileSync(editorResult.filePath, editedContent);
  console.log('✅ Simulated editing the markdown file\n');
  
  // 4. Read back the edits
  console.log('4. Reading back the edited suggestion...');
  const readResult = manager.readSuggestionEdits(editorResult.filePath);
  if (!readResult.success) {
    console.error('❌ Failed to read edits:', readResult.error);
    return;
  }
  
  console.log(`✅ ${readResult.message}`);
  console.log('📝 **Edited suggestion:**');
  console.log(`   Title: ${readResult.suggestion.title}`);
  console.log(`   Priority: ${readResult.suggestion.priority}`);
  console.log(`   Description: ${readResult.suggestion.description.substring(0, 100)}...`);
  console.log(`   Edited at: ${readResult.suggestion.editedAt}\n`);
  
  // 5. Test upload (dry run)
  console.log('5. Testing upload to SpaceCat (dry run)...');
  const uploadResult = await manager.uploadToSpaceCat('1', true);
  if (!uploadResult.success) {
    console.error('❌ Failed to upload:', uploadResult.error);
    return;
  }
  
  console.log(`✅ ${uploadResult.message}`);
  console.log(`📤 Would upload: ${uploadResult.suggestion.title}\n`);
  
  // 6. Get status
  console.log('6. Current status...');
  const status = manager.getStatus();
  console.log(`📊 **Status:**`);
  console.log(`   Total suggestions: ${status.totalSuggestions}`);
  console.log(`   Edited suggestions: ${status.editedSuggestions}`);
  console.log(`   Approved suggestions: ${status.approvedSuggestions}`);
  console.log(`   Temp files: ${status.tempFiles}\n`);
  
  // 7. Cleanup
  console.log('7. Cleaning up...');
  const cleanupResult = manager.cleanupTempFiles();
  console.log(`✅ ${cleanupResult.message}\n`);
  
  console.log('🎉 **MCP Workflow Test Complete!**');
  console.log('\n💡 **This demonstrates the Cursor workflow:**');
  console.log('   1. AI loads suggestions with load_cwv_suggestions');
  console.log('   2. AI creates markdown editor with create_suggestion_editor');
  console.log('   3. User edits the markdown file in Cursor');
  console.log('   4. AI reads changes with read_suggestion_edits');
  console.log('   5. AI uploads approved suggestions with upload_to_spacecat');
  console.log('   6. AI cleans up with cleanup_temp_files');
}

testMCPWorkflow().catch(console.error); 