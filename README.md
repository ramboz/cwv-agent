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
# Quick analysis with AI suggestions
node index.js --action prompt --url "https://example.com"

# Collect raw performance data
node index.js --action collect --url "https://example.com" --device mobile

# Start interactive MCP reviewer, but cursor should do it for you automatically
node index.js --action mcp-reviewer
```

## 📋 Available Actions

| Action | Description | Example |
|--------|-------------|---------|
| `collect` | Collect raw performance data (CrUX, PSI, HAR) | `--action collect --url example.com` |
| `prompt` | Generate AI-powered optimization suggestions | `--action prompt --url example.com` |
| `rules` | Apply predefined performance rules | `--action rules --url example.com` |
| `agent` | Run the full AI agent workflow | `--action agent --url example.com` |
| `mcp-reviewer` | Start interactive suggestion reviewer | `--action mcp-reviewer` |

## 🎛️ Command Line Options

```bash
node index.js [options]

Options:
  --action, -a     Action to perform [collect|prompt|rules|agent|mcp-reviewer]
  --url, -u        URL to analyze
  --urls           Path to JSON file with multiple URLs
  --device, -d     Device type [mobile|desktop] (default: mobile)
  --skip-cache, -s Skip cached data and force new collection
  --model, -m      LLM model to use (default: gemini-2.5-pro-preview-05-06)
  --output-suffix  Suffix for output files
  --block-requests Block specific requests (comma-separated)
  --help           Show help
```

## 🤖 Supported AI Models

### Gemini Models (via Vertex AI)
- `gemini-2.5-pro-preview-05-06` (default, recommended)
- `gemini-2.5-flash-preview-05-20` (faster, less detailed)

### OpenAI Models (via Azure)
- `gpt-5` (latest GPT-5 model)
- `gpt-4o` (GPT-4 model)
- `gpt-4.1` (previous version)

### Claude Models (via AWS Bedrock)
- `claude-3-7-sonnet-20250219` (coming soon)

## 🎯 Interactive MCP Reviewer

The CWV Agent includes a powerful MCP (Model Context Protocol) reviewer for interactive suggestion management within Cursor IDE.

**📖 For complete setup instructions, see: [MCP-REVIEWER-GUIDE.md](./MCP-REVIEWER-GUIDE.md)**

## 📁 Workflow Examples

### Single URL Analysis
```bash
# Complete analysis workflow
node index.js --action prompt --url "https://www.qualcomm.com" --device mobile
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
node index.js --action prompt --urls urls.json --device mobile
```

### Force Fresh Data
```bash
# Skip cache and collect new data
node index.js --action prompt --url "https://example.com" --skip-cache
```

## 📊 Output Files

The tool generates files in the `.cache/` directory:

| File Type | Description | Example |
|-----------|-------------|---------|
| `*.performance.json` | Raw performance data | `example-com.mobile.performance.json` |
| `*.suggestions.*.json` | AI-generated suggestions | `example-com.mobile.suggestions.gemini25pro.json` |
| `*.har` | HTTP Archive files | `example-com.mobile.har` |
| `*.report.json` | Complete analysis reports | `example-com.mobile.report.json` |

## 🔧 Advanced Features

### Custom Models
```bash
# Use different AI model
node index.js --action prompt --url example.com --model gpt-4o
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