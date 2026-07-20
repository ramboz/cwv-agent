---
issue_type: ttfb
applicable_flavors: [cs, ams]
risk_tier: high

required_validation:
  - root_cause_classified
  - dispatcher_conf_d_writable
  - sling_profiling_available
  - jcr_query_plan_available

forbidden_techniques:
  - pattern: 'Cache-Control:.*no-cache'
    reason: "Don't add no-cache directives — that's the inverse of fixing TTFB by improving cacheability"
  - pattern: 'max-age=0\b'
    reason: "max-age=0 forces revalidation on every request and worsens TTFB"

flavor_overrides:
  cs:
    extra_validation:
      - cdn_yaml_present
  ams:
    extra_validation:
      - apache_dispatcher_writable
---

# TTFB (Time to First Byte)

> **Risk tier:** high · **Applies to:** CS, AMS (EDS = N/A: CDN-delivered with no server-side rendering path) · **CWV metric:** TTFB, LCP

## What this addresses

TTFB is the time from request start until the first byte of the response arrives. Slow TTFB blocks every other CWV metric — LCP can't start until HTML arrives. Three distinct root causes, three different fix paths:

| Root cause | Fix path | Tier |
|---|---|---|
| **Dispatcher / CDN cache miss** | `dispatcher/conf.d/` config change | promotable to **medium** once `ttfb-cache` sub-type is split out |
| **Sling model / Java performance** | Server-side profiling required | high (manual) |
| **JCR query performance** | Query plan analysis required | high (manual) |

**Classify the root cause before emitting any fix.** Without classification, the playbook recommends manual investigation only.

## When to apply / when to skip

**Apply when:**
- Root cause is classified as **dispatcher cache miss**, AND `dispatcher/conf.d/` is editable in this repo, AND a clear cache rule fix exists
- (Even then) tier remains medium — verify cache rule changes don't break content invalidation

**Skip when:**
- Root cause is **Sling/Java performance** — recommend server-side profiling, do not emit a code fix
- Root cause is **JCR query performance** — recommend query plan analysis, do not emit a code fix
- Root cause is unclear — emit a recommendation that surfaces the audit data and asks for manual triage
- EDS — never; CDN-delivered, no server-side rendering path

## Recommended approaches

### Dispatcher cache rule fix (CS/AMS)

When a cacheable page is being served uncached due to a missing or misconfigured rule:

```apache
# Good — in dispatcher/conf.d/rewrites/rewrite.rules or similar
<IfModule mod_dispatcher.c>
  /cache {
    /docroot "/var/cache/dispatcher"
    /rules {
      /0001 { /glob "/content/site/*" /type "allow" }
    }
    /allowedClients {
      /0001 { /glob "*" /type "allow" }
    }
  }
</IfModule>
```

Verify the rule doesn't conflict with content invalidation (the cache must be invalidated when content publishes, otherwise stale pages serve forever).

### Add cacheable response headers (when source code allows)

```java
// Good — set Cache-Control on a cacheable response
response.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
```

`stale-while-revalidate` keeps TTFB low while content updates asynchronously.

### Eliminate redirect chains

```text
# Bad chain (each hop adds DNS + TLS + processing time)
http://example.com/article
  → 301 → https://example.com/article
  → 301 → https://www.example.com/article
  → 301 → https://www.example.com/articles/title-slug
```

```text
# Good — direct to the canonical URL
http://example.com/article  → 301 → https://www.example.com/articles/title-slug
```

Lighthouse's [redirect chain audit](https://developer.chrome.com/docs/lighthouse/performance/redirects) flags multi-hop redirects. Each hop costs ~150–300ms even on fast connections; eliminating intermediate hops by redirecting directly to the canonical URL is a one-line config change with measurable TTFB impact.

## Anti-patterns

### Disabling caching to "fix freshness"

```http
Cache-Control: no-cache, no-store, must-revalidate
```

**Why this is bad:** `no-cache` forces revalidation on every request — origin TTFB on every hit. If you're hitting this playbook because TTFB is bad, disabling caching makes it worse. Use `stale-while-revalidate` if freshness is a concern; configure cache invalidation properly if not.

### `max-age=0` to "make sure content is fresh"

```http
Cache-Control: public, max-age=0
```

**Why this is bad:** Same effect — every request hits origin. Use a real TTL with proper invalidation hooks.

### Trying to fix Sling/JCR performance via dispatcher config

If the root cause is a slow Sling component or unindexed JCR query, no amount of dispatcher config helps because the cache-miss path is what's slow. The fix is server-side. Don't emit dispatcher changes for this case.

### Letting cloud instances cold-start under traffic

A serverless/lambda backend with no warm instances pays a cold-start cost (200ms–2s of JVM/runtime initialization) on the first request to each region. If your TTFB problem coincides with low-traffic times of day or specific geographies, cold-starts are the likely cause. The fix is **not** in this repo — it's an infra change (provisioned concurrency, scheduled warm-up pings, multi-region replication). Flag for the platform team; do not propose code-level changes.

## Flavor-specific notes

### CS

Look for `cdn.yaml` in the repo and `dispatcher/src/conf.d/` for cacheable-route configuration. The cache-miss subset (`ttfb-cache`) is the auto-fixable portion; Sling/JCR portions remain manual.

**Diagnose the cache layer from response headers before proposing a fix:** `X-Cache: HIT/MISS` (CDN), `Age: <seconds>` (how long the cached copy has lived), `X-Dispatcher: hit` (dispatcher served it). `Age: 0` or `X-Cache: MISS` on most requests means content is generated fresh every request — almost always the publish tier's `Cache-Control` isn't permitting dispatcher caching, or the path isn't in the dispatcher cache rules. A short `Age` (always <60s) with frequent HITs signals high cache turnover (check TTLs / invalidation frequency). Use `Server-Timing` (if enabled) to split `cdn` / `dispatcher` / `origin` time. **Marketing query params (`utm_*`, `gclid`) defeat the dispatcher cache** — query-string paths are uncacheable by default; normalize them or configure the dispatcher to ignore them. A broad `.publish` on root triggers an invalidation storm (cache-warmup TTFB spike) — coordinate publishes / use fine-grained invalidation.

### AMS

Apache `mod_dispatcher` configuration in the dispatcher conf. Verify writability and test rule changes in a stage environment before promoting.

**On AMS the customer usually cannot self-edit `dispatcher.any`, CDN rules, or response headers** — those go through an Adobe support ticket with days-to-weeks turnaround. So a dispatcher/CDN TTFB fix is a **recommendation to file with Adobe** (include the proposed diff + `X-Cache: MISS` evidence), not a change that lands in a sprint. Flag infra-gated fixes as such; the fastest AMS wins are **code-level** (clientlib splitting, image handling via HTL, Sling model optimization), which ship on the normal release pipeline.
