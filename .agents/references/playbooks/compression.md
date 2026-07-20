---
issue_type: compression
applicable_flavors: [cs, ams]
risk_tier: low

required_validation:
  - cdn_yaml_present
  - dispatcher_writable_for_ams

forbidden_techniques:
  - pattern: 'gzip:\s*off|brotli:\s*off|compress:\s*off'
    reason: "Don't disable compression — that's the inverse of the fix"
  - pattern: 'AddOutputFilterByType\s+(?!DEFLATE)'
    reason: "AMS Apache: use AddOutputFilterByType DEFLATE — anything else doesn't enable compression"

flavor_overrides:
  cs:
    extra_validation:
      - cdn_yaml_under_dispatcher_src
  ams:
    extra_validation:
      - apache_conf_writable
      - mod_deflate_loaded
---

# Compression

> **Risk tier:** low · **Applies to:** CS, AMS (EDS = N/A: platform-managed) · **CWV metric:** LCP, FCP

## What this addresses

Text resources (HTML, CSS, JS, JSON) compress at 70-90% with gzip/brotli. Without compression, every byte ships uncompressed across the wire — directly increasing transfer time for LCP-blocking CSS/JS.

This is a **CDN/dispatcher configuration** concern, not an application-code change. The agent emits a config file edit, not a markup or stylesheet edit.

## When to apply / when to skip

**Apply when:**
- (CS) `cdn.yaml` exists under `dispatcher/src/` and is editable — emit a 2-3 line YAML config change
- (AMS) Apache `mod_deflate` is loaded and `AddOutputFilterByType DEFLATE` directives are missing for text MIME types

**Skip when:**
- (CS) `cdn.yaml` is absent — flag as "Cloud Manager UI / infra change required" and **do not emit a code fix**
- (AMS) Compression is handled at a CDN tier above the dispatcher — flag for the ops team
- EDS — never; compression is platform-managed end-to-end

## Recommended approaches

### CS: cdn.yaml compression block

```yaml
# Good — under dispatcher/src/cdn.yaml
kind: CDN
version: "1"
data:
  ...
  compression:
    enabled: true
    types:
      - text/html
      - text/css
      - application/javascript
      - application/json
      - image/svg+xml
```

A small YAML edit; the platform handles encoding negotiation and the `Vary: Accept-Encoding` header.

### AMS: Apache mod_deflate config

```apache
# Good — in dispatcher conf.d/
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css text/plain text/xml \
                                application/javascript application/json \
                                application/xml image/svg+xml
</IfModule>
```

## Anti-patterns

### Compressing pre-compressed binary formats

```yaml
# Bad — including image/png in compression types
compression:
  types:
    - text/html
    - image/png
    - image/jpeg
```

**Why this is bad:** PNG/JPEG/WebP are already compressed; gzipping them adds CPU cost on both ends with no size reduction (sometimes a slight increase). Limit compression to text-based MIME types.

### Disabling compression with comments left intact

```apache
# Bad — disabled but the directive looks active in a quick scan
# AddOutputFilterByType DEFLATE text/html text/css
```

**Why this is bad:** Configuration drift — code review sees the directive, ops sees no compression. Either remove the directive entirely or actively enable it; never leave commented-out config in place as a "TODO."

### Mixing `Content-Encoding: gzip` headers manually with mod_deflate

Setting `Header set Content-Encoding gzip` while `mod_deflate` is also active causes double-encoding — clients receive `Content-Encoding: gzip` but the body is gzipped twice. Use one mechanism, not both.

## Flavor-specific notes

### CS

Look for `cdn.yaml` under `dispatcher/src/`. If present, the fix is a 2-3 line YAML change shipping with the dispatcher artifact. If absent, compression is configured in Cloud Manager UI — not a code fix.

### AMS

Verify `mod_deflate` is loaded (`LoadModule deflate_module modules/mod_deflate.so` in the Apache config). The `<IfModule>` guard handles the case where it's not — the directive becomes a no-op rather than an error.

`mod_deflate` (gzip) is normally available, but **Brotli requires `mod_brotli`, which customers cannot self-install on AMS** — adding it is an Adobe support ticket, not a config commit. Default to enabling gzip via `mod_deflate` in-repo; recommend Brotli as a separate Adobe-ticket request where the extra savings justify it.
