---
issue_type: compression
risk_tier: low

required_validation:
  - cdn_yaml_present
  - server_config_writable

forbidden_techniques:
  - pattern: 'gzip:\s*off|brotli:\s*off|compress:\s*off'
    reason: "Don't disable compression — that's the inverse of the fix"
  - pattern: 'AddOutputFilterByType\s+(?!DEFLATE)'
    reason: "Apache: use AddOutputFilterByType DEFLATE — anything else doesn't enable compression"

---

# Compression

> **Risk tier:** low · **CWV metric:** LCP, FCP

## What this addresses

Text resources (HTML, CSS, JS, JSON) compress at 70-90% with gzip/brotli. Without compression, every byte ships uncompressed across the wire — directly increasing transfer time for LCP-blocking CSS/JS.

This is a **CDN/server configuration** concern, not an application-code change. The agent emits a config file edit, not a markup or stylesheet edit.

## When to apply / when to skip

**Apply when:**
- The CDN/server config is in this repo and editable (e.g. an `nginx.conf`, Apache conf, or CDN config file) — emit a small config change

**Skip when:**
- The config is not in this repo — flag as "infra change required" and **do not emit a code fix**
- Compression is handled at a managed CDN tier above the origin — flag for the ops team; managed platforms often handle compression end-to-end

## Recommended approaches

### Nginx gzip/brotli config

```nginx
# Good — in the server or http block
gzip on;
gzip_types text/html text/css text/plain application/javascript
           application/json application/xml image/svg+xml;
gzip_min_length 1024;
# brotli (if the module is available)
brotli on;
brotli_types text/html text/css application/javascript application/json image/svg+xml;
```

### Apache mod_deflate config

```apache
# Good — in the vhost or conf.d/
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css text/plain text/xml \
                                application/javascript application/json \
                                application/xml image/svg+xml
</IfModule>
```

The server handles encoding negotiation and the `Vary: Accept-Encoding` header.

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
