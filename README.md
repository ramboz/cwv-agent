# Web Page Performance Analysis Agent

The CWV Agent will analyze the specified page for performance issues and suggest various improvements.

## Usage

First install all dependencies:
```sh
npm install
```

Create a `.env` file and add your API keys:
```
GOOGLE_CRUX_API_KEY=...
GOOGLE_PAGESPEED_INSIGHTS_API_KEY=...

# Gemini Models
GOOGLE_APPLICATION_CREDENTIALS=...

# OpenAI Models
AZURE_OPENAI_API_DEPLOYMENT_NAME=...
AZURE_OPENAI_API_INSTANCE_NAME=...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_API_VERSION=...

# Claude Models
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=...

# GitHub Integration (for accessibility PR creation)
GITHUB_TOKEN=ghp_your_github_personal_access_token_here
```

Then run the script via:
```sh
node index.js --action <action> --url <url> [--device <device>] [--skip-cache] [--model <model>] [--repo owner/repo-name]
```

or for batch processing:
```sh
node index.js --action <action> --urls <path-to-json-file> [--device <device>] [--skip-cache] [--model <model>]
```

### Options

```
Options:
  --action, -a  Action to perform
                [string] [choices: "collect", "prompt", "merge", "agent", "rules", "accessibility", "accessibility-collect", "accessibility-pr"] [default: "collect"]
  --url, -u     URL to analyze                                            [string]
  --urls        Path to JSON file containing URLs to analyze              [string]
  --device, -d  Device type
                [string] [choices: "mobile", "desktop"] [default: "mobile"]
  --skip-cache, -s  Skip using cached data and force new collection       [boolean] [default: false]
  --model, -m   LLM model to use (e.g., "gemini-2.5-pro-preview-05-06", "gpt-4.1", "claude-3-7-sonnet-20250219")
                [string] [default: "gemini-2.5-pro-preview-05-06"]
  --repo        GitHub repository for PR creation (format: owner/repo-name, required for accessibility-pr action)
  --help        Show help                                                 [boolean]
```

Either `--url` or `--urls` must be provided.

### Supported Models

The agent supports both Gemini (via Vertex AI), OpenAI (via Azure) and Claude (via AWS Bedrock) models:

#### Gemini Models
- `gemini-2.5-pro-preview-05-06` (default)
- `gemini-2.5-flash-preview-05-20`

#### OpenAI Models
- `gpt-4.1`
- `gpt-4o`

#### Claude Models via Amazon Bedrock
- `claude-3-7-sonnet-20250219` (coming soon)

### Batch Processing

To analyze multiple URLs at once, create a JSON file with an array of URLs:

```json
[
  "https://example.com",
  "https://example.org",
  "https://example.net"
]
```

Then run:
```sh
node index.js --action prompt --urls urls.json --device mobile
```

### Collecting the artifacts

```sh
node index.js --action collect --url <url> [--device <device>]
```

This will automatically collect:
- the CrUX data for the URL
- the PSI audit for the page
- the HAR for the page load, including throttling when on mobile
- the Performance Entries triggered during the page load
- the 1st-party code files used by the page

### Evaluating the hardcoded rules

```sh
node index.js --action rules --url <url> [--device <device>]
```

Collects the artifacts and runs the predefined rules against the web page to identify performance optimizations.

### Running the LLM analysis

```sh
node index.js --action prompt --url <url> [--device <device>] [--model <model>]
```

Collects all the artefacts and then prompts the LLM for the performance analysis
and recommendations.

### Accessibility Analysis

The agent also supports accessibility analysis with WCAG 2.1 AA compliance checking:

#### Complete Accessibility Workflow

To run the full accessibility analysis and create a GitHub PR, follow these steps:

1. **First, collect the basic data** (required for accessibility analysis):
```sh
node index.js --action collect --url <url> [--device <device>]
```

2. **Run accessibility analysis with source code collection**:
```sh
node index.js --action accessibility-collect --url <url> [--device <device>]
```

3. **Create GitHub PR with fixes** (optional):
```sh
node index.js --action accessibility-pr --url <url> [--device <device>] --repo owner/repo-name
```

#### Individual Actions

#### Quick HTML Analysis
```sh
node index.js --action accessibility --url <url> [--device <device>]
```
Requires existing cached HTML data from a previous `collect` action.

#### Complete Analysis with Source Code
```sh
node index.js --action accessibility-collect --url <url> [--device <device>]
```
Analyzes both HTML and source code files, generating PR-ready fixes.

#### Automated GitHub PR Creation
```sh
node index.js --action accessibility-pr --url <url> [--device <device>] --repo owner/repo-name
```
Creates a GitHub pull request with accessibility fixes. Requires GITHUB_TOKEN in .env file.

For GitHub integration, create a personal access token with `repo` scope at GitHub → Settings → Developer settings → Personal access tokens.

### Cache Management

By default, the tool caches results to avoid unnecessary API calls and speed up repeated analyses.
For the `prompt` action, it will use cached reports if available.

To force new data collection and ignore cached data:
```sh
node index.js --action prompt --url <url> --skip-cache
```

### Visualization

To visualize a report, start your favorite http server, like:

```
npx live-server --mount=/.cache:./.cache
```

Then open the ui and pass the `report` url:

```
open http://127.0.0.1:8080/ui/index.html?report=/.cache/host.device.report.json
```

For accessibility reports:
```
open http://127.0.0.1:8080/ui/accessibility.html?report=/.cache/host.device.accessibility-report.md
```