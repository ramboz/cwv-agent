#!/usr/bin/env node

/**
 * Tests for .agents/scripts/field-measure.js — the pure-function helpers
 * behind launcher.js's field-faithful (`--scroll`) mode (ROADMAP G1).
 *
 * Browser-context (`scrollAndSettleInPage`) and Puppeteer-driven
 * (`dismissConsent`) helpers are exercised live against the news-site case, not here —
 * these tests cover only the pure logic, per repo convention (no network/
 * browser in the unit suite).
 *
 * The aggregateClsByNode fixtures are modeled on the real the news-site case scroll-probe
 * output (`results/the news-site case/scroll-cls-mobile.json`): the `t004-cookie`
 * consent banner's `.cookies__container` grows ~9× and dominates CLS.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONSENT_ACCEPT_SELECTORS,
  DEFAULT_SCROLL_OPTS,
  aggregateClsByNode,
  windowedCls,
  decideQuiescence,
  grewBy,
  aggregateLauncherOutput,
} from '../field-measure.js';

// ---------------------------------------------------------------------------
// Fixtures — the news-site case-shaped layout-shift records (measure-cwv.js shape).
// ---------------------------------------------------------------------------

const COOKIE_SEL =
  'div#container-32e9778d0f>div.aem-Grid>div.t004-cookie>section.cookies__container.font-lato';
const TEMPLATE_SEL = 'div#container-e87494c30d>div.template-container';

function rect(y, height) {
  return { x: 0, y, width: 412, height };
}

// The consent banner growing into view (height 60 → 540) over several shifts,
// pushing the template container down. Mirrors the dominant the news-site case CLS source.
const SAMPLE_SHIFTS = [
  {
    value: 0.12,
    startTime: 800,
    hadRecentInput: false,
    sources: [{ target: COOKIE_SEL, previousRect: rect(900, 60), currentRect: rect(900, 300) }],
  },
  {
    value: 0.13,
    startTime: 1200,
    hadRecentInput: false,
    sources: [{ target: COOKIE_SEL, previousRect: rect(900, 300), currentRect: rect(820, 540) }],
  },
  {
    // A two-source shift: banner grows AND template moves down (victim).
    value: 0.04,
    startTime: 1600,
    hadRecentInput: false,
    sources: [
      { target: COOKIE_SEL, previousRect: rect(820, 540), currentRect: rect(800, 560) },
      { target: TEMPLATE_SEL, previousRect: rect(560, 400), currentRect: rect(620, 400) },
    ],
  },
  {
    // Post-dismiss reflow — recent input, must be excluded by default.
    value: 0.20,
    startTime: 2200,
    hadRecentInput: true,
    sources: [{ target: COOKIE_SEL, previousRect: rect(800, 560), currentRect: rect(900, 0) }],
  },
];

// ---------------------------------------------------------------------------
// grewBy
// ---------------------------------------------------------------------------

test('grewBy: positive when currentRect taller than previousRect', () => {
  assert.equal(grewBy({ previousRect: rect(0, 60), currentRect: rect(0, 300) }), 240);
});

test('grewBy: negative/zero when shrinking or unchanged', () => {
  assert.equal(grewBy({ previousRect: rect(0, 300), currentRect: rect(0, 300) }), 0);
  assert.equal(grewBy({ previousRect: rect(0, 300), currentRect: rect(0, 100) }), -200);
});

test('grewBy: missing rects or nullish → 0', () => {
  assert.equal(grewBy(null), 0);
  assert.equal(grewBy({}), 0);
  assert.equal(grewBy({ previousRect: rect(0, 60) }), 0);
});

// ---------------------------------------------------------------------------
// aggregateClsByNode
// ---------------------------------------------------------------------------

test('aggregateClsByNode: the news-site case shape → consent banner is the top shift source', () => {
  const agg = aggregateClsByNode(SAMPLE_SHIFTS);
  const top = agg.topShiftingElements[0];
  assert.equal(top.node, COOKIE_SEL);
  // Banner grew on all three non-recent-input shifts it appears in.
  assert.equal(top.grewEvents, 3);
  // Its share exceeds the moved template victim.
  const template = agg.topShiftingElements.find((e) => e.node === TEMPLATE_SEL);
  assert.ok(template, 'template victim present');
  assert.ok(top.clsShare > template.clsShare, 'banner dominates the victim');
  assert.equal(template.grewEvents, 0, 'template only moved, never grew');
});

test('aggregateClsByNode: excludes hadRecentInput by default', () => {
  const agg = aggregateClsByNode(SAMPLE_SHIFTS);
  // 3 of the 4 shifts count (the 0.20 recent-input one is dropped).
  assert.equal(agg.shiftCount, 3);
  assert.equal(agg.totalShiftValue, 0.29); // 0.12 + 0.13 + 0.04
});

test('aggregateClsByNode: includeRecentInput=true keeps the post-click reflow', () => {
  const agg = aggregateClsByNode(SAMPLE_SHIFTS, { includeRecentInput: true });
  assert.equal(agg.shiftCount, 4);
  assert.equal(agg.totalShiftValue, 0.49); // + 0.20
});

test('aggregateClsByNode: splits a multi-source shift evenly across sources', () => {
  const shifts = [
    {
      value: 0.1,
      hadRecentInput: false,
      sources: [{ target: 'a' }, { target: 'b' }],
    },
  ];
  const agg = aggregateClsByNode(shifts);
  const a = agg.topShiftingElements.find((e) => e.node === 'a');
  const b = agg.topShiftingElements.find((e) => e.node === 'b');
  assert.equal(a.clsShare, 0.05);
  assert.equal(b.clsShare, 0.05);
});

test('aggregateClsByNode: sourceless shift buckets under (unknown)', () => {
  const agg = aggregateClsByNode([{ value: 0.07, hadRecentInput: false, sources: [] }]);
  assert.equal(agg.topShiftingElements[0].node, '(unknown)');
  assert.equal(agg.topShiftingElements[0].clsShare, 0.07);
});

test('aggregateClsByNode: respects topN', () => {
  const shifts = [];
  for (let i = 0; i < 20; i += 1) {
    shifts.push({ value: 0.01 * (i + 1), hadRecentInput: false, sources: [{ target: `n${i}` }] });
  }
  const agg = aggregateClsByNode(shifts, { topN: 3 });
  assert.equal(agg.topShiftingElements.length, 3);
  // Highest-value nodes first.
  assert.equal(agg.topShiftingElements[0].node, 'n19');
});

test('aggregateClsByNode: empty / nullish input → zeros', () => {
  for (const input of [undefined, null, [], 'nope', 42]) {
    const agg = aggregateClsByNode(input);
    assert.equal(agg.shiftCount, 0);
    assert.equal(agg.totalShiftValue, 0);
    assert.deepEqual(agg.topShiftingElements, []);
  }
});

// ---------------------------------------------------------------------------
// windowedCls (session-window algorithm — cross-check / aso CLS source)
// ---------------------------------------------------------------------------

test('windowedCls: sums one session (gaps < 1s, span < 5s); excludes recent-input', () => {
  // the news-site case shape: startTimes 800/1200/1600 (gaps 400ms) → one session of 0.29.
  assert.equal(windowedCls(SAMPLE_SHIFTS), 0.29);
});

test('windowedCls: >1s gap starts a new session → max session, not total', () => {
  const spread = [
    { value: 0.1, startTime: 0, hadRecentInput: false },
    { value: 0.3, startTime: 2000, hadRecentInput: false },
    { value: 0.05, startTime: 4500, hadRecentInput: false },
  ];
  assert.equal(windowedCls(spread), 0.3);
});

test('windowedCls: span > 5s starts a new session even with small gaps', () => {
  const longRun = [];
  for (let t = 0; t <= 6000; t += 800) {
    longRun.push({ value: 0.05, startTime: t, hadRecentInput: false });
  }
  // First session t=0..4800 = 7 × 0.05 = 0.35; new session at t≥5000. Max 0.35.
  assert.equal(windowedCls(longRun), 0.35);
});

test('windowedCls: includeRecentInput keeps the post-click reflow', () => {
  assert.ok(windowedCls(SAMPLE_SHIFTS, { includeRecentInput: true }) > 0.29);
});

test('windowedCls: empty / nullish → 0', () => {
  for (const input of [undefined, null, [], 'x']) assert.equal(windowedCls(input), 0);
});

// ---------------------------------------------------------------------------
// decideQuiescence
// ---------------------------------------------------------------------------

test('decideQuiescence: quiet once now - lastShift ≥ window', () => {
  assert.equal(decideQuiescence({ nowMs: 5000, lastShiftMs: 3900 }, { quietWindowMs: 1000 }), true);
  assert.equal(decideQuiescence({ nowMs: 5000, lastShiftMs: 4001 }, { quietWindowMs: 1000 }), false);
});

test('decideQuiescence: exactly at the window boundary counts as quiet', () => {
  assert.equal(decideQuiescence({ nowMs: 2000, lastShiftMs: 1000 }, { quietWindowMs: 1000 }), true);
});

test('decideQuiescence: default window from DEFAULT_SCROLL_OPTS', () => {
  assert.equal(decideQuiescence({ nowMs: 2000, lastShiftMs: 999 }), true); // gap 1001 ≥ 1000
  assert.equal(decideQuiescence({ nowMs: 2000, lastShiftMs: 1500 }), false);
});

test('decideQuiescence: incomplete state → false (cannot confirm quiet)', () => {
  assert.equal(decideQuiescence({ nowMs: 5000 }, { quietWindowMs: 1000 }), false);
  assert.equal(decideQuiescence({ lastShiftMs: 1000 }, { quietWindowMs: 1000 }), false);
  assert.equal(decideQuiescence(null), false);
});

// ---------------------------------------------------------------------------
// Constants / config
// ---------------------------------------------------------------------------

test('CONSENT_ACCEPT_SELECTORS: non-empty string list incl. the news-site case + OneTrust', () => {
  assert.ok(Array.isArray(CONSENT_ACCEPT_SELECTORS));
  assert.ok(CONSENT_ACCEPT_SELECTORS.length > 0);
  assert.ok(CONSENT_ACCEPT_SELECTORS.every((s) => typeof s === 'string' && s.length > 0));
  assert.ok(CONSENT_ACCEPT_SELECTORS.includes('#onetrust-accept-btn-handler'));
  assert.ok(CONSENT_ACCEPT_SELECTORS.some((s) => s.includes('cookies__button')));
});

test('DEFAULT_SCROLL_OPTS: sane positive tunables', () => {
  for (const k of ['stepRatio', 'stepPauseMs', 'quietWindowMs', 'maxScrollPx', 'maxStepWaitMs', 'maxTotalMs', 'finalSettleMs']) {
    assert.equal(typeof DEFAULT_SCROLL_OPTS[k], 'number', `${k} is a number`);
    assert.ok(DEFAULT_SCROLL_OPTS[k] > 0, `${k} is positive`);
  }
  assert.ok(DEFAULT_SCROLL_OPTS.stepRatio <= 1, 'stepRatio is a viewport fraction');
});

// ---------------------------------------------------------------------------
// aggregateLauncherOutput (CLI core)
// ---------------------------------------------------------------------------

test('aggregateLauncherOutput: per-run aggregation over launcher shape', () => {
  const doc = {
    url: 'https://news.example.com/',
    profile: 'mobile-slow4g-4xcpu',
    runs: [
      { cwv: { cls: { value: 0.29, shifts: SAMPLE_SHIFTS } } },
      { cwv: { cls: { value: 0.0, shifts: [] } } },
    ],
  };
  const out = aggregateLauncherOutput(doc);
  assert.equal(out.url, 'https://news.example.com/');
  assert.equal(out.runs.length, 2);
  assert.equal(out.runs[0].clsValue, 0.29);
  assert.equal(out.runs[0].topShiftingElements[0].node, COOKIE_SEL);
  assert.equal(out.runs[1].shiftCount, 0);
});

test('aggregateLauncherOutput: missing/empty runs → empty result', () => {
  assert.deepEqual(aggregateLauncherOutput({}).runs, []);
  assert.deepEqual(aggregateLauncherOutput(null).runs, []);
});
