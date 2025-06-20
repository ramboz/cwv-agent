#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

/**
 * Simple Chat-based Workflow for reviewing CWV suggestions
 * Consumes structured JSON from cwv-agent
 */
class SimpleChatWorkflow {
  constructor(suggestionsFile, options = {}) {
    this.suggestionsFile = suggestionsFile;
    this.options = options;
    this.suggestions = [];
    this.currentIndex = 0;
    this.state = 'initial';
    this.approved = [];
    this.rejected = [];
    this.edited = [];
  }

  /**
   * Initialize the workflow by loading structured suggestions
   */
  async initialize() {
    try {
      const content = fs.readFileSync(this.suggestionsFile, 'utf8');
      const data = JSON.parse(content);
      
      if (!data.suggestions || !Array.isArray(data.suggestions)) {
        throw new Error('Invalid suggestions file format');
      }
      
      this.suggestions = data.suggestions;
      this.baseUrl = data.url;
      this.deviceType = data.deviceType;
      this.summary = data.summary;
      
      if (this.suggestions.length === 0) {
        throw new Error('No suggestions found in the file');
      }
      
      this.state = 'reviewing';
      return this.formatInitialMessage();
      
    } catch (error) {
      throw new Error(`Failed to initialize workflow: ${error.message}`);
    }
  }

  /**
   * Format the initial message for the chat interface
   */
  formatInitialMessage() {
    const currentSuggestion = this.suggestions[this.currentIndex];
    
    return `🚀 **CWV Suggestion Review Started**

**Site:** ${this.baseUrl}
**Device:** ${this.deviceType}
**Total Suggestions:** ${this.suggestions.length}

---

## Suggestion ${this.currentIndex + 1}/${this.suggestions.length}

**${currentSuggestion.title}**
*${currentSuggestion.metric} • Priority: ${currentSuggestion.priority} • Effort: ${currentSuggestion.effort}*

${currentSuggestion.description}

${currentSuggestion.impact ? `**Expected Impact:** ${currentSuggestion.impact}` : ''}

${currentSuggestion.implementation ? `**Implementation:**\n${currentSuggestion.implementation}` : ''}

${currentSuggestion.codeExample ? `**Code Example:**\n\`\`\`\n${currentSuggestion.codeExample}\n\`\`\`` : ''}

---

**Available Commands:**
- \`approve\` - Approve this suggestion
- \`reject\` - Reject this suggestion  
- \`edit\` - Edit this suggestion
- \`skip\` - Skip to next suggestion
- \`details\` - Show full details
- \`summary\` - Show current progress

**What would you like to do with this suggestion?**`;
  }

  /**
   * Process user input and return response
   */
  processInput(input) {
    const command = input.trim().toLowerCase();
    
    switch (command) {
      case 'approve':
        return this.approveCurrentSuggestion();
      case 'reject':
        return this.rejectCurrentSuggestion();
      case 'edit':
        return this.startEditingSuggestion();
      case 'skip':
        return this.skipToNextSuggestion();
      case 'details':
        return this.showDetailedSuggestion();
      case 'summary':
        return this.showProgressSummary();
      default:
        if (this.state === 'editing') {
          return this.processEditInput(input);
        }
        return this.showHelpMessage();
    }
  }

  /**
   * Approve the current suggestion
   */
  approveCurrentSuggestion() {
    const suggestion = this.suggestions[this.currentIndex];
    this.approved.push(suggestion);
    
    return this.moveToNextSuggestion(`✅ **Approved:** ${suggestion.title}`);
  }

  /**
   * Reject the current suggestion
   */
  rejectCurrentSuggestion() {
    const suggestion = this.suggestions[this.currentIndex];
    this.rejected.push(suggestion);
    
    return this.moveToNextSuggestion(`❌ **Rejected:** ${suggestion.title}`);
  }

  /**
   * Start editing the current suggestion
   */
  startEditingSuggestion() {
    this.state = 'editing';
    const suggestion = this.suggestions[this.currentIndex];
    
    return `📝 **Editing Suggestion:** ${suggestion.title}

**Current Description:**
${suggestion.description}

**Current Implementation:**
${suggestion.implementation || 'None'}

**Please provide your edits in natural language or structured format. Example:**
- "Change the title to: [new title]"
- "Update description: [new description]"
- "Set priority to High"
- "Add implementation details: [details]"

Type your edits below:`;
  }

  /**
   * Process edit input
   */
  processEditInput(input) {
    const suggestion = { ...this.suggestions[this.currentIndex] };
    
    // Simple parsing of edit commands
    if (input.includes('title to:')) {
      const match = input.match(/title to:\s*(.+)/i);
      if (match) suggestion.title = match[1].trim();
    }
    
    if (input.includes('description:')) {
      const match = input.match(/description:\s*(.+)/i);
      if (match) suggestion.description = match[1].trim();
    }
    
    if (input.includes('priority to')) {
      const match = input.match(/priority to\s+(high|medium|low)/i);
      if (match) suggestion.priority = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
    }
    
    if (input.includes('effort to')) {
      const match = input.match(/effort to\s+(easy|medium|hard)/i);
      if (match) suggestion.effort = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
    }
    
    if (input.includes('implementation:')) {
      const match = input.match(/implementation:\s*(.+)/i);
      if (match) suggestion.implementation = match[1].trim();
    }
    
    // Save the edited suggestion
    this.edited.push(suggestion);
    this.state = 'reviewing';
    
    return this.moveToNextSuggestion(`✏️ **Edited and Approved:** ${suggestion.title}`);
  }

  /**
   * Skip to next suggestion
   */
  skipToNextSuggestion() {
    return this.moveToNextSuggestion(`⏭️ **Skipped:** ${this.suggestions[this.currentIndex].title}`);
  }

  /**
   * Show detailed information about current suggestion
   */
  showDetailedSuggestion() {
    const suggestion = this.suggestions[this.currentIndex];
    
    return `🔍 **Detailed View - Suggestion ${this.currentIndex + 1}**

**Title:** ${suggestion.title}
**Metric:** ${suggestion.metric}
**Category:** ${suggestion.category}
**Priority:** ${suggestion.priority}
**Effort:** ${suggestion.effort}
**Impact:** ${suggestion.impact}

**Description:**
${suggestion.description}

**Implementation:**
${suggestion.implementation || 'No implementation details provided'}

**Code Example:**
${suggestion.codeExample ? `\`\`\`\n${suggestion.codeExample}\n\`\`\`` : 'No code example provided'}

