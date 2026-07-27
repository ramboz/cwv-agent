---
issue_type: unused-code
risk_tier: medium

required_validation:
  - lighthouse_coverage_confirms_unused
  - not_polyfill
  - not_user_action_gated
  - cross_template_usage_checked

forbidden_techniques:
  - pattern: 'core-js|@babel/polyfill|regenerator-runtime'
    reason: "Polyfills appear unused at runtime if the browser already has the feature — never remove polyfill imports based on coverage data alone"

---

# Unused code

> **Risk tier:** medium · **CWV metric:** LCP, TBT

## What this addresses

Lighthouse coverage reports that some bytes of CSS/JS are downloaded but never executed on this page. Removing them reduces transfer time and parse time. The pitfall: "unused on this page" doesn't mean "unused everywhere" — code that's dormant on the audited URL may be critical on a different template.

## When to apply / when to skip

**Apply when:**
- Lighthouse coverage data confirms the bytes are genuinely unused (not just uncovered by this page's flow)
- The code is not a polyfill (polyfills appear unused at runtime in modern browsers but are still required for older ones)
- The code is not gated behind a user action (modal handler, accordion toggle) that just didn't fire during the audit
- Cross-template usage is verified — a bundle unused on this page may be used on the homepage

**Skip when:**
- The audited page is one of many; coverage data from a single URL is insufficient to confirm "globally unused"
- The code is a polyfill (`core-js`, `@babel/polyfill`, `regenerator-runtime`)
- The code is feature-gated (modal, drawer, autocomplete) — Lighthouse audit didn't trigger it
- The code is conditionally executed by user agent / viewport / cookie — coverage on a single audit run doesn't capture all branches

## Recommended approaches

### Remove a confirmed-unused CSS rule

```css
/* Before — coverage shows .legacy-promo never matches anywhere */
.legacy-promo { ... }      /* delete */
.legacy-promo:hover { ... } /* delete */

.product-card { ... }       /* keep */
```

After confirming the selector matches no element across the site (not just this page), delete the rules.

### Move feature-gated code behind a dynamic import

```javascript
// Before — modal code in main bundle, only used if user opens it
import { openModal } from './modal.js';
button.addEventListener('click', openModal);

// After — modal code loads only when needed
button.addEventListener('click', async () => {
  const { openModal } = await import('./modal.js');
  openModal();
});
```

Doesn't remove the code globally, but removes it from the critical-path bundle.

## Anti-patterns

### Removing a polyfill because coverage says it's unused

```javascript
// Bad
- import 'core-js/features/array/at';
- import 'regenerator-runtime/runtime';
```

**Why this is bad:** Polyfills appear unused on modern browsers because the native feature exists. Removing them breaks the site on older browsers in production. Coverage data is collected from a modern Chrome — not representative of the full audience.

### Removing feature-gated code because the audit didn't trigger it

```javascript
// Bad — removed because coverage said unused
- function openSearchOverlay() { ... }
- searchButton.addEventListener('click', openSearchOverlay);
```

**Why this is bad:** Coverage records what executed during the audit run. If the audit didn't click the search button, the handler shows as unused. The user will click it in production and the site breaks.

### Removing CSS based on a single page's coverage

```css
/* Bad — removed because coverage on /home says unused */
- .product-grid__item { ... }
```

**Why this is bad:** `.product-grid__item` may be used on `/products` but not on `/home`. Coverage from a single URL is insufficient. Confirm the selector matches no element across the site (or sample multiple page templates) before removing.
