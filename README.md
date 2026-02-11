# CWV Agent - Core Web Vitals Performance Analysis

A multi-agent AI system for analyzing Core Web Vitals (CWV) performance and generating actionable optimization suggestions.

## ✨ Features

- 🔍 **Comprehensive Data Collection**: CrUX field data, PSI lab audits, RUM metrics, HAR network analysis, code coverage, and more
- 🤖 **Multi-Agent AI Analysis**: 9 specialized agents analyze different aspects of performance in parallel
- 🧠 **Causal Graph Analysis**: Automatically identifies root causes vs symptoms and deduplicates findings
- ✅ **Validation System**: Evidence-based confidence calibration and impact validation
- 📱 **Multi-Device Support**: Analyze both mobile and desktop performance
- 🎯 **AEM-Aware**: Specialized contexts for EDS, AEM Cloud Service, and AMS
- 🎮 **Interactive Review**: Built-in MCP reviewer for Cursor IDE integration
- ☁️ **SpaceCat Integration**: Direct upload of approved suggestions
- 📊 **Smart Caching**: Intelligent caching to avoid redundant API calls

## 🚀 Quick Start

### Installation

```bash
npm install
```

### Environment Setup

Create a `.env` file with your API keys:

```env
# Google APIs (required for CrUX and PSI)
CRUX_API_KEY=your_crux_api_key
GOOGLE_PAGESPEED_INSIGHTS_API_KEY=your_psi_api_key

# For Gemini models (recommended)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

# For Azure OpenAI models
AZURE_OPENAI_API_INSTANCE_NAME=your-instance
AZURE_OPENAI_API_DEPLOYMENT_NAME=your-deployment
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_API_VERSION=2024-02-15-preview

# For AWS Bedrock (Claude models)
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_REGION=us-east-1

# Optional: RUM data collection
RUM_DOMAIN_KEY=your-rum-domain-key
```

### Basic Usage

```bash
# Full AI-powered analysis (default action)
node index.js --url "https://example.com"

# With RUM data (requires domain key)
node index.js --url "https://example.com" --rum-domain-key your-key

# Desktop analysis
node index.js --url "https://example.com" --device desktop

# Use a specific model
node index.js --url "https://example.com" --model gpt-4o
```

## 📋 Available Actions

| Action | Description | Example |
|--------|-------------|---------|
| `agent` | **[DEFAULT]** Multi-agent AI analysis with causal graph | `--action agent --url example.com` |
| `collect` | Collect raw performance data only (no LLM) | `--action collect --url example.com` |
| `rules` | Apply deterministic performance rules | `--action rules --url example.com` |
| `mcp-reviewer` | Start interactive suggestion reviewer | `--action mcp-reviewer` |

## 🎛️ Command Line Options

```bash
node index.js [options]

Options:
  --action, -a         Action to perform [agent|collect|rules|mcp-reviewer] (default: agent)
  --url, -u            URL to analyze
  --urls               Path to JSON file with multiple URLs
  --device, -d         Device type [mobile|desktop] (default: mobile)
  --skip-cache, -s     Skip cached data and force new collection
  --model, -m          LLM model to use (default: gemini-2.5-pro)
  --mode               Analysis mode [light|full] (default: full)
  --output-suffix, -o  Suffix for output files
  --block-requests, -b Block specific requests (comma-separated patterns)
  --rum-domain-key, -r RUM domain key for Helix RUM Bundler authentication
  --help               Show help
```

## ⚡ Analysis Modes

The CWV Agent supports two analysis modes to balance speed and depth:

### Light Mode - Fast & Focused

Optimized for quick wins and product-led growth. Focuses on 3 low-hanging fruit patterns:
- **Hero image loading** - LCP optimization (preload hints, fetchpriority, lazy loading)
- **Custom font optimization** - LCP/CLS improvements (font-display, preconnect, preload)
- **Image sizing** - CLS prevention (width/height attributes, aspect-ratio)

**Benefits:**
- ⚡ **30-50% faster** execution (30-45s vs 60-90s)
- 💰 **45-65% token savings** (40-60K vs 75-150K tokens)
- 🎯 **Focused output** on high-impact, easy-to-implement fixes

**Usage:**
```bash
node index.js --url "https://example.com" --mode=light
```

### Full Mode - Comprehensive (Default)

Deep performance audit with all agents and issue types. Detects 15+ categories including:
- Code waste (unused CSS/JS)
- Third-party scripts
- Server/network issues (TTFB, caching)
- Layout shifts and rendering issues
- JavaScript execution bottlenecks
- And more...

**Usage:**
```bash
# Full mode (default)
node index.js --url "https://example.com" --mode=full
# or simply omit --mode
node index.js --url "https://example.com"
```

### When to Use Each Mode

| Mode | Best For |
|------|----------|
| **Light** | Quick audits, PLG onboarding, initial assessments, time-sensitive reports |
| **Full** | Comprehensive audits, root cause analysis, production optimization, deep investigations |

## 🤖 Multi-Agent System

