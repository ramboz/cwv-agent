# Cursor IDE Setup for CWV Agent

Setup instructions for using the CWV Agent within Cursor IDE with MCP integration.

## Prerequisites

- Cursor IDE (latest version with MCP support)
- Node.js v18 or higher
- Adobe IMS authentication (for SpaceCat integration)

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Open in Cursor**: Open the cwv-agent folder in Cursor IDE

3. **Start using**: The MCP server and rules are auto-configured. Open a chat and try:
   ```
   Generate CWV suggestions for https://www.example.com
   ```

## How It Works

The project includes pre-configured files that Cursor automatically loads:

- **`.cursor/mcp.json`** - MCP server configuration (starts the cwv-reviewer server)
- **`.cursorrules`** - AI assistant rules for CWV workflows

No manual configuration is needed.

## Available MCP Tools

### Generation
- `run_agent` - Run full multi-agent CWV analysis (~3-5 min)

### Loading
- `load_suggestions_by_url` - Auto-discover suggestions by URL
- `load_multi_device_suggestions` - Load mobile/desktop files manually
- `load_cwv_suggestions` - Load single suggestion file
- `get_suggestions_by_url_and_type` - Fetch from SpaceCat API

### Editing
- `create_category_editor` - Create markdown editor for categories (LCP/CLS/INP/TTFB)
- `read_category_edits` - Apply edits from markdown file
- `approve_category` - Mark category as approved

### Upload
- `check_existing_suggestions` - Check SpaceCat for conflicts
- `batch_upload_to_spacecat` - Upload approved suggestions

### Status
- `get_status` - Overall workflow status
- `get_category_status` - Category-specific status
- `cleanup_temp_files` - Remove temporary files

## Workflow Examples

### Generate & Review
```
Generate CWV suggestions for https://www.example.com
```

### Load Existing
```
Load suggestions for https://www.example.com
```

### Edit & Approve
```
Edit LCP suggestions
Approve LCP category
```

### Upload
```
Batch upload with dry run
Batch upload to SpaceCat
```

## Troubleshooting

### MCP Tools Not Available
- Restart Cursor after opening the project
- Verify `.cursor/mcp.json` exists
- Check dependencies: `npm list @modelcontextprotocol/sdk`

### Authentication Issues (SpaceCat)
- Ensure Adobe IMS credentials are configured
- Verify `mcp-remote-with-okta` is installed

### Debug Mode
Remove `--silent` from `.cursor/mcp.json` args to see console output.

## Architecture

- **MCP Server**: `src/core/mcp-reviewer.js`
- **Suggestion Manager**: `src/core/suggestion-manager.js`
- **SpaceCat Client**: `src/core/spacecat-client.js`
- **Rules**: `.cursorrules`

For detailed usage, see [MCP-REVIEWER-GUIDE.md](./MCP-REVIEWER-GUIDE.md).
