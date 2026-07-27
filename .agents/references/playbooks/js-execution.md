---
issue_type: js-execution
risk_tier: high

required_validation:
  - long_task_url_attributed
  - js_can_be_deferred_or_split
  - runtime_profiling_available

forbidden_techniques:
  - pattern: 'requestIdleCallback\s*\([^)]+,\s*\{\s*timeout:\s*[1-9]\d{4,}'
    reason: "Don't pad requestIdleCallback timeout above 10s — the task still runs and still blocks; you're hiding the symptom, not fixing it"
  # Note: setTimeout(fn, 0) is NOT regex-banned because it has legitimate uses (deferring past DOM
  # mutation, breaking out of event handlers). The prose anti-pattern below covers the
  # "fake yielding" misuse without false-positiving on legitimate cases.

see_also:
  - playbook: third-party
    edge: routes_to
    reason: "router dispatch — when the hot work is in a third-party script"
  - playbook: blocking-resource
    edge: complements
    reason: "deferring a non-critical script uses the blocking-resource deferral-safety check"

---

# JS execution

> **Risk tier:** high (without runtime profiling) · **CWV metric:** TBT, INP

## What this addresses

Long main-thread tasks (>50ms) block user interaction. Heavy JS execution during page load drives high TBT (Total Blocking Time) and bad INP (Interaction to Next Paint). The fix is either to defer non-critical scripts off the critical path, split monolithic work into chunks, or move heavy CPU work to a Web Worker.

**This issue type is largely recommendation-only without runtime profiling data.** Static analysis can identify oversized scripts but not which specific functions cause long tasks. Without `Long Task API` data or RUM, the fix is a guess.

## When to apply / when to skip

**Apply when:**
- Lighthouse "Avoid long main-thread tasks" attributes specific script URLs
- The attributed script can be deferred or split without breaking other blocks' init
- (Ideal) Long Task API data points at a specific function within the script

**Skip when:**
- No runtime profiling data (Long Task API, RUM, perf trace) — the hot path can't be reliably located
- Hot work is in a third-party script (different fix path — see [`third-party.md`](./third-party.md))
- Work is essential for above-fold render (e.g., hydration of an SPA shell — needs architectural change, not a defer)

## Recommended approaches

### Defer non-critical scripts (when source is identified)

If the long task is in a non-critical script:

```html
<!-- Good — defer pushes execution past initial render -->
<script defer src="/scripts/heavy-feature.js"></script>
```

See [`blocking-resource.md`](./blocking-resource.md) for the full deferral safety check.

### Pick the right scheduling primitive

Native scheduling APIs differ in priority and timing — using the right one matters:

| API | When to use |
|---|---|
| `scheduler.yield()` | Best modern primitive for "yield mid-task and resume soon" — preserves task continuity |
| `scheduler.postTask(fn, { priority })` | Schedule new work with explicit priority (`user-blocking` / `user-visible` / `background`) |
| `queueMicrotask(fn)` | Run *after* current task but *before* next paint — for medium-priority work that needs to settle synchronously-ish |
| `requestIdleCallback(fn)` | Run when the browser is genuinely idle — good for non-urgent telemetry / cleanup |
| `requestAnimationFrame(fn)` | Run before next paint — only for work that *modifies* the DOM/canvas in service of the next frame |

`setTimeout(fn, 0)` is **not** in this table for scheduling purposes — see anti-patterns.

### Break long tasks into chunks with `await`

```javascript
// Good — yield to the main thread between chunks
async function processItems(items) {
  for (let i = 0; i < items.length; i++) {
    processItem(items[i]);
    if (i % 50 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
      // Or with the scheduler API: await scheduler.yield();
    }
  }
}
```

Yields the main thread every 50 items so user input gets processed in between.

### Move CPU-heavy work to a Web Worker

```javascript
// Good — heavy parsing on a worker
const worker = new Worker('/workers/parse.js');
worker.postMessage(largeDataset);
worker.onmessage = (e) => render(e.data);
```

Best for genuinely CPU-bound work that takes >50ms (parsing, image manipulation, large sorting).

### Defer iframe embeds with a facade pattern

Heavy embeds (YouTube, TikTok, Instagram, Twitter) load 200–500KB of JS each just to render a thumbnail until the user clicks. A facade ships only the static thumbnail; the real iframe loads when the user actually engages.

```html
<!-- Good — lite-youtube-embed renders a thumbnail; loads the YouTube iframe only on click -->
<lite-youtube videoid="dQw4w9WgXcQ"
              style="background-image: url('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')">
  <button class="lty-playbtn" aria-label="Play video"></button>
</lite-youtube>
<script type="module" src="/scripts/lite-yt-embed.js" defer></script>
```

Several pre-built facades exist: [`lite-youtube-embed`](https://github.com/paulirish/lite-youtube-embed), [`lite-tiktok`](https://github.com/justinribeiro/lite-tiktok), [`lite-vimeo`](https://github.com/luwes/lite-vimeo-embed). For embeds without a facade, write your own with the same pattern: thumbnail markup + click handler that swaps in the real iframe.

### Defer non-critical iframes with `IntersectionObserver` or `loading="lazy"`

```html
<!-- Good — native lazy loading for offscreen iframes (videos, maps, ads) -->
<iframe src="https://www.openstreetmap.org/export/embed.html?bbox=..."
        loading="lazy" width="600" height="400"></iframe>
```

```javascript
// Or programmatically, when the iframe is far below the fold
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      const iframe = entry.target;
      iframe.src = iframe.dataset.src;
      observer.unobserve(iframe);
    }
  }
}, { rootMargin: '200px' });
document.querySelectorAll('iframe[data-src]').forEach(el => observer.observe(el));
```

`loading="lazy"` is the simpler option when you can use it (modern browsers, embed source allows late loading). The `IntersectionObserver` pattern works for any element type and gives you finer control over when to trigger.

## Anti-patterns

### Padding `requestIdleCallback` timeout

```javascript
// Bad
requestIdleCallback(doExpensiveWork, { timeout: 30000 });
```

**Why this is bad:** `timeout: 30000` says "if idle never comes, run within 30s anyway." When that fallback fires, the work still runs on the main thread and still blocks. You've delayed the long task, not eliminated it. Break the work into chunks instead.

### `setTimeout(fn, 0)` for scheduling

```javascript
// Bad
items.forEach(item => setTimeout(() => processItem(item), 0));
```

**Why this is bad:** `setTimeout(fn, 0)` queues the callback after a minimum 4ms throttle (per HTML spec). For a thousand items, that's 4 seconds of timer overhead with no real yielding. Use `scheduler.postTask()` (with priority) or `await new Promise(r => setTimeout(r, 0))` between chunks.

### Wrapping work in `requestAnimationFrame` to "make it smooth"

```javascript
// Bad
requestAnimationFrame(doExpensiveWork);
```

**Why this is bad:** `requestAnimationFrame` runs the callback on the next frame's render path. If the work is CPU-heavy, that frame drops. You've made the smoothness *worse*, not better. `rAF` is for animations that update DOM/canvas, not for "spread out" general work.
