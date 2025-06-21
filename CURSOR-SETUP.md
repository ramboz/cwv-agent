# Cursor IDE Setup for CWV Agent

This document provides setup instructions for using the CWV Agent within Cursor IDE with Model Context Protocol (MCP) integration.

## Overview

The CWV Agent integrates with Cursor IDE through an MCP server that provides specialized tools for reviewing, editing, and managing Core Web Vitals performance suggestions. This setup enables seamless workflow between suggestion generation and expert review.

## Prerequisites

- Cursor IDE installed
- Node.js (v18 or higher)
- Access to the cwv-agent repository
- Adobe IMS authentication setup (for SpaceCat integration)

## Setup Instructions

### 1. MCP Server Configuration

The MCP server configuration is already set up in the repository. Verify the configuration files:

**Main Configuration** (`cursor-mcp-config.json`):
```json
{
  "mcpServers": {
    "cwv-reviewer": {
      "command": "node",
      "args": ["index.js", "--action", "mcp-reviewer"],
      "cwd": "./"
    }
  }
}
```

**Alternative Configuration** (`cwv-suggestion-reviewer/cursor-mcp-config.json`):
```json
{
  "mcpServers": {
    "cwv-reviewer": {
      "command": "node",
      "args": ["./cwv-suggestion-reviewer/mcp-server.js"],
      "cwd": "./",
      "env": {
        "NODE_ENV": "development"
      }
    }
  }
}
```

### 2. Cursor IDE Configuration

1. **Install MCP Extension**: Ensure you have the MCP extension installed in Cursor
2. **Configure MCP Server**: Copy the appropriate `cursor-mcp-config.json` to your Cursor configuration directory
3. **Restart Cursor**: Restart Cursor IDE to load the MCP server configuration

### 3. Custom Mode Setup

The CWV suggestion review mode is configured as a custom AI assistant mode optimized for the workflow.

**System Instruction Location**: [`CURSOR-CWV-MODE.md`](../../CURSOR-CWV-MODE.md)

To activate this mode in Cursor:
1. Open the AI assistant panel
2. Create a new custom mode
3. Copy the contents of `CURSOR-CWV-MODE.md` as the system instruction
4. Name it "CWV Review"

## Available MCP Tools

The MCP server provides 13 specialized tools organized into categories:

### Loading Tools
- `load_suggestions_by_url` - Auto-discover suggestions by URL
- `load_multi_device_suggestions` - Load and merge mobile/desktop suggestions  
- `load_cwv_suggestions` - Load single suggestion file

### Editing Tools
- `create_suggestion_editor` - Create markdown editor for individual suggestions
- `create_category_editor` - Create markdown editor for entire categories
- `read_suggestion_edits` - Read back edited suggestions
- `read_category_edits` - Read back edited categories

### SpaceCat Integration
- `upload_to_spacecat` - Upload individual suggestions
- `batch_upload_to_spacecat` - Batch upload approved suggestions
- `check_existing_suggestions` - Check for existing suggestions

### Status & Management
- `get_status` - Get overall workflow status
- `get_category_status` - Get category-specific status
- `cleanup_temp_files` - Clean up temporary files

## Key Features

### Multi-Device Intelligence
- Automatically merges mobile and desktop suggestions
- Identifies device-specific vs universal optimizations
- Prioritizes based on combined impact

### Batch Operations
- Category-level editing for efficient bulk changes
- Batch uploads with conflict detection
- Comprehensive status tracking

### Enhanced SpaceCat Integration
- Pre-upload validation and conflict detection
- Dry-run capabilities for safe testing
- Automatic CWV opportunity management

## Workflow Examples

### Loading Suggestions
```
Load suggestions for https://www.qualcomm.com
```

### Category-Based Editing
```
Edit LCP suggestions
```

### Batch Operations
```
Batch upload LCP
```

### Status Checking
```
Show category status
```

## Troubleshooting

### Common Issues

1. **MCP Server Not Starting**
   - Check Node.js version (requires v18+)
   - Verify file paths in configuration
   - Check console for error messages

2. **Authentication Issues**
   - Ensure Adobe IMS credentials are configured
   - Check network connectivity
   - Verify access permissions

3. **File Not Found Errors**
   - Verify suggestion files exist in `.cache/` directory
   - Check file naming conventions
   - Ensure proper URL formatting

### Debug Mode

To enable debug logging, set the environment variable:
```bash
export DEBUG=cwv-agent:*
```

## Architecture

The system consists of:
- **MCP Server** (`cwv-suggestion-reviewer/mcp-server.js`) - Main server implementation
- **Suggestion Manager** - Core logic for managing suggestions
- **SpaceCat Client** - Integration with SpaceCat API
- **Adobe IMS Auth** - Authentication via `mcp-remote-with-okta`

## Updates and Maintenance

The system instruction and MCP tools are actively maintained. Key files to monitor:
- `cursor-cwv-mode.md` - System instruction updates
- `mcp-server.js` - Tool implementations
- `cursor-mcp-config.json` - Configuration changes

For the latest improvements and features, refer to the main system instruction file. 