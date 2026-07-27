# Font Face Signal

The launcher injects `.agents/scripts/collect-fonts.js` before page scripts and
adds a `fonts` block to every run:

```json
{
  "fonts": {
    "count": 1,
    "loaded": 1,
    "swapRisk": 1,
    "faces": [],
    "usedFonts": {
      "h1": "Brand Sans, Arial, sans-serif",
      "body": "Brand Sans, Arial, sans-serif"
    }
  }
}
```

## What It Unlocks

Font swap can move text after first paint (CLS) or gate a text LCP element. The
important fix knobs are not just "preload the font"; they are the metric
override descriptors that make fallback text reserve the same box:

- `size-adjust`
- `ascent-override`
- `descent-override`
- `line-gap-override`

`chain-rum-correlator.js` C7 consumes this signal when a swap-risk face
(`font-display: swap`, `auto`, or unset) appears in the computed font stack for:

1. a text LCP element (`h1`-`h6`, `body`, `p`, `button`, `a`) with high LCP or
   high `elementRenderDelay`; or
2. a text CLS shift source captured in `cwv.cls.shifts[]`.

It emits a `source: "perf_observer"` finding capped at 0.85 confidence with
`font-face` and `cwv-attribution` evidence. The recommendation is to add a
size-adjusted fallback face and put it immediately after the brand face in the
stack. Use preload only when the face is truly on the LCP path.

## Payload Shape

Each face includes browser-normalized descriptors:

```json
{
  "family": "Brand Sans",
  "style": "normal",
  "weight": "700",
  "stretch": "normal",
  "display": "swap",
  "unicodeRange": "U+000-5FF",
  "featureSettings": "normal",
  "ascentOverride": null,
  "descentOverride": null,
  "lineGapOverride": null,
  "sizeAdjust": null,
  "status": "loaded"
}
```

`usedFonts` records representative computed font stacks for `h1`-`h6`, `body`,
`p`, `button`, and `a`. A system-font-only page still produces `usedFonts` with
an empty `faces` list. Unsupported or missing `document.fonts` returns an empty
face list rather than failing measurement.
