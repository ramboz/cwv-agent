#!/usr/bin/env node

/**
 * Field-faithful measurement helpers (ROADMAP G1).
 *
 * `launcher.js` historically finalized CLS right after `load` + a fixed
 * network-idle wait, and never scrolled or interacted. That misses the
 * post-load CLS that dominates the field: scroll-lazy ads, late banners, and
 * consent UI. On otempo.com.br a single load read CLS 0.0075 while CrUX field
 * p75 is 0.14 and a hand-written scroll probe read 0.30 — attributing it to the
 * cookie-consent banner (`.cookies__container`). See
 * `results/otempo/scroll-cls-probe.cjs` (the prototype this module lifts).
 *
 * This module factors that prototype into:
 *   - `aggregateClsByNode`  — fold per-shift `sources[]` into ranked shifting
 *                             elements (the "surface the shift source" output).
 *   - `decideQuiescence`    — layout-quiet predicate (replaces the fixed settle).
 *   - `scrollAndSettleInPage` — browser-context scroll-to-bottom + quiescence
 *                             routine for `page.evaluate`.
 *   - `dismissConsent`      — best-effort Node-side consent click.
 *   - `CONSENT_ACCEPT_SELECTORS` / `DEFAULT_SCROLL_OPTS` — tunables.
 *
 * Conventions: CommonJS, pure helpers + a `require.main` CLI that re-aggregates
 * the CLS shift sources from an existing launcher output. Diagnostics → stderr,
 * JSON → stdout.
 *
 * NOTE: `scrollAndSettleInPage` runs inside the browser (it is serialized by
 * Puppeteer's `page.evaluate`). It must stay fully self-contained — no closures
 * over Node scope, only its `opts` argument and browser globals.
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Best-effort consent accept/close selectors, most-specific first. Lifted from
 * the otempo prototype and extended with the common consent-management
 * platforms. The PT-BR `aceitar` variants matter for the otempo (LGPD) case.
 *
 * Order is the click priority: the first selector that matches a present
 * element wins. Clicking only dismisses the banner *after* its entrance shift
 * has already been recorded (observers are `buffered:true`), so the dominant
 * banner-entrance CLS is preserved; the dismiss reflow itself is correctly
 * excluded from CLS as `hadRecentInput`.
 */
const CONSENT_ACCEPT_SELECTORS = Object.freeze([
  // --- True accept-all buttons (preferred: these PERSIST consent, so the
  //     "returning" cohort's reload shows no banner) ---
  // OneTrust
  '#onetrust-accept-btn-handler',
  // Cookiebot
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  // TrustArc
  '#truste-consent-button',
  // Osano
  '.osano-cm-accept-all',
  // Didomi
  '#didomi-notice-agree-button',
  // Adopt / Cookiefirst / generic vendors
  'button#adopt-accept-all-button',
  '.cookiefirst-root [data-cookiefirst-button="primary"]',
  // otempo `t004-cookie` component (AEM): "Aceitar todos os cookies"
  '.button__cookie--accept',
  '.cookies__button--accept',
  // Quantcast / IAB TCF
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  'button[mode="primary"]',
  // Language-agnostic ARIA / text fallbacks (case-insensitive attribute match)
  'button[aria-label*="aceitar" i]',
  '[aria-label*="aceitar" i]',
  'button[aria-label*="accept" i]',
  '[aria-label*="accept cookies" i]',
  // --- Close/dismiss fallbacks (may only hide the banner without persisting
  //     consent — fine for first-visit entrance-shift capture, weaker for the
  //     returning cohort) ---
  '.osano-cm-accept',
  '.cookies__button--close',
  'button.cookies__button--close',
  '.cookies__button',
]);

/**
 * Defaults for the in-page scroll+settle routine. All times in ms, distances
 * in CSS px. Tuned to the prototype (0.85 viewport steps, ~1s quiet window,
 * 40k px / 30s caps).
 */