---

**Available Commands:** approve, reject, edit, skip, summary`;
  }

  /**
   * Show progress summary
   */
  showProgressSummary() {
    const total = this.suggestions.length;
    const reviewed = this.approved.length + this.rejected.length + this.edited.length;
    const remaining = total - reviewed;
    
    return `📊 **Progress Summary**

**Total Suggestions:** ${total}
**Reviewed:** ${reviewed}
**Approved:** ${this.approved.length}
**Edited:** ${this.edited.length}
**Rejected:** ${this.rejected.length}
**Remaining:** ${remaining}

**Approved Suggestions:**
${this.approved.map(s => `- ${s.title}`).join('\n') || 'None'}

**Edited Suggestions:**
${this.edited.map(s => `- ${s.title}`).join('\n') || 'None'}

**Rejected Suggestions:**
${this.rejected.map(s => `- ${s.title}`).join('\n') || 'None'}

${remaining > 0 ? `**Current:** ${this.suggestions[this.currentIndex].title}` : '**All suggestions reviewed!**'}`;
  }

  /**
   * Move to next suggestion or complete workflow
   */
  moveToNextSuggestion(statusMessage) {
    this.currentIndex++;
    
    if (this.currentIndex >= this.suggestions.length) {
      this.state = 'completed';
      return this.formatCompletionMessage(statusMessage);
    }
    
    const nextSuggestion = this.suggestions[this.currentIndex];
    
    return `${statusMessage}

---

## Suggestion ${this.currentIndex + 1}/${this.suggestions.length}

**${nextSuggestion.title}**
*${nextSuggestion.metric} • Priority: ${nextSuggestion.priority} • Effort: ${nextSuggestion.effort}*

${nextSuggestion.description}

${nextSuggestion.impact ? `**Expected Impact:** ${nextSuggestion.impact}` : ''}

---

**Available Commands:** approve, reject, edit, skip, details, summary`;
  }

  /**
   * Format completion message
   */
  formatCompletionMessage(statusMessage) {
    const toUpload = [...this.approved, ...this.edited];
    
    return `${statusMessage}

🎉 **Review Complete!**

**Final Summary:**
- **Total Suggestions:** ${this.suggestions.length}
- **Approved:** ${this.approved.length}
- **Edited:** ${this.edited.length}
- **Rejected:** ${this.rejected.length}
- **Ready for Upload:** ${toUpload.length}

${toUpload.length > 0 ? `**Suggestions Ready for SpaceCat:**
${toUpload.map((s, i) => `${i + 1}. ${s.title} (${s.metric}, ${s.priority} priority)`).join('\n')}

${this.options.dryRun ? '**[DRY RUN MODE]** - No actual upload will occur' : '**Ready to upload to SpaceCat!**'}` : '**No suggestions to upload.**'}`;
  }

  /**
   * Show help message
   */
  showHelpMessage() {
    return `❓ **Available Commands:**

- \`approve\` - Approve this suggestion for upload
- \`reject\` - Reject this suggestion  
- \`edit\` - Edit this suggestion with your changes
- \`skip\` - Skip to next suggestion without action
- \`details\` - Show full details of current suggestion
- \`summary\` - Show current progress and statistics

**Current:** Suggestion ${this.currentIndex + 1}/${this.suggestions.length} - ${this.suggestions[this.currentIndex].title}`;
  }

  /**
   * Get the final approved suggestions for upload
   */
  getApprovedSuggestions() {
    return [...this.approved, ...this.edited];
  }
}

// Command line interface  
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const suggestionsFile = args[0];
  const isDryRun = args.includes('--dry-run');
  
  if (!suggestionsFile) {
    console.error('Usage: node simple-chat-workflow.js <suggestions-file.json> [--dry-run]');
    console.error('Example: node simple-chat-workflow.js ../report.suggestions.json --dry-run');
    process.exit(1);
  }
  
  const workflow = new SimpleChatWorkflow(suggestionsFile, { dryRun: isDryRun });
  
  workflow.initialize().then(message => {
    console.log(message);
    console.log('\n🤖 **This is a demonstration of the chat-based review system.**');
    console.log('In the actual implementation, you would continue the conversation');
    console.log('by responding with commands like "approve", "reject", "edit", etc.');
    console.log('\n💡 **Next steps:**');
    console.log('1. Integrate this workflow into your AI Chat interface');
    console.log('2. Add SpaceCat upload functionality for approved suggestions');
    console.log('3. Customize the editing interface for your team\'s needs');
  }).catch(error => {
    console.error('❌ Error:', error.message);
    process.exit(1);
  });
}

export { SimpleChatWorkflow }; 