The `agent` action runs 9 specialized agents in parallel:

| Agent | Data Source | Focus | Light Mode | Full Mode |
|-------|-------------|-------|------------|-----------|
| **CrUX Agent** | Chrome UX Report | Real user p75 metrics (LCP, CLS, INP, TTFB) | ✅ | ✅ |
| **PSI Agent** | PageSpeed Insights | Lab metrics + 100+ Lighthouse audits | ✅ | ✅ |
| **HTML Agent** | DOM Analysis | Resource hints, script loading, fonts | ✅ | ✅ |
| **Perf Observer Agent** | Performance API | LCP element, CLS sources, Long Tasks | ✅ | ✅ |
| **HAR Agent** | Puppeteer HAR | Network waterfall, timing breakdown, caching | ✅ | ✅ * |
| **RUM Agent** | Helix RUM Bundler | Recent real user trends and comparisons | ❌ | ✅ ** |
| **Coverage Agent** | Puppeteer Coverage | Unused JS/CSS, pre-LCP vs post-LCP code | ❌ | ✅ * |
| **Code Review Agent** | First-party source | Anti-patterns, blocking resources | ❌ | ✅ * |
| **Rules Agent** | Heuristic rules | 18 predefined CWV best practices | ❌ | ✅ |

\* _Conditionally enabled based on PSI signals in full mode_
\*\* _Only if RUM data is available_

### Analysis Mode Behavior

**Light Mode (5 agents):**
- Runs: CrUX, PSI, HTML, Perf Observer, HAR
- Focuses on: Hero images, fonts, image sizing
- No conditional gating - all 5 agents always run

**Full Mode (up to 9 agents):**
- Runs: All agents with conditional gating
- Expensive agents (HAR, Coverage, Code) run conditionally based on PSI signals to optimize analysis time
- Detects all 15+ issue types

### Causal Graph Analysis

Findings are processed through a causal graph that:
- **Deduplicates** cross-agent findings (e.g., 3 agents reporting same hero image issue → 1 suggestion)
- **Identifies root causes** vs symptoms
- **Boosts confidence** for cross-validated findings
- **Traces critical paths** from metrics to actionable fixes

## 🔍 Advanced Analysis Features

### Request Chain Analysis
Detects sequential JavaScript loading patterns that delay interactivity:
- **Chain Detection**: Identifies multi-step request sequences in HAR data
- **Unused Code**: Highlights unnecessary code within blocking chains
- **RUM Correlation**: Maps chains to real-user INP interactions
- **Prioritization**: Focuses on chains with measurable user impact

**Example Output**:
```
JS Request Chain: 3-step sequence (1,247ms total delay)
  1. app.js → 2. vendor.js → 3. analytics.js
  ⚠️ Unused Code: 127KB (68%) unused in step 2
  ⚠️ RUM Impact: 89.5% of INP samples correlate with this chain
     - button.cta-primary (pointerdown): p75 847ms, 156 samples
```

### Multi-Agent Orchestration
9 specialized AI agents analyze performance from different angles:
- **CrUX Agent**: Real-user field data (28-day aggregates)
- **PSI Agent**: Lighthouse lab audits
- **HAR Agent**: Network waterfall analysis + chain detection
- **Coverage Agent**: Unused JavaScript/CSS detection
- **Code Agent**: Repository code analysis (AEM/EDS patterns)
- **HTML Agent**: CWV-relevant HTML extraction
- **Perf Observer Agent**: Performance API entries (LCP, CLS, LoAF)
- **RUM Agent**: Real-user monitoring correlation
- **Rules Agent**: 18+ heuristic performance rules

**Deduplication & Causal Analysis**:
- Merges duplicate findings across agents
- Builds causal dependency graph
- Identifies root causes vs symptoms
- Validates evidence quality and confidence

## 🤖 Supported AI Models

### Gemini Models (via Vertex AI) - Recommended
| Model | Context | Notes |
|-------|---------|-------|
| `gemini-2.5-pro` | 2M input, 16K output | **Default** - best balance |
| `gemini-2.5-flash` | 1M input, 8K output | Faster, good quality |
| `gemini-exp-1206` | 2M input, 8K output | Experimental 2.0 Flash Thinking |
| `gemini-1.5-flash` | 1M input, 8K output | Legacy, still supported |

### OpenAI Models (via Azure)
| Model | Context | Notes |
|-------|---------|-------|
| `o1` | 200K input, 100K output | Latest reasoning model |
| `o1-mini` | 128K input, 65K output | Faster reasoning |
| `gpt-4o` | 128K input, 16K output | Good general purpose |
| `gpt-4o-mini` | 128K input, 16K output | Faster, smaller |
| `o3-mini` | 200K input, 100K output | If available in your region |

### Claude Models (via AWS Bedrock)
| Model | Context | Notes |
|-------|---------|-------|
| `claude-sonnet-4-5-20250929` | 200K input, 16K output | Claude Sonnet 4.5 - recommended |
| `claude-opus-4-5-20251101` | 200K input, 128K output | Claude Opus 4.5 - most capable |
| `claude-haiku-4-0-20250514` | 200K input, 16K output | Claude Haiku 4.0 - fastest |