const DEFAULT_SCROLL_OPTS = Object.freeze({
  stepRatio: 0.85, // fraction of viewport height per scroll step
  stepPauseMs: 500, // pause after a scroll step for lazy content to begin loading
  quietWindowMs: 1000, // no layout-shift for this long ⇒ "quiet"
  maxScrollPx: 40000, // hard cap on cumulative scroll distance
  maxStepWaitMs: 3000, // per-step cap waiting for quiet before scrolling again
  maxTotalMs: 30000, // overall cap on the whole routine
  finalSettleMs: 1500, // fixed tail wait at the bottom after quiet is reached
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function round4(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Number(n.toFixed(4));
}

/**
 * Height growth (px) of a shift source between its previous and current rect.
 * A positive value means the element *grew* (the layout-shift cause we want to
 * attribute), as opposed to merely *moving* (a downstream victim).
 *
 * Accepts the shape produced by `measure-cwv.js`:
 *   { target, previousRect: {x,y,width,height}, currentRect: {x,y,width,height} }
 *
 * @returns {number} currentRect.height - previousRect.height, or 0 if unknown.
 */
function grewBy(source) {
  if (!source) return 0;
  const prev = source.previousRect;
  const cur = source.currentRect;
  if (!prev || !cur) return 0;
  const ph = typeof prev.height === 'number' ? prev.height : 0;
  const ch = typeof cur.height === 'number' ? cur.height : 0;
  return ch - ph;
}

/**
 * Fold an array of raw layout-shift records into ranked shifting elements.
 *
 * Mirrors the otempo scroll probe: each shift's value is split evenly across
 * its `sources[]`, accumulated per node selector, and the top-N nodes by
 * accumulated CLS share are returned. `grewEvents` counts how often that node
 * was the *growing* source (height delta > 1px), which distinguishes the shift
 * cause from moved victims.
 *
 * Excludes `hadRecentInput` shifts by default (they don't count toward CWV CLS;
 * they're typically the post-click reflow of dismissing the banner). Pass
 * `includeRecentInput: true` to keep them.
 *
 * @param {Array<{value:number, hadRecentInput?:boolean, sources?:Array}>} shifts
 * @param {{ topN?: number, includeRecentInput?: boolean }} [opts]
 * @returns {{ totalShiftValue: number, shiftCount: number,
 *             topShiftingElements: Array<{node:string, clsShare:number, shifts:number, grewEvents:number}> }}
 */
function aggregateClsByNode(shifts, opts) {
  const o = opts || {};
  const topN = typeof o.topN === 'number' ? o.topN : 12;
  const includeRecentInput = !!o.includeRecentInput;
  const list = Array.isArray(shifts) ? shifts : [];

  const byNode = Object.create(null);
  let totalShiftValue = 0;
  let shiftCount = 0;

  function bucket(key) {
    let rec = byNode[key];
    if (!rec) {
      rec = { node: key, cls: 0, shifts: 0, grew: 0 };
      byNode[key] = rec;
    }
    return rec;
  }

  for (let i = 0; i < list.length; i += 1) {
    const sh = list[i];
    if (!sh) continue;
    if (sh.hadRecentInput && !includeRecentInput) continue;
    const value = typeof sh.value === 'number' ? sh.value : 0;
    totalShiftValue += value;
    shiftCount += 1;

    const sources = Array.isArray(sh.sources) ? sh.sources : [];
    if (sources.length === 0) {
      const rec = bucket('(unknown)');
      rec.cls += value;
      rec.shifts += 1;
      continue;
    }
    const share = value / sources.length;
    for (let j = 0; j < sources.length; j += 1) {
      const src = sources[j];
      const key = src && src.target ? src.target : '(unknown)';
      const rec = bucket(key);
      rec.cls += share;
      rec.shifts += 1;
      if (grewBy(src) > 1) rec.grew += 1;
    }
  }

  const topShiftingElements = Object.keys(byNode)
    .map((k) => byNode[k])
    .sort((a, b) => b.cls - a.cls)
    .slice(0, topN)
    .map((r) => ({
      node: r.node,
      clsShare: round4(r.cls),
      shifts: r.shifts,
      grewEvents: r.grew,
    }));

  return {
    totalShiftValue: round4(totalShiftValue),
    shiftCount,
    topShiftingElements,
  };
}

/**
 * Compute CLS from raw layout-shift entries using web-vitals' session-window
 * algorithm: shifts group into a session until a >1s gap or the session exceeds
 * 5s, and CLS is the maximum session sum. Excludes `hadRecentInput` by default.
 *
 * The launcher's canonical CLS is still web-vitals' `onCLS` (web-vitals 4.2.4,
 * which finalizes reliably on the visibilitychange→hidden dispatch). This is a
 * deterministic cross-check from the same shift entries — exposed in
 * `cls.shiftSummary.windowedFromShifts`. It exists because web-vitals v5's
 * `onCLS` proved unreliable under headless + throttle + busy page (idle-scheduled
 * report starved; synthetic hidden didn't flush → CLS 0 with shifts present); if
 * this diverges sharply from `cls.value`, suspect a web-vitals version/finalize
 * regression. The aso runner (on web-vitals v5) uses this as its CLS source.
 *
 * @param {Array<{value:number, startTime?:number, hadRecentInput?:boolean}>} shifts
 * @param {{ includeRecentInput?: boolean }} [opts]
 * @returns {number}
 */
function windowedCls(shifts, opts) {
  const includeRecentInput = !!(opts && opts.includeRecentInput);
  const ordered = (Array.isArray(shifts) ? shifts : [])
    .filter((s) => s && typeof s.value === 'number' && (includeRecentInput || !s.hadRecentInput))
    .slice()
    .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

  let max = 0;
  let cur = 0;
  let firstTs = null;
  let lastTs = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const ts = ordered[i].startTime || 0;
    const value = ordered[i].value || 0;
    if (firstTs !== null && (ts - lastTs >= 1000 || ts - firstTs >= 5000)) {
      cur = value;
      firstTs = ts;
    } else {
      if (firstTs === null) firstTs = ts;
      cur += value;
    }
    lastTs = ts;
    if (cur > max) max = cur;
  }
  return round4(max);
}

/**
 * Layout-quiescence predicate. Returns true when the page has gone
 * `quietWindowMs` without a (non-recent-input) layout shift.
 *
 * This is the spec the in-page routine's inline check follows — extracted so it
 * can be unit-tested. Returns false when timing state is incomplete (we can't
 * confirm quiet, so don't claim it).
 *
 * @param {{ nowMs: number, lastShiftMs: number }} state
 * @param {{ quietWindowMs?: number }} [opts]
 * @returns {boolean}
 */
function decideQuiescence(state, opts) {
  const s = state || {};
  const o = opts || {};
  const quietWindowMs = typeof o.quietWindowMs === 'number' ? o.quietWindowMs : DEFAULT_SCROLL_OPTS.quietWindowMs;
  if (typeof s.nowMs !== 'number' || typeof s.lastShiftMs !== 'number') return false;
  return s.nowMs - s.lastShiftMs >= quietWindowMs;
}

// ---------------------------------------------------------------------------
// Browser-context routine (serialized by page.evaluate — keep self-contained)
// ---------------------------------------------------------------------------

/**
 * Scroll to the bottom of the page in viewport-sized steps, waiting for layout
 * quiescence (no layout-shift for `quietWindowMs`) between steps rather than a
 * fixed sleep. Lets scroll-lazy ads / images / late banners load and shift so
 * web-vitals' CLS observer accumulates them — approximating how CrUX collects
 * CLS over a real session.
 *
 * Runs INSIDE the page (passed to `page.evaluate(scrollAndSettleInPage, opts)`).
 * Self-contained: references only `opts` + browser globals. The inline
 * quiet-window check mirrors `decideQuiescence`.
 *
 * @param {object} opts — see DEFAULT_SCROLL_OPTS for shape/units.
 * @returns {Promise<{steps:number, scrolledPx:number, reachedBottom:boolean,
 *                     shiftsObserved:number, durationMs:number}>}
 */
function scrollAndSettleInPage(opts) {
  return new Promise(function (resolve) {
    const o = opts || {};
    const stepRatio = o.stepRatio || 0.85;
    const stepPauseMs = o.stepPauseMs || 500;
    const quietWindowMs = o.quietWindowMs || 1000;
    const maxScrollPx = o.maxScrollPx || 40000;
    const maxStepWaitMs = o.maxStepWaitMs || 3000;
    const maxTotalMs = o.maxTotalMs || 30000;
    const finalSettleMs = o.finalSettleMs || 1500;

    const now = function () {
      return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    };
    const startedAt = now();
    let lastShiftMs = startedAt;
    let shiftsObserved = 0;

    let obs = null;
    try {
      obs = new PerformanceObserver(function (list) {
        const ents = list.getEntries();
        for (let i = 0; i < ents.length; i += 1) {
          if (ents[i].hadRecentInput) continue;
          lastShiftMs = now();
          shiftsObserved += 1;
        }
      });
      obs.observe({ type: 'layout-shift', buffered: true });
    } catch {
      /* layout-shift unsupported — fall back to pure time-based stepping */
    }

    let totalScrolled = 0;
    let steps = 0;
    let reachedBottom = false;

    function viewportH() {
      return window.innerHeight || 800;
    }
    function atBottom() {
      const scrollY = window.scrollY || window.pageYOffset || 0;
      const docH = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0,
      );
      return scrollY + viewportH() >= docH - 2 || totalScrolled >= maxScrollPx;
    }

    // Poll until quiet (no shift for quietWindowMs) or a phase/global cap hits.
    function waitForQuiet(capMs, done) {
      const phaseStart = now();
      (function poll() {
        const t = now();
        if (t - lastShiftMs >= quietWindowMs) return done();
        if (t - phaseStart >= capMs) return done();
        if (t - startedAt >= maxTotalMs) return done();
        setTimeout(poll, 100);
      })();
    }

    function finish() {
      if (obs) {
        try {
          obs.disconnect();
        } catch {
          /* noop */
        }
      }
      resolve({
        steps: steps,
        scrolledPx: Math.round(totalScrolled),
        reachedBottom: reachedBottom,
        shiftsObserved: shiftsObserved,
        durationMs: Math.round(now() - startedAt),
      });
    }

    function stepOnce() {
      if (now() - startedAt >= maxTotalMs) return finish();
      if (atBottom()) {
        reachedBottom = true;
        // At the bottom: wait for quiet, then a fixed tail for trailing shifts.
        waitForQuiet(finalSettleMs * 2, function () {
          setTimeout(finish, finalSettleMs);
        });
        return;
      }
      const delta = Math.round(viewportH() * stepRatio);
      window.scrollBy(0, delta);
      totalScrolled += delta;
      steps += 1;
      // Let lazy content begin loading, then wait for layout to go quiet.
      setTimeout(function () {
        waitForQuiet(maxStepWaitMs, stepOnce);
      }, stepPauseMs);
    }

    stepOnce();
  });
}

