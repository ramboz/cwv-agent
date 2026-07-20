# Caching

The cache layer at `.agents/scripts/cache.js` is an **orchestrator-level**
utility. Individual analyzers (`coverage.js`, `image-analysis.js`,
`html-parse.js`, `waterfall-shift.js`) and producers (`launcher.js`,
`rum-fetch.js`) remain cache-unaware. Callers opt in.

See also: [`finding-schema.md`](./finding-schema.md) for the envelope that
cached results are eventually rendered into.

## Measured Cache And Transport Signal

The launcher now records cache/connection evidence through
`collect-resources.js`; this is separate from the workbench result-cache
utility described below.

Each `resources.all[]` entry includes subresources and the top-level
navigation timing entry when the browser exposes it. Entries include:

- `ttfb`: `responseStart - requestStart`, rounded to milliseconds, or `null`
  when resource timing redacts the phase.
- `nextHopProtocol`: the browser-reported transport protocol, such as `h2`,
  `h3`, or `http/1.1`.
- `serverTiming`: mapped `Server-Timing` entries as
  `{ name, duration, description }[]`, or `null` when the response did not
  expose them. Cross-origin responses without `Timing-Allow-Origin` usually
  land here as `null`; do not infer cache status from absence.

The resource snapshot also derives:

- `resources.http1[]`: resources whose protocol is `http/1.x`.
- `resources.cdnCacheMiss[]`: resources or navigation entries with
  `serverTiming` names that look like cache/CDN/edge and descriptions that look
  like `MISS`, `expired`, `stale`, `bypass`, `revalidate`, or `fwd=uri-miss`.

`chain-rum-correlator.js` consumes these fields in pure lab mode:

- render-blocking or pre-LCP HTTP/1.x resources emit `source: "har"`
  connection findings capped at 0.85 confidence;
- navigation or critical-path CDN/cache misses with TTFB >= 800 ms emit
  `source: "har"` cache findings;
- any resource with per-resource TTFB >= 800 ms emits a slow-resource TTFB
  finding with the offending URL(s), unless the same URL is already explained
  by the more specific CDN/cache-miss finding.

Use the raw `resource-timing` evidence to distinguish "TTFB is slow because
the edge missed" from "TTFB is slow but cache status is unknown." A missing
`serverTiming` value is not a cache miss.

## When caching helps

- **Re-running an audit** on the same URL within the hour. `cwv-analyze` on
  one URL routinely burns 60+ seconds across Puppeteer-based analyzers
  (coverage, image-analysis) on a slow-4G profile.
- **Scanning many URLs** where some share upstream data (CrUX, RUM).
- **Iterating on finding formatting** without re-measuring: the raw
  analyzer output is cached; re-derive findings from it cheaply.

## When caching hurts

- **Fix-iteration loops**: after you edit the page or the patches bundle,
  you *want* fresh measurements. Pass `force: true` from the orchestrator
  after each edit, or bust the cache key by feeding a content-hash of the
  changed inputs.
- **Flakiness investigation**: caching masks variance across runs. Bypass
  it explicitly when you are hunting noise.

## TTL rationale

| Namespace         | TTL   | Why                                                 |
|-------------------|-------|-----------------------------------------------------|
| `launcher`        | 1 h   | Lab measurement at fixed throttling; shorter windows mostly re-measure noise. |
| `coverage`        | 1 h   | Same — Puppeteer on slow-4G, deterministic-ish.     |
| `image-analysis`  | 1 h   | Same.                                               |
| `html-parse`      | 15 m  | Markup changes more often than assets.              |
| `crux`            | 24 h  | CrUX updates daily at most.                         |
| `rum`             | 6 h   | RUM bundles update hourly but aggregate moves slowly. |
| `waterfall-shift` | *off* | Pure analysis over already-cached launcher output. ~100 ms. |

Exposed as `DEFAULT_TTLS`; callers can override with `ttlSec`.

## Cache-key derivation rules

`cacheKey(obj)` computes `sha1(stableStringify(obj))` — keys are sorted
recursively, so `{url, profile}` and `{profile, url}` collide as intended.

**Include everything that changes the answer:**

- For `launcher`: `{ url, profile, patchesHash }`. Pass a `patchesHash` —
  never a file path — because the same path can point to different JSON
  across edits. Callers should read `patches.json` and hash its contents
  before calling.
- For `coverage` / `image-analysis`: `{ url, profile, patchesHash }`
  following the same rule.
- For `html-parse`: `{ url, patchesHash }` (profile does not affect markup
  in most cases; include it if your analyzer is profile-sensitive).
- For `crux`: `{ url, formFactor }`. No patches — CrUX is field data.
- For `rum`: `{ domain, window }` — e.g., `{ domain: 'example.com', window: '7d' }`.

**A launcher run WITH `--patches` MUST NOT share a cache key with a run
WITHOUT patches.** Always pass `patchesHash: null` (or omit it) for the
baseline and the real hash for patched runs — `cacheKey` will distinguish
them because the stable-stringified payloads differ.

## Inspecting, clearing, bypassing

```
# Overview of what's cached and how big
node .agents/scripts/cache.js list

# Metadata for a specific entry (not the stored result)
node .agents/scripts/cache.js inspect launcher a1b2c3

# Nuke one namespace
node .agents/scripts/cache.js clear launcher --yes

# Nuke everything
node .agents/scripts/cache.js clear --yes

# Bypass from code (still writes the fresh result)
await runWithCache({ namespace: 'launcher', key, producer, force: true });
```

Override the cache root for tests or isolated runs:

```
CWV_CACHE_ROOT=/tmp/my-cache node .agents/scripts/cache.js list
```

## Storage

- On disk at `.agents/.cache/<namespace>/<sha1>.json` (gitignored).
- Entry shape: `{ createdAt, ttlSec, keyJson, result }`.
- Corrupted JSON is treated as a miss and the file is deleted.
- On disk-full / EROFS / permission errors the producer runs and the
  result is returned; a warning is emitted on stderr. No throw.

## Eviction

- Count-based: on write, if a namespace exceeds **100 entries**, the
  oldest **20** (by mtime) are deleted.
- Time-based: on read, any entry older than its TTL is deleted and
  treated as a miss.
- No size-based eviction today — see follow-ups in the module header if
  cached results grow large (e.g., compressed coverage blobs).

## Cross-reference

- [`finding-schema.md`](./finding-schema.md) — cached results are raw
  analyzer output; `runWithCache` stores/returns whatever the producer
  returns, so the envelope is constructed *after* the cache lookup.
