# Long Animation Frame / Long Task Attribution

The launcher injects main-thread observers through `.agents/scripts/measure-cwv.js`
and exposes them in each run under:

```json
{
  "cwv": {
    "mainThread": {
      "loaf": [],
      "longTasks": []
    }
  }
}
```

## What It Unlocks

`PerformanceLongAnimationFrameTiming` is the modern script-level bridge for
INP/TBT diagnosis. A slow INP target tells us users felt latency; LoAF tells us
which script was executing across the interaction window.

`chain-rum-correlator.js` C1 uses this signal when all three are true:

1. RUM p75 INP is above the 200 ms threshold.
2. The RUM interaction target matches the lab `cwv.inp.attribution.interactionTarget`.
3. A `mainThread.loaf[]` entry overlaps the lab interaction window and carries
   `scripts[]` entries with `sourceURL`.

When that happens, C1 emits a `perf_observer` INP finding with
`long-animation-frame` evidence. The evidence ranks `topScripts` by blocking
duration and names the script URL/function/invoker so the recommendation can be
about the blocking handler or hydration work, not a generic "main thread slow"
claim.

## Payload Shape

LoAF entries:

```json
{
  "startTime": 2790,
  "duration": 560,
  "renderStart": 2820,
  "styleAndLayoutStart": 3190,
  "blockingDuration": 390,
  "scripts": [
    {
      "sourceURL": "https://example.com/scripts/checkout.js",
      "sourceFunctionName": "renderPaymentOptions",
      "invoker": "EventListener.handleEvent",
      "invokerType": "event-listener",
      "duration": 310,
      "forcedStyleAndLayoutDuration": 42,
      "pauseDuration": 0
    }
  ]
}
```

Long-task entries:

```json
{
  "startTime": 251,
  "duration": 105,
  "attribution": [
    {
      "name": "script",
      "entryType": "taskattribution",
      "containerType": "iframe",
      "containerName": "chat",
      "containerSrc": "https://chat.example.com/embed.html"
    }
  ]
}
```

Both arrays are soft-capped and defensive. Unsupported Chrome APIs produce empty
arrays, not measurement failures. LoAF absence does not suppress INP diagnosis:
C1 falls back to the existing RUM/HAR deferrable-chain heuristic, and C5 still
uses raw event timing when available.

## How To Act On It

- First-party script named in `topScripts`: profile that function/path, split
  long synchronous work, and yield non-urgent work with `scheduler.yield()` or
  `setTimeout(..., 0)`.
- Third-party or tag-manager script named in `topScripts`: move the bootstrap
  after the interaction-critical path, after LCP, or into delayed/idle loading.
- High `forcedStyleAndLayoutDuration`: look for layout reads after writes,
  synchronous measurement loops, or large DOM mutation followed by forced style.
- LoAF unsupported but long tasks present: treat `longTasks[].attribution` as a
  coarse container clue only; it can name an iframe/container but usually cannot
  name the exact script function.
