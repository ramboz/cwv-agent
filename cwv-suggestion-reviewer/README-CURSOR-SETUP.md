# CWV Suggestion Review with Cursor.io

This is a **much better solution** than the terminal-based workflow! It integrates directly with your Cursor IDE using MCP tools and a custom AI mode.

## 🎯 **The Workflow**

1. **Generate structured suggestions**: CWV-agent creates both `.md` and `.suggestions.json` files
2. **Load in Cursor**: AI loads suggestions using MCP tools
3. **Review suggestions**: AI presents them in a clean, prioritized format
4. **Edit when needed**: AI creates markdown files for you to edit in Cursor
5. **Upload approved**: AI uploads to SpaceCat automatically
6. **Clean up**: AI removes temporary files

## 🛠 **Setup Instructions**

### Step 1: Configure Cursor Custom Mode

1. In Cursor, go to Settings → AI → Custom Instructions
2. Create a new custom mode called "CWV Review"  
3. Copy the content from `cursor-cwv-mode.md` into the custom instruction field

### Step 2: Set up MCP Tools (Optional - for advanced users)

If you want to use MCP tools directly:

1. Add the MCP configuration to your Cursor settings
2. Copy content from `cursor-mcp-config.json` 
3. Restart Cursor

### Step 3: Basic Usage (No MCP needed)

Even without MCP, you can use the tools directly:

```bash
# Load suggestions and see summary
node cwv-suggestion-reviewer/mcp-server.js load_cwv_suggestions ".cache/your-file.suggestions.json"

# Create editor for a suggestion  
node cwv-suggestion-reviewer/mcp-server.js create_suggestion_editor 1

# After editing the markdown file
node cwv-suggestion-reviewer/mcp-server.js read_suggestion_edits "temp-edits/suggestion-1-*.md"

# Upload to SpaceCat (dry run first)
node cwv-suggestion-reviewer/mcp-server.js upload_to_spacecat 1 true

# Clean up
node cwv-suggestion-reviewer/mcp-server.js cleanup_temp_files
```

## 🔥 **Example Workflow**

### 1. Generate CWV Report
```bash
cd /Users/ramboz/Projects/spacecat/cwv-agent
node index.js --action prompt --url "https://example.com" --device mobile --model gemini-2.5-pro-preview-05-06
```

### 2. Use Cursor Custom Mode

Switch to "CWV Review" mode in Cursor and say:

```
"Load suggestions from .cache/example-com.mobile.suggestions.gemini25pro.json"
```

The AI will:
- Load and summarize all suggestions by priority
- Show you the high-impact items first
- Let you ask to edit specific suggestions

### 3. Edit a Suggestion

Say: `"Edit suggestion 1"`

The AI will:
- Create a markdown file in `temp-edits/`
- Open it for you to edit
- Wait for you to save your changes

### 4. Process Your Edits

Say: `"I've finished editing suggestion 1"`

The AI will:
- Read your changes from the markdown file
- Show you a summary of what changed
- Ask if you want to approve it for upload

### 5. Upload to SpaceCat

Say: `"Approve and upload suggestion 1"`

The AI will:
- Upload the (edited) suggestion to SpaceCat
- Confirm the upload
- Clean up the temporary file

## 🚀 **Key Benefits**

✅ **Native Cursor Integration**: Works within your existing workflow  
✅ **Proper Markdown Editing**: Full editing power, not terminal input  
✅ **Visual Diff**: See exactly what changed  
✅ **Batch Operations**: Handle multiple suggestions efficiently  
✅ **Safe Testing**: Dry-run mode for testing  
✅ **Auto Cleanup**: No leftover temp files  

## 📝 **Example Commands for Cursor AI**

```
# Load and review
"Load suggestions from the latest CWV report"
"Show me all high priority suggestions"
"What's the biggest LCP impact we can get?"

# Edit suggestions  
"Edit suggestion 3 - I want to change the priority"
"Create editor for the font loading suggestion"
"I've updated the implementation details, read my changes"

# Approve and upload
"Approve suggestions 1, 3, and 5 for upload" 
"Upload all edited suggestions to SpaceCat"
"Clean up temporary files"

# Status and summary
"Show me current progress"
"How many suggestions are ready for upload?"
"Give me a final summary"
```

## 🔧 **Advanced Features**

- **Priority Sorting**: Suggestions automatically sorted by impact
- **Metric Filtering**: Filter by LCP, CLS, INP improvements
- **Effort Estimation**: See implementation effort for each suggestion
- **Version Tracking**: Keep track of original vs edited suggestions
- **Dry Run Mode**: Test uploads without actually sending to SpaceCat

## 🎯 **Why This Is Better**

**Before**: Terminal commands, manual typing, fragile input parsing  
**After**: Natural language with AI, proper file editing, integrated workflow

Your team can now:
- Review suggestions in a familiar environment
- Edit with full markdown power
- Use natural language commands
- See visual diffs of changes
- Batch process multiple suggestions

**This actually speeds up step 3 of your workflow significantly!** 🚀 