# Content-Security-Policy Evidence

The launcher injects the CWV measurement script with `evaluateOnNewDocument`,
before page scripts run. That script listens for `securitypolicyviolation`
events and exposes them in `runs[].cwv.cspViolations`:

```json
{
  "violatedDirective": "script-src-elem",
  "effectiveDirective": "script-src-elem",
  "blockedURI": "https://cdn.example.com/vendor.js",
  "sourceFile": "https://www.example.com/page",
  "lineNumber": 12,
  "columnNumber": 4,
  "disposition": "enforce"
}
```

The list is capped and defensive; unsupported browsers or listener failures
must not break measurement. CSP violations are diagnosis context, not a CWV
Finding by themselves.

## Failed Patch Signal

When a run uses `--patches`, `launcher.js` records a compact
`appliedPatches` summary with URL-bearing patch surfaces (`preloads`,
`rewriteBody.urlPattern`, `block`, header `urlPattern`s, and `markup`
`src`/`href` hints). `chain-rum-correlator.js` compares
`cwv.cspViolations[].blockedURI` against that summary.

- If a baseline run has CSP violations but no matching applied patch, the
  violations remain in `diagnostics.csp.violations`.
- If a patched run blocks a patched or injected resource, the match is surfaced
  in `diagnostics.csp.blockedPatches`.
- If an emitted Finding carries a matching `patches` entry, the correlator
  appends `evidence: { kind: "csp-violation", data: ... }` to that Finding.

This prevents a false "patch had no effect" read: the treatment may have been
blocked by page policy rather than causally inert.
