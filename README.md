# Web Page Performance Analysis Agent

The CWV Agent will analyze the specified page for performance issues and suggest various improvements.

## Usage

First install all dependencies:
```sh
npm install
```

Create a `.env` file and add your API keys:
```
GOOGLE_GEMINI_API_KEY=...
GOOGLE_PAGESPEED_INSIGHTS_API_KEY=...
```

Then run the script via:
```sh
node index.js --action <action> --url <url> [--device <device>] [--skip-cache]
```

or for batch processing:
```sh
node index.js --action <action> --urls <path-to-json-file> [--device <device>] [--skip-cache]
```

### Options

```
Options:
  --action, -a  Action to perform
                [string] [choices: "collect", "prompt", "merge", "agent"] [default: "collect"]
  --url, -u     URL to analyze                                            [string]
  --urls        Path to JSON file containing URLs to analyze              [string]
  --device, -d  Device type
                [string] [choices: "mobile", "desktop"] [default: "mobile"]
  --skip-cache, -s  Skip using cached data and force new collection       [boolean] [default: false]
  --help        Show help                                                 [boolean]
```

Either `--url` or `--urls` must be provided.

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
- the HAR for the page load, including throttling when on mobile
- the PSI audit for the page
- the 1st-party code files used by the page

### Running the analysis

```sh
node index.js --action prompt --url <url> [--device <device>]
```

Collects all the artefacts and then prompts the LLM (Gemini 1.5 Pro) for the performance analysis
and recommendations.

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