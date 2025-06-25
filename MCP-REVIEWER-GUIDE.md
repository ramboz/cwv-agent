# CWV Suggestion MCP Reviewer Guide

## Overview

The CWV Agent includes an integrated MCP (Model Context Protocol) reviewer that allows you to review and manage Core Web Vitals optimization suggestions directly within Cursor. This guide covers setup, configuration, and usage.

## Features

- **Auto-Discovery**: Load suggestion files by URL automatically
- **Multi-Device Support**: Intelligently merge mobile and desktop suggestions
- **Category-Based Review**: Bulk review by CWV categories (LCP, CLS, INP, TTFB)
- **SpaceCat Integration**: Direct upload of approved suggestions
- **Interactive Workflow**: Review, edit, and approve suggestions in Cursor

## Prerequisites

1. **CWV Agent**: Ensure you have the main cwv-agent installed and working
2. **Cursor IDE**: Latest version of Cursor with MCP support
3. **Node.js**: Version 18 or higher
4. **Dependencies**: Run `npm install` in the cwv-agent directory

## Setup Instructions

### Step 1: Install Dependencies

```bash
cd /path/to/your/cwv-agent
npm install
```

### Step 2: Configure MCP in Cursor

1. **Open Cursor Settings**: `Cmd/Ctrl + ,`
2. **Search for "MCP"** in settings
3. **Edit MCP Configuration**: Add the following to your MCP settings:

```json
{
  "mcpServers": {
    "cwv-reviewer": {
      "command": "node",
      "args": ["index.js", "--action", "mcp-reviewer"],
      "cwd": "/Users/your-username/path/to/cwv-agent"
    }
  }
}
```

**Important**: Replace `/Users/your-username/path/to/cwv-agent` with your actual cwv-agent directory path.

### Step 3: Set Up Custom CWV Review Mode

1. **Open Cursor Settings**: `Cmd/Ctrl + ,`
2. **Navigate to "AI" → "Custom Instructions"**
3. **Create New Mode**: Click "Add Custom Mode"
4. **Configure the Mode**:
   - **Name**: `CWV Review Mode`
   - **Description**: `Core Web Vitals suggestion review and management`
   - **System Instructions**: 
   ```
   [PLACEHOLDER - Custom CWV review instructions will be added here]
   
   You are a CWV Performance Expert Assistant. Help review and manage 
   Core Web Vitals optimization suggestions using the available MCP tools.
   ```
   - **Enable Auto-Advance**: ✅ **Check this box**
   - **Model**: Choose your preferred model (Claude 3.5 Sonnet recommended)

5. **Save the Mode**

### Step 4: Verify MCP Connection

1. **Start the MCP Server**:
   ```bash
   node index.js --action mcp-reviewer
   ```
   
   You should see:
   ```
   🎯 Starting CWV Suggestion MCP Reviewer...
   🚀 CWV Suggestion MCP Reviewer is running...
   Available tools: load_suggestions_by_url, get_status
   ```

2. **Test in Cursor**:
   - Switch to "CWV Review Mode" in Cursor
   - Open a new chat
   - Try: "Load suggestions for https://www.qualcomm.com/"
   - The MCP tools should be automatically available

## Usage Workflow

### Basic Workflow

1. **Start MCP Server**:
   ```bash
   node index.js --action mcp-reviewer
   ```

2. **Switch to CWV Review Mode** in Cursor

3. **Load Suggestions**:
   ```
   Load suggestions for https://www.qualcomm.com/
   ```

4. **Review Categories**: The system will show suggestions grouped by:
   - **LCP** (Largest Contentful Paint)
   - **CLS** (Cumulative Layout Shift)  
   - **INP** (Interaction to Next Paint)
   - **TTFB** (Time to First Byte)

5. **Edit & Approve**: Review suggestions in bulk by category

6. **Upload to SpaceCat**: Batch upload approved suggestions

### Available MCP Tools

| Tool | Description | Usage |
|------|-------------|-------|
| `load_suggestions_by_url` | Auto-discover and load suggestions by URL | `load_suggestions_by_url("https://example.com/")` |
| `get_status` | Get current workflow status | `get_status("dummy")` |

### Example Commands

```bash
# Load suggestions for a site
"Load suggestions for https://www.qualcomm.com/"

# Check current status
"What's the current status of loaded suggestions?"

# Review specific category
"Show me the LCP suggestions for review"

# Get help
"What CWV suggestion tools are available?"
```

## File Discovery

The MCP reviewer automatically discovers suggestion files using this pattern:
- **Mobile**: `{cache-dir}/{pattern}.mobile.suggestions.gemini25pro.json`
- **Desktop**: `{cache-dir}/{pattern}.desktop.suggestions.gemini25pro.json`

Where `{pattern}` is derived from the URL (e.g., `www-qualcomm-com` for `https://www.qualcomm.com/`)

## Auto-Advance Feature

**Important**: Make sure to enable the "Auto-Advance" option in your custom mode. This allows the AI to:
- Automatically execute MCP tool calls
- Provide faster, more interactive responses
- Chain multiple operations together seamlessly

Without auto-advance, you'll need to manually approve each tool call.

## Troubleshooting

### MCP Server Not Starting
```bash
# Check if dependencies are installed
npm list @modelcontextprotocol/sdk mcp-remote-with-okta

# Reinstall if needed
npm install @modelcontextprotocol/sdk mcp-remote-with-okta
```

### MCP Tools Not Available in Cursor
1. Verify MCP server is running
2. Check MCP configuration path is correct
3. Restart Cursor after configuration changes
4. Ensure you're in "CWV Review Mode"

### File Discovery Issues
```bash
# Check cache directory structure
ls -la .cache/

# Look for suggestion files
ls -la .cache/*.suggestions.gemini25pro.json
```

### Authentication Issues
- Ensure you have proper Adobe IMS credentials configured
- Check `mcp-remote-with-okta` is properly installed
- Verify SpaceCat access permissions

## Advanced Configuration

### Custom Cache Directory
```json
{
  "mcpServers": {
    "cwv-reviewer": {
      "command": "node",
      "args": ["index.js", "--action", "mcp-reviewer"],
      "cwd": "/path/to/cwv-agent",
      "env": {
        "CWV_CACHE_DIR": "/custom/cache/path"
      }
    }
  }
}
```

### Debug Mode
```bash
# Start with debug logging
DEBUG=mcp* node index.js --action mcp-reviewer
```

## Integration with SpaceCat

The MCP reviewer includes built-in SpaceCat integration:

1. **Authentication**: Uses Adobe IMS via `mcp-remote-with-okta`
2. **Site Detection**: Automatically finds sites by base URL
3. **Opportunity Management**: Creates/updates CWV opportunities
4. **Batch Upload**: Upload all approved suggestions at once

## Best Practices

1. **Always use Auto-Advance**: Enables seamless tool execution
2. **Review by Category**: More efficient than individual suggestions
3. **Merge Device Data**: Let the system intelligently combine mobile/desktop
4. **Batch Operations**: Approve and upload in bulk for efficiency
5. **Regular Status Checks**: Monitor workflow progress

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Verify all prerequisites are met
3. Ensure MCP configuration is correct
4. Test with a simple command first

For additional help, refer to the main cwv-agent documentation or create an issue in the repository. 