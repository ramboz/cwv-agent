---
issue_type: ttfb
risk_tier: high

required_validation:
  - root_cause_classified
  - server_cache_config_writable
  - server_profiling_available
  - jcr_query_plan_available

forbidden_techniques:
  - pattern: 'Cache-Control:.*no-cache'
    reason: "Don't add no-cache directives — that's the inverse of fixing TTFB by improving cacheability"
  - pattern: 'max-age=0\b'
    reason: "max-age=0 forces revalidation on every request and worsens TTFB"

---

# TTFB (Time to First Byte)

> **Risk tier:** high · **CWV metric:** TTFB, LCP

## What this addresses

TTFB is the time from request start until the first byte of the response arrives. Slow TTFB blocks every other CWV metric — LCP can't start until HTML arrives. Three distinct root causes, three different fix paths:

| Root cause | Fix path | Tier |
|---|---|---|
| **CDN / server cache miss** | cache-config change in this repo | promotable to **medium** once `ttfb-cache` sub-type is split out |
| **Server-side application performance** | Server-side profiling required | high (manual) |
| **JCR query performance** | Query plan analysis required | high (manual) |

**Classify the root cause before emitting any fix.** Without classification, the playbook recommends manual investigation only.

## When to apply / when to skip

**Apply when:**
- Root cause is classified as a **cache miss**, AND the cache config is editable in this repo, AND a clear cache-rule fix exists
- (Even then) tier remains medium — verify cache rule changes don't break content invalidation

**Skip when:**
- Root cause is **server-side application performance** — recommend server-side profiling, do not emit a code fix
- Root cause is **JCR query performance** — recommend query plan analysis, do not emit a code fix
- Root cause is unclear — emit a recommendation that surfaces the audit data and asks for manual triage

## Recommended approaches

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

### Letting cloud instances cold-start under traffic

A serverless/lambda backend with no warm instances pays a cold-start cost (200ms–2s of JVM/runtime initialization) on the first request to each region. If your TTFB problem coincides with low-traffic times of day or specific geographies, cold-starts are the likely cause. The fix is **not** in this repo — it's an infra change (provisioned concurrency, scheduled warm-up pings, multi-region replication). Flag for the platform team; do not propose code-level changes.
