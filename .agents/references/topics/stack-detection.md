# Stack Detection

## Overview

Core Web Vitals optimizations are **stack-specific**, and the wrong advice for a given platform is actively harmful — not just unhelpful. A few canonical examples:

- **"Inline critical CSS"** is textbook generic advice — but on AEM Edge Delivery (EDS) it breaks the `styles.css` / `lazy-styles.css` split and bypasses the CDN cache.
- **"Preload the LCP image"** is a standard Lighthouse suggestion — but on EDS it causes a duplicate fetch (the CDN already emits a `Link: rel=preload` header for eager images).
- **"Modify your Dispatcher config"** is fine advice on AEM Cloud Service — but on AEM AMS it requires filing an Adobe support ticket and has a multi-week turnaround.
- **"Edit the VCL"** is reasonable on self-operated Fastly — but on EDS the VCL is operator-managed and customer changes are blocked.

So: **detect the stack before recommending anything**. Detecting correctly means the advice applies; detecting wrong means the advice is at best ignored and at worst actively regresses the site.

This doc lists the detection heuristics — DOM fingerprints, URL patterns, bundle signatures — used by mystique's `delivery_type_detection.py` and generalized to other common stacks. Use it as a checklist when beginning an audit.

## Signals by stack

### AEM Edge Delivery Services (EDS)

| Signal | Weight |
|--------|--------|
| `<script src=".../aem.js">` or `lib-franklin.js` in `<head>` | HIGH |
| `data-block-status` attribute on DOM elements | HIGH |
| `data-block-name` attribute on DOM elements | HIGH |
| `/blocks/<name>/<name>.js` or `.css` script/CSS paths | HIGH |
| `scripts.js` file referenced (the orchestrator) | MEDIUM |
| `<div class="...block...">` pattern (block wrappers) | MEDIUM |
| `/_src/` or `/.helix/` paths in URLs or sitemap | HIGH |
| Host matches `*.hlx.live` or `*.hlx.page` | HIGH |
| RUM `rum-standalone.js` in script list | MEDIUM |
| `data-routing="...eds=..."` or JSON `dataRouting` with `eds=` | HIGH (decisive) |

### AEM XWalk / Crosswalk (AEM-authored Edge Delivery)

XWalk authors content in AEM (Cloud Service) but **publishes via Edge Delivery**,
so the *served page* shows the **EDS fingerprints above** — detect it as EDS for
CWV purposes (LCP / CLS / render-path all live in the EDS frontend repo, not the
author). The CS authoring only surfaces on the **source** side: the SpaceCat
importer stores two code channels for the site — `cm` (Cloud Manager = the author
package) and `aemy` (GitHub = the EDS frontend, the CWV fix surface). Pull/route
the **`aemy`** channel and treat the repo as `aem-eds`. See
[`source-integration.md`](./source-integration.md) (channel-aware `detectStack`)
and `source-fetch --channel aemy`.

| Signal | Weight |
|--------|--------|
| EDS fingerprints on the served page (see the EDS section) | HIGH |
| Importer stores BOTH a `cm` and an `aemy` code channel for the site | MEDIUM (source-side) |
| AEM author host (`author-p<program>-e<env>.adobeaemcloud.com`) in UE / editor metadata | MEDIUM |

### AEM Cloud Service (CS)

| Signal | Weight |
|--------|--------|
| `/etc.clientlibs/.../<name>.lc-<hash>-lc.min.(js\|css)` (CS clientlib hash format) | HIGH (decisive) |
| `data-cmp-*` attributes on components | HIGH |
| `<div class="cmp-...">` Core Component class prefix | MEDIUM |
| `data-sly-*` attributes (HTL directives leaking into markup) | MEDIUM |
| `cq:template` meta / attribute | MEDIUM |
| `sling:resourceType` in comments or data attrs | MEDIUM |
| `/libs.clientlibs/` paths | MEDIUM |
| `/content/experience-fragments/` references | MEDIUM |
| `data-cq-*` attributes | MEDIUM |
| `data-routing="...cs=..."` or JSON `dataRouting` with `cs=` | HIGH (decisive) |
| `X-Dispatcher` response header | HIGH |

### AEM Cloud Service with SPA (`AEM_CS_SPA`)

All of AEM CS signals above, PLUS at least one of:

| Signal | Weight |
|--------|--------|
| `cq:pagemodel_root_url` reference in HTML | HIGH |
| `<div id="spa-root">` or `<div id="root"></div>` | HIGH |
| `clientlib-react`, `clientlib-angular`, `clientlib-vue` | HIGH |
| `.model.json` requests in HAR or HTML | HIGH |

### AEM Adobe Managed Services (AMS)

| Signal | Weight |
|--------|--------|
| `/etc/clientlibs/` path segment (no `etc.clientlibs` proxy prefix) | HIGH |
| `/etc/designs/` path references | HIGH (decisive) |
| `/etc.clientlibs/.../<name>.min.<32-hex>.(js\|css)` (AMS hash format) | HIGH (decisive) |
| `foundation-` class prefix on legacy components | MEDIUM (decisive) |
| `cq:template`, `cq-commons`, `parsys` markers | MEDIUM |
| Legacy jQuery 1.x/2.x in `<head>` | MEDIUM |
| `/CQ/` or `/apps/` paths visible in source | LOW |
| `Server: Apache/2.4.x` at the Dispatcher layer | MEDIUM |
| `data-routing="...ams=..."` or JSON `dataRouting` with `ams=` | HIGH (decisive) |