## 🎯 Interactive MCP Reviewer

The CWV Agent includes a Model Context Protocol (MCP) server for interactive suggestion management in Cursor IDE.

**📖 See: [MCP-REVIEWER-GUIDE.md](./MCP-REVIEWER-GUIDE.md)**

Available MCP tools:
- `load_cwv_suggestions` - Load from local JSON file
- `load_multi_device_suggestions` - Merge mobile + desktop
- `load_suggestions_by_url` - Auto-discover from cache
- `get_suggestions_by_url_and_type` - Query SpaceCat API
- `create_category_editor` - Edit suggestion categories
- `batch_upload_to_spacecat` - Push to SpaceCat

## 📁 Workflow Examples

### Single URL Analysis
```bash
# Complete AI-powered analysis
node index.js --url "https://www.example.com" --device mobile

# With RUM data for better field metrics
node index.js --url "https://www.example.com" --rum-domain-key YOUR_KEY
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

### Block Third-Party Scripts
```bash
# Test performance without analytics/ads
node index.js --url "https://example.com" --block-requests "google-analytics,facebook,doubleclick"
```

## 📊 Output Files

Generated in `.cache/` directory:

| Pattern | Description |
|---------|-------------|
| `*.crux.json` | CrUX API field data |
| `*.psi.json` | PageSpeed Insights lab data |
| `*.rum.json` | RUM metrics (if domain key provided) |
| `*.har.json` | HTTP Archive + summary |
| `*.perf.json` | Performance entries |
| `*.html.json` | CWV-relevant HTML extract |
| `*.coverage.json` | Code coverage data |
| `*.third-party.json` | Third-party script analysis |
| `*.cls-attribution.json` | CLS-to-CSS attribution |
| `*.suggestions.json` | Final structured suggestions |
| `*.report.*.summary.md` | Markdown report |
| `*.quality-metrics.json` | Analysis quality metrics |

## 🔍 Data Collection Details

### What Gets Collected

| Data Source | Description | Always/Conditional |
|-------------|-------------|-------------------|
| **CrUX** | Real user p75 metrics (28-day aggregate) | Always |
| **PSI** | Lab Lighthouse audit (100+ checks) | Always |
| **RUM** | Recent real user metrics | If domain key provided |
| **HAR** | Network waterfall, timing breakdown | Conditional |
| **Performance Entries** | LCP, CLS sources, Long Tasks, LoAF | Always |
| **HTML Structure** | Resource hints, scripts, fonts | Always |
| **Code Coverage** | Unused JS/CSS per segment | Conditional |
| **Third-Party Analysis** | Script categorization & impact | With HAR |
| **CLS Attribution** | CSS-to-shift mapping | With perf entries |
| **First-Party Code** | Source code for review | Conditional |

### Early Exit

If all Core Web Vitals pass "good" thresholds, the agent skips deep analysis and returns quickly with a positive report.

### AEM Detection

Automatically detects CMS type and applies specialized context:
- **EDS** (Edge Delivery Services) - Block-based architecture
- **AEM CS** (Cloud Service) - Sling Models, Dispatcher
- **AMS** (Managed Services) - Legacy components

## ⚙️ Environment Variables

### Required (per provider)

**Gemini (Google Cloud)**
```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

**Azure OpenAI**
```bash
AZURE_OPENAI_API_INSTANCE_NAME=your-instance
AZURE_OPENAI_API_DEPLOYMENT_NAME=your-deployment
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_API_VERSION=2024-02-15-preview
```

**AWS Bedrock**
```bash
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_REGION=us-east-1
```

### Optional
```bash
# API Keys
CRUX_API_KEY=your-crux-key
GOOGLE_PAGESPEED_INSIGHTS_API_KEY=your-psi-key
RUM_DOMAIN_KEY=your-rum-key

# Skip specific data collection (for debugging)
SKIP_HAR_ANALYSIS=true
SKIP_COVERAGE_ANALYSIS=true
SKIP_CODE_ANALYSIS=true
SKIP_PERFORMANCE_ENTRIES=true
SKIP_FULL_HTML=true
```

## 📐 Architecture

For detailed architecture documentation, see: [ARCHITECTURE.md](./ARCHITECTURE.md)

### High-Level Flow

```
URL Input → Data Collection → Multi-Agent Analysis → Causal Graph → Validation → Synthesis → Report
```

## 🎨 Visualization

```bash
# Start local server for report visualization
npx live-server --mount=/.cache:./.cache

# Open visualization UI
open http://127.0.0.1:8080/ui/index.html?report=/.cache/example-com.mobile.report.json
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes and test thoroughly
4. Commit your changes: `git commit -m 'Add amazing feature'`
5. Push to the branch: `git push origin feature/amazing-feature`
6. Open a Pull Request

---

**Built with ❤️ for better web performance**
