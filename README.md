# Web Page Performance Analysis Agent

A comprehensive tool for analyzing Core Web Vitals (CWV) performance and generating actionable optimization suggestions with AI-powered insights.

## ✨ Features

- 🔍 **Performance Data Collection**: Automated CrUX data, PSI audits, and HAR file generation
- 🤖 **AI-Powered Analysis**: Generate detailed optimization recommendations using advanced LLM models
- 📱 **Multi-Device Support**: Analyze both mobile and desktop performance
- 🎯 **Interactive Review**: Built-in MCP reviewer for Cursor IDE integration
- ☁️ **SpaceCat Integration**: Direct upload of approved suggestions to SpaceCat platform
- 📊 **Flexible Caching**: Smart caching to avoid redundant API calls

## 🚀 Quick Start

### Installation

```bash
npm install
```

### Environment Setup

Create a `.env` file with your API keys:

```env
# Core APIs
GOOGLE_CRUX_API_KEY=your_crux_api_key
GOOGLE_PAGESPEED_INSIGHTS_API_KEY=your_psi_api_key

# For Gemini
GOOGLE_APPLICATION_CREDENTIALS=path/to/credentials.json

# OpenAI Models
AZURE_OPENAI_API_DEPLOYMENT_NAME=...
AZURE_OPENAI_API_INSTANCE_NAME=...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_API_VERSION=...
```

### Basic Usage

```bash
# AI-powered analysis with multi-agent system (default)
node index.js --url "https://example.com"

# Or explicitly specify the agent action
node index.js --action agent --url "https://example.com"

# Collect raw performance data only
node index.js --action collect --url "https://example.com" --device mobile

# Start interactive MCP reviewer (Cursor IDE integration)
node index.js --action mcp-reviewer
```

## 📋 Available Actions

| Action | Description | Example |
|--------|-------------|---------|
| `agent` | **[DEFAULT]** Run multi-agent AI analysis workflow | `--action agent --url example.com` |
| `collect` | Collect raw performance data (CrUX, PSI, HAR) | `--action collect --url example.com` |
| `rules` | Apply predefined performance rules | `--action rules --url example.com` |
| `mcp-reviewer` | Start interactive suggestion reviewer | `--action mcp-reviewer` |

## 🎛️ Command Line Options

```bash
node index.js [options]

Options:
  --action, -a     Action to perform [agent|collect|rules|mcp-reviewer] (default: agent)
  --url, -u        URL to analyze
  --urls           Path to JSON file with multiple URLs
  --device, -d     Device type [mobile|desktop] (default: mobile)
  --skip-cache, -s Skip cached data and force new collection
  --model, -m      LLM model to use (default: gemini-2.5-pro)
  --output-suffix  Suffix for output files
  --block-requests Block specific requests (comma-separated)
  --help           Show help
```

## 🤖 Supported AI Models

### Gemini Models (via Vertex AI) - Recommended
- `gemini-2.5-pro` (default, 2M context, native JSON mode)
- `gemini-2.5-flash` (faster, 1M context)
- `gemini-exp-1206` (experimental 2.0 Flash with thinking)
- `gemini-1.5-flash` (legacy, still supported)

### OpenAI Models (via Azure)
- `o1` (latest reasoning model, 200K context)
- `o1-mini` (faster reasoning, 128K context)
- `gpt-4o` (128K context, 16K output)
- `gpt-4o-mini` (faster, smaller)
- `o3-mini` (if available in your region)

### Claude Models (via AWS Bedrock)
- `claude-sonnet-4-5-20250929` (Claude Sonnet 4.5 - latest)
- `claude-opus-4-5-20251101` (Claude Opus 4.5 - most capable)
- `claude-haiku-4-0-20250514` (Claude Haiku 4.0 - fastest)
- `claude-3-7-sonnet-20250219` (previous version)

## 🎯 Interactive MCP Reviewer

The CWV Agent includes a powerful MCP (Model Context Protocol) reviewer for interactive suggestion management within Cursor IDE.

**📖 For complete setup instructions, see: [MCP-REVIEWER-GUIDE.md](./MCP-REVIEWER-GUIDE.md)**

## 📁 Workflow Examples

### Single URL Analysis
```bash
# Complete AI-powered analysis (default: multi-agent workflow)
node index.js --url "https://www.qualcomm.com" --device mobile

# Or explicitly specify agent action
node index.js --action agent --url "https://www.qualcomm.com" --device mobile
```

### Batch Processing
Create `urls.json`:
```json
[
  "https://example.com",
  "https://example.org",
  "https://example.net"
]
```

Run batch analysis:
```bash
node index.js --urls urls.json --device mobile
```

### Force Fresh Data
```bash
# Skip cache and collect new data
node index.js --url "https://example.com" --skip-cache
```

## 📊 Output Files

The tool generates files in the `.cache/` directory:

| File Type | Description | Example |
|-----------|-------------|---------|
| `*.performance.json` | Raw performance data | `example-com.mobile.performance.json` |
| `*.suggestions.*.json` | AI-generated suggestions | `example-com.mobile.suggestions.gemini25pro.json` |
| `*.report.*.summary.md` | AI-generated markdown report | `example-com.mobile.report.agent.gpt5.summary.md` |
| `*.har` | HTTP Archive files | `example-com.mobile.har` |
| `*.report.json` | Complete analysis reports | `example-com.mobile.report.json` |

## 🔧 Advanced Features

### Custom Models
```bash
# Use different AI model
node index.js --url example.com --model gpt-4o
```

### Request Blocking
```bash
# Block analytics and ads during collection
node index.js --action collect --url example.com --block-requests "google-analytics,facebook"
```

### Visualization
```bash
# Start local server for report visualization
npx live-server --mount=/.cache:./.cache

# Open visualization UI
open http://127.0.0.1:8080/ui/index.html?report=/.cache/example-com.mobile.report.json
```


## 🔍 Data Collection Details

### What Gets Collected
- **CrUX Data**: Real user experience metrics from Chrome UX Report
- **PSI Audit**: PageSpeed Insights performance audit
- **HAR Files**: Complete HTTP archive of page load
- **Performance Entries**: Browser performance API data
- **First-Party Code**: JavaScript and CSS files for analysis

### Cache Strategy
- Results cached by URL and device type
- Use `--skip-cache` to force fresh data collection
- Cache files stored in `.cache/` directory

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes and test thoroughly
4. Commit your changes: `git commit -m 'Add amazing feature'`
5. Push to the branch: `git push origin feature/amazing-feature`
6. Open a Pull Request

---

**Built with ❤️ for better web performance**