### AEM Headless

| Signal | Weight |
|--------|--------|
| Requests to `/api/graphql/*` | HIGH |
| No server-rendered content in the HTML shell | HIGH |
| `@adobe/aem-headless-client-*` in the JS bundle | HIGH |
| `aem-headless` string anywhere in source | MEDIUM |
| `/content/dam/` references (the only remaining AEM-ness) | LOW |

### Next.js

| Signal | Weight |
|--------|--------|
| `_next/static/` asset paths | HIGH |
| `<script id="__NEXT_DATA__" type="application/json">` | HIGH |
| `next/script` runtime references | MEDIUM |
| `__next` root element | MEDIUM |

### Nuxt

| Signal | Weight |
|--------|--------|
| `_nuxt/` asset paths | HIGH |
| `window.__NUXT__` or `<script>window.__NUXT__=...</script>` | HIGH |
| `<div id="__nuxt">` root element | MEDIUM |

### React (generic, non-Next)

| Signal | Weight |
|--------|--------|
| `data-reactroot` attribute on root element | MEDIUM |
| `react-dom.production.min.js` in bundle | MEDIUM |
| React devtools hook (`__REACT_DEVTOOLS_GLOBAL_HOOK__`) referenced | LOW |

### WordPress

| Signal | Weight |
|--------|--------|
| `/wp-content/` asset paths | HIGH |
| `/wp-includes/` script paths | HIGH |
| `wp-emoji` inline script or stylesheet | MEDIUM |
| `<meta name="generator" content="WordPress ...">` | HIGH |

## Priority / ambiguity

Stacks compose. When multiple detections fire, follow these rules:

- **Outermost wins.** A Next.js site built on React still reports as **Next.js** — the platform-specific advice (Next-image, `<Script>`, App Router conventions) supersedes generic React advice. If both fire, prefer the more specific stack.
- **EDS + React for islands.** EDS sites sometimes embed React components inside blocks (e.g., product configurators). Treat the site as **EDS** but note the React regions when reviewing INP — they need React-specific scheduling.
- **AEM CS vs AMS.** Both share `cq:template`, `sling:resourceType`, and Core Components markup. Distinguish by **clientlib hash format** (`.lc-<hash>-lc.min.js` = CS; `.min.<32hex>.js` = AMS) and by `/etc/designs/` (AMS-characteristic).
- **AEM CS + SPA.** If any AEM CS signal fires AND a SPA signal fires (`cq:pagemodel_root_url`, `.model.json` request, SPA root div, SPA clientlib), classify as `AEM_CS_SPA` — the CWV advice differs (hydration timing, model.json fetch on navigation).
- **WordPress + React.** Headless WP setups often ship a React shell with WP data. If `/wp-content/` and React fingerprints both fire, treat as WordPress for backend/TTFB advice and React for frontend/INP advice.

Priority order for AEM variants (from mystique): **EDS > CS > AMS > Headless**. When a draw occurs (two types tied at max score), return unclassified rather than guess.

## Confidence scoring

Use a weighted count:

- **HIGH signal** = 3 points. Unique paths (`/etc.clientlibs/`, `_next/static/`, `/.helix/`) or decisive markers (hash format, data-routing). One HIGH is usually enough.
- **MEDIUM signal** = 1 point. Class-name conventions (`cmp-`, `helix-`, `wp-`) or generic markers that could be spoofed.
- **LOW signal** = 0.5 points. Generic cues that occur in many stacks (e.g., `/apps/` paths appearing in any Java CMS).

**Rule of thumb** (from mystique's `DELIVERY_TYPE_MIN_THRESHOLD` pattern):
- At least **one HIGH** signal, OR
- **Two MEDIUM** signals

...before declaring a stack. Below that threshold, treat as unclassified — ask the human operator or pull more evidence before giving stack-specific advice.

For decisive indicators (e.g., `/etc/designs/` for AMS, `lib-franklin.js` for EDS, `_next/static/` for Next), mystique applies large extra weights (+3 to +5) on top of the baseline pattern count — effectively promoting a single decisive signal to sufficient.

## What to do when detected

Once the stack is classified:

1. Note the detection in the audit write-up ("Detected stack: AEM CS, confidence HIGH based on `/etc.clientlibs/...lc-hash-lc.min.js` + `data-cmp-*` + `X-Dispatcher` header").
2. Pull the corresponding stack reference doc and read it before giving advice:
   - **AEM EDS:** `stacks/aem-eds.md`
   - **AEM CS:** `stacks/aem-cs.md`
   - **AEM AMS:** `stacks/aem-ams.md`
   - (Others not yet documented — note gap and proceed with platform-agnostic advice, flagging what's unverified.)
3. Re-check any recommendations against the stack's "anti-patterns" and "blocked by platform" sections before presenting — this is where generic advice goes wrong.
4. When the stack is **ambiguous** (two fire, no decisive), say so explicitly in the write-up. Do not guess; ambiguity itself is useful evidence for the operator.
