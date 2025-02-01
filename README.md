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
node index.js <action> <url> [<device>]
```

where:
- `action` either `collect` to just fetch the relevant artifacts, or `analyze` to also run the LLM on those files
- `url` is the page you want to test, like `https://www.aem.live`
- `device` is the device type you want to optimize for. Either `mobile` or `desktop` (defaults to `mobile`)

### Collecting the artifacts

```sh
node index.js collect <url> [<device>]
```

This will automatically collect:
- the HAR for the page load, including throttling when on mobile
- the PSI audit for the page
- the 1st-party code files used by the page

### Running the analysis

```sh
node index.js analyze <url> [<device>]
```

Collects all the artefacts and then prompts the LLM (Gemini 1.5 Pro) for the performance analysis
and recommendations.