// ---------------------------------------------------------------------------
// Node-side consent dismissal (Puppeteer page)
// ---------------------------------------------------------------------------

/**
 * Best-effort consent dismissal: click the first present element matching one
 * of `selectors`. Returns the selector that matched, or null if none did.
 *
 * Intentionally swallows per-selector errors (invalid/unsupported selectors,
 * detached handles) so one bad selector never aborts the sweep.
 *
 * @param {import('puppeteer').Page} page
 * @param {string[]} [selectors=CONSENT_ACCEPT_SELECTORS]
 * @returns {Promise<string|null>}
 */
async function dismissConsent(page, selectors) {
  const sels = Array.isArray(selectors) ? selectors : CONSENT_ACCEPT_SELECTORS;
  for (let i = 0; i < sels.length; i += 1) {
    const sel = sels[i];
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ delay: 10 }).catch(() => {});
        await el.dispose().catch(() => {});
        return sel;
      }
    } catch {
      /* invalid selector for this engine, or element detached — skip */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI: re-aggregate CLS shift sources from an existing launcher output.
// ---------------------------------------------------------------------------

function aggregateLauncherOutput(doc, opts) {
  const runs = doc && Array.isArray(doc.runs) ? doc.runs : [];
  const perRun = runs.map((run, idx) => {
    const cls = run && run.cwv && run.cwv.cls ? run.cwv.cls : null;
    const shifts = cls && Array.isArray(cls.shifts) ? cls.shifts : [];
    return {
      run: idx + 1,
      clsValue: cls ? cls.value : null,
      ...aggregateClsByNode(shifts, opts),
    };
  });
  return { url: doc && doc.url, profile: doc && doc.profile, runs: perRun };
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file || argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(
      'Usage: node .agents/scripts/field-measure.js <launcher-output.json>\n' +
        '  Re-aggregates cls.shifts[] into ranked shifting elements per run.\n',
    );
    process.exit(file ? 0 : 2);
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    process.stderr.write(`Error reading ${file}: ${err.message}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(aggregateLauncherOutput(doc), null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

export {
  CONSENT_ACCEPT_SELECTORS,
  DEFAULT_SCROLL_OPTS,
  aggregateClsByNode,
  windowedCls,
  decideQuiescence,
  grewBy,
  scrollAndSettleInPage,
  dismissConsent,
  aggregateLauncherOutput,
};
