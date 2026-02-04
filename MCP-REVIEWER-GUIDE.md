# CWV Suggestion MCP Reviewer Guide

## Overview

The CWV Agent includes an integrated MCP (Model Context Protocol) reviewer that allows you to generate, review, and manage Core Web Vitals optimization suggestions directly within Cursor IDE.

## Features

- **Suggestion Generation**: Run the multi-agent analysis directly from Cursor
- **Auto-Discovery**: Load suggestion files by URL automatically
- **Multi-Device Support**: Intelligently merge mobile and desktop suggestions
- **Category-Based Review**: Bulk review by CWV categories (LCP, CLS, INP, TTFB)
- **SpaceCat Integration**: Direct upload of approved suggestions

## Prerequisites

1. **Node.js**: Version 18 or higher
2. **Cursor IDE**: Latest version with MCP support
3. **Dependencies**: Run `npm install` in the cwv-agent directory
4. **API Keys**: See [Environment Variables](#environment-variables) below

## Setup Instructions

### Step 1: Install Dependencies

```bash
cd /path/to/cwv-agent
npm install
```

### Step 2: Open in Cursor

Simply open the cwv-agent project folder in Cursor. The MCP configuration (`.cursor/mcp.json`) and rules (`.cursorrules`) are already set up and will be loaded automatically.

### Step 3: Verify MCP Connection

In Cursor, open a new chat and try:
```
What CWV tools are available?
```

The AI should list the available MCP tools including `run_agent`, `load_suggestions_by_url`, etc.

## Available MCP Tools

### Generation
| Tool | Description |
|------|-------------|
| `run_agent` | Run full multi-agent CWV analysis (~3-5 min) |

### Loading
| Tool | Description |
|------|-------------|
| `load_suggestions_by_url` | Auto-discover and load suggestions by URL |
| `load_multi_device_suggestions` | Load mobile/desktop files manually |
| `load_cwv_suggestions` | Load a single suggestion file |
| `get_suggestions_by_url_and_type` | Fetch from SpaceCat API |

### Editing
| Tool | Description |
|------|-------------|
| `create_category_editor` | Create markdown editor for a category |
| `read_category_edits` | Apply edits from markdown file |
| `approve_category` | Mark category as approved |

### Upload
| Tool | Description |
|------|-------------|
| `check_existing_suggestions` | Check SpaceCat for conflicts |
| `batch_upload_to_spacecat` | Upload approved suggestions |

### Status
| Tool | Description |
|------|-------------|
| `get_status` | Overall workflow status |
| `get_category_status` | Category-specific status |
| `cleanup_temp_files` | Remove temporary files |

## Usage Workflow

### Generate New Suggestions

```
Generate CWV suggestions for https://www.example.com
```

This will:
1. Run `run_agent` to collect data and generate suggestions (~3-5 min)
2. Automatically load the results with `load_suggestions_by_url`
3. Present suggestions organized by category

### Review Existing Suggestions

```
Load suggestions for https://www.example.com
```

### Edit & Approve

```
Edit the LCP suggestions
```

After reviewing/editing:
```
Approve the LCP category
```

### Upload to SpaceCat

Always dry-run first:
```
Batch upload with dry run
```

Then real upload:
```
Batch upload to SpaceCat
```

## File Discovery

The MCP reviewer automatically discovers suggestion files in `.cache/` using this pattern:
- **Mobile**: `{pattern}.mobile.suggestions.{model}.json`
- **Desktop**: `{pattern}.desktop.suggestions.{model}.json`

Where `{pattern}` is derived from the URL (e.g., `www-example-com` for `https://www.example.com/`)

## Troubleshooting

### MCP Tools Not Available
1. Restart Cursor after opening the project
2. Check that `.cursor/mcp.json` exists
3. Verify dependencies are installed: `npm list @modelcontextprotocol/sdk`

### Generation Fails
1. Check network connectivity
2. Verify API keys are configured in `.env`
3. Try with `skipCache: true` to force fresh data

### File Discovery Issues
```bash
# Check cache directory
ls -la .cache/

# Look for suggestion files
ls -la .cache/*.suggestions.*.json
```

### Authentication Issues (SpaceCat)
- Ensure Adobe IMS credentials are configured
- Check `mcp-remote-with-okta` is installed
- Verify SpaceCat access permissions

## Advanced Configuration

### Custom MCP Configuration

If you need to customize the MCP server, edit `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cwv-reviewer": {
      "command": "node",
      "args": ["./index.js", "--action", "mcp-reviewer", "--silent"],
      "cwd": ".",
      "env": {
        "ADOBE_SCOPE": "...",
        "ADOBE_CLIENT_ID": "pss-user"
      }
    }
  }
}
```

### Debug Mode

To see debug output, remove the `--silent` flag from the MCP config args.

## Environment Variables

API keys and credentials should be configured via environment variables to keep them out of the chat context.

### Option 1: `.env` File (Recommended)

Create a `.env` file in the project root:

```env
# Required for CrUX and PSI data
GOOGLE_CRUX_API_KEY=your-crux-api-key
GOOGLE_PAGESPEED_INSIGHTS_API_KEY=your-psi-api-key

# Required for LLM analysis (Gemini)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

# Optional: RUM data collection (per-domain key)
RUM_DOMAIN_KEY=your-rum-domain-key
```

The `.env` file is loaded automatically when the MCP server starts via `dotenv`.

### Option 2: MCP Config Environment

Add keys directly to `.cursor/mcp.json` in the `env` section:

```json
{
  "cwv-reviewer": {
    "command": "node",
    "args": ["./index.js", "--action", "mcp-reviewer", "--silent"],
    "cwd": ".",
    "env": {
      "RUM_DOMAIN_KEY": "your-rum-domain-key",
      "GOOGLE_CRUX_API_KEY": "your-crux-key",
      "GOOGLE_PAGESPEED_INSIGHTS_API_KEY": "your-psi-key",
      "ADOBE_SCOPE": "...",
      "ADOBE_CLIENT_ID": "pss-user"
    }
  }
}
```

**Note**: The `.env` file approach is preferred as it keeps secrets out of version control (`.env` is gitignored).

## Best Practices

1. **Start with mobile**: Mobile analysis often reveals more issues
2. **Review by category**: More efficient than individual suggestions
3. **Always dry-run uploads**: Prevents accidental overwrites
4. **Check existing suggestions**: Before uploading to avoid conflicts
5. **Use environment variables**: Keep API keys out of the chat context
