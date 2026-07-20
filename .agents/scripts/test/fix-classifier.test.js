#!/usr/bin/env node

/**
 * Tests for .agents/scripts/fix-classifier.js — the fix-classification gate
 * (slice 016-01). Given a patches.json + detected stack, every proposed fix is
 * assigned a Class (1 generic / 2 delta-splice / 3 producer-required), a
 * validate route, a metric gate, and a typed rationale — the keystone artifact
 * the operator and downstream slices consume.
 *
 * Repo convention: NEVER hit the network. Source-attribution (016-07's
 * `readClientlib`) is injected as an async `attribute` stub, so the classifier
 * logic is exercised offline and deterministically. The classification LOGIC is
 * a pure function (`classifyFix`) that consumes an already-resolved attribution
 * result; the orchestrator (`classifyFixes`) resolves attribution per fix.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyFix,
  classifyFixes,
  buildClassification,
} from '../fix-classifier.js';

// ---------------------------------------------------------------------------
// Attribution stubs (shape mirrors 016-07's readClientlib outcomes).
// ---------------------------------------------------------------------------

const attributedReservable = {
  outcome: 'attributed',
  structuralRole: 'reservable',
  source: { component: { name: 'hero' }, delivery: { recommended: 'override-clientlib' } },
};
const attributedOrderDependent = {
  outcome: 'attributed',
  structuralRole: 'order-dependent',
  source: { component: { name: 'section' }, delivery: { recommended: 'override-clientlib' } },
};
const readableButUnattributed = {
  outcome: 'readable-but-unattributed',
  structuralRole: 'reservable',
  source: null,
  reason: 'selector-resolver: base CSS not in git (vendor-built)',
};

// A stub attribute() that always throws if called — proves a code path resolves
// attribution WITHOUT touching the network / without needing it.
function attributeNever() {
  return async () => { throw new Error('attribute() must not be called on this path'); };
}
// A stub attribute() that returns a fixed result and records its calls.
function attributeStub(result) {
  const calls = [];
  const fn = async (args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

// ===========================================================================
// AC 2 — base deterministic rules (one fix per class/subclass).
// ===========================================================================

test('Class 1 / generic / mode-a: attribute-edit op (CLS)', () => {
  const e = classifyFix({ op: 'attribute', metric: 'CLS', attribution: null });
  assert.equal(e.class, 1);
  assert.equal(e.subclass, 'generic');
  assert.equal(e.route, 'mode-a');
  assert.equal(e.metricGate, 'n/a');
});

test('Class 1 / generic / mode-a: resource-hint / meta / defer / alt ops', () => {
  for (const op of ['preload', 'fetchpriority', 'meta', 'defer', 'alt']) {
    const e = classifyFix({ op, metric: 'LCP', attribution: null });
    assert.equal(e.class, 1, `op ${op} → Class 1`);
    assert.equal(e.route, 'mode-a');
    assert.equal(e.metricGate, 'n/a');
  }
});

test('Class 2 / delta / delta-splice: CSS override on CLS → metricGate cls-ok', () => {
  const e = classifyFix({ op: 'css-override', metric: 'CLS', attribution: null });
  assert.equal(e.class, 2);
  assert.equal(e.subclass, 'delta');
  assert.equal(e.route, 'delta-splice');
  assert.equal(e.metricGate, 'cls-ok');
});

test('Class 2 / delta: an override-clientlib recommendation is a CSS-add → Class 2', () => {
  const e = classifyFix({ op: 'override-clientlib', metric: 'CLS', attribution: null });
  assert.equal(e.class, 2);
  assert.equal(e.subclass, 'delta');
});

test('Class 2 / delta: rewriteBody injecting a <style> rule → Class 2 (CLS)', () => {
  const e = classifyFix({ op: 'rewriteBody', metric: 'CLS', details: { injects: 'style' }, attribution: null });
  assert.equal(e.class, 2);
  assert.equal(e.subclass, 'delta');
});

test('Class 3 / clientlib / local-build-modeb: order/blocking-dependent clientlib change', () => {
  const e = classifyFix({ op: 'clientlib-reorder', metric: 'LCP', attribution: null });
  assert.equal(e.class, 3);
  assert.equal(e.subclass, 'clientlib');
  assert.equal(e.route, 'local-build-modeb');
  assert.equal(e.metricGate, 'n/a');
});

test('Class 3 / htl / producer-required: structural DOM-shape change under /apps/**/*.html', () => {
  const e = classifyFix({
    op: 'htl-structural',
    metric: 'CLS',
    selector: 'apps/otempo/components/hero/hero.html',
    attribution: null,
  });
  assert.equal(e.class, 3);
  assert.equal(e.subclass, 'htl');
  assert.equal(e.route, 'producer-required');
  assert.equal(e.metricGate, 'n/a');
});

// ===========================================================================
// AC 3 — ambiguous / unknown op → HIGHEST applicable class, never silent Class 1.
// ===========================================================================

test('AC 3: unknown op classifies to the highest class (3 / producer-required) with a typed reason', () => {
  const e = classifyFix({ op: 'something-weird', metric: 'CLS', attribution: null });
  assert.equal(e.class, 3);
  assert.equal(e.route, 'producer-required');
  assert.ok(e.rationale && /unknown|ambiguous/i.test(e.rationale), 'typed reason present');
});

test('AC 3: a missing op is not silently Class 1', () => {
  const e = classifyFix({ op: undefined, metric: 'CLS', attribution: null });
  assert.notEqual(e.class, 1);
});

// ===========================================================================
// AC 2b — metric-aware narrowing.
// ===========================================================================

test('2b (017): absolute-timing (LCP) delta WITH attributed+reservable → Class 2, absolute-timing-cleared (publishable; probe cleared)', () => {
  const e = classifyFix({ op: 'css-override', metric: 'LCP', attribution: attributedReservable });
  assert.equal(e.class, 2);
  assert.equal(e.subclass, 'delta');
  assert.equal(e.route, 'delta-splice');
  assert.equal(e.metricGate, 'absolute-timing-cleared');
  assert.doesNotMatch(e.rationale, /diagnostic signal only/);
});

test('2b: absolute-timing (LCP) delta WITHOUT attribution → Class 3 producer-required (DM-resize pattern)', () => {
  const e = classifyFix({ op: 'css-override', metric: 'LCP', attribution: null });
  assert.equal(e.class, 3);
  assert.equal(e.route, 'producer-required');
  assert.ok(e.rationale && /absolute-timing|unconfirmed|attribut/i.test(e.rationale));
});

test('2b: unknown metric is treated as absolute-timing (no CLS license) → a delta escalates without attribution', () => {
  const e = classifyFix({ op: 'css-override', metric: 'unknown', attribution: null });
  assert.equal(e.class, 3);
  assert.equal(e.route, 'producer-required');
});

// ===========================================================================
// 017 scoping: the 016-09 misclassification exemplars do NOT reach the promoted
// `absolute-timing-cleared` branch. Spec 017 lifts ONLY the interception-artifact
// demotion (016-09 reason 2); the primary misclassification reason (reason 1)
// stays handled by the attributed+reservable gate — which the exemplars fail.
// The ONLY route to `absolute-timing-cleared` is a CSS-delta op that is
// attributed+reservable (the positive test above at "2b (017) ...").
// ===========================================================================

test('017-scope: DM-resize (a markup/URL op, LCP) → Class 1 mode-a — NOT the promoted absolute-timing branch', () => {
  // The real DM-resize fix appends &width=…&quality=… to an <img> URL: a markup
  // mutation, not a CSS delta. It never enters rule 2b, so it can never receive
  // `absolute-timing-cleared`. (Its architectural-vs-lab risk is a Class-1 concern,
  // unchanged by 017.)
  const e = classifyFix({ op: 'markup', metric: 'LCP', selector: 'img.hero', attribution: attributedReservable });
  assert.equal(e.class, 1);
  assert.equal(e.route, 'mode-a');
  assert.notEqual(e.metricGate, 'absolute-timing-cleared');
});

test('017-scope: DM-resize expressed as a non-CSS rewriteBody (LCP) → Class 3 — not a CSS delta, not promoted', () => {
  // A rewriteBody that does NOT inject a <style>/CSS rule is not a delta-shaped CSS
  // change (opIsCssDelta=false) → falls through to the AC-3 highest-class default.
  const e = classifyFix({ op: 'rewriteBody', metric: 'LCP', details: { injects: 'url-param' }, attribution: attributedReservable });
  assert.equal(e.class, 3);
  assert.equal(e.route, 'producer-required');
  assert.notEqual(e.metricGate, 'absolute-timing-cleared');
});

test('017-scope: an order-dependent absolute-timing CSS delta stays Class 3 (2c) — never promoted, even attributed', () => {
  const e = classifyFix({ op: 'css-override', metric: 'LCP', attribution: attributedOrderDependent });
  assert.equal(e.class, 3);
  assert.equal(e.route, 'producer-required');
  assert.notEqual(e.metricGate, 'absolute-timing-cleared');
});

// ===========================================================================
// AC 2c — architectural-entanglement escalation (the zepbound CLS hole).
// ===========================================================================

test('2c: a CLS delta whose attribution is order-dependent → Class 3 producer-required', () => {
  const e = classifyFix({ op: 'css-override', metric: 'CLS', attribution: attributedOrderDependent });
  assert.equal(e.class, 3);
  assert.equal(e.route, 'producer-required');
  assert.ok(e.rationale && /order-dependent|entangl/i.test(e.rationale));
});

test('2c: order-dependent escalates regardless of metric (LCP too)', () => {
  const e = classifyFix({ op: 'css-override', metric: 'LCP', attribution: attributedOrderDependent });
  assert.equal(e.class, 3);
  assert.equal(e.route, 'producer-required');
});

// ===========================================================================
// AC 2d — readable-but-unattributed is NON-confirmation.
// ===========================================================================

test('2d: readable-but-unattributed CLS delta → escalate, rationale source-unattributed', () => {
  const e = classifyFix({ op: 'css-override', metric: 'CLS', attribution: readableButUnattributed });
  assert.equal(e.class, 3);
  assert.equal(e.route, 'producer-required');
  assert.match(e.rationale, /source-unattributed/);
});

test('2d: readable-but-unattributed absolute-timing delta → escalate, source-unattributed', () => {
  const e = classifyFix({ op: 'css-override', metric: 'LCP', attribution: readableButUnattributed });
  assert.equal(e.class, 3);
  assert.match(e.rationale, /source-unattributed/);
});

// A CLS delta with NO attribution present is still Class 2 (cls-ok is licensed
// without attribution) — the escalations only fire when attribution IS present
// and contradicts (2c/2d).
test('CLS delta with no attribution stays Class 2 cls-ok (CLS delta-splice licensed)', () => {
  const e = classifyFix({ op: 'css-override', metric: 'CLS', attribution: null });
  assert.equal(e.class, 2);
  assert.equal(e.metricGate, 'cls-ok');
});

// ===========================================================================
// classifyFixes — orchestrator + attribution injection.
// ===========================================================================

test('classifyFixes: resolves attribution ONLY when the rule needs it (CLS delta w/ no clientlib skips attribute)', async () => {
  const attribute = attributeStub(attributedReservable);
  const { entries } = await classifyFixes({
    fixes: [{ id: 'f1', metric: 'CLS', op: 'css-override' }],
    stack: 'aem-cs',
    attribute,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].class, 2);
  assert.equal(entries[0].metricGate, 'cls-ok');
  // No implicatedClientlibUrl + CLS → no need to attribute.
  assert.equal(attribute.calls.length, 0);
});

test('classifyFixes: resolves attribution for an absolute-timing delta with a clientlib url, then gates', async () => {
  const attribute = attributeStub(attributedReservable);
  const { entries } = await classifyFixes({
    fixes: [{
      id: 'f2', metric: 'LCP', op: 'css-override',
      selector: '.hero', implicatedClientlibUrl: 'https://x/etc.clientlibs/a/site.min.css',
    }],
    stack: 'aem-cs',
    attribute,
  });
  assert.equal(attribute.calls.length, 1, 'attribution resolved once for the absolute-timing delta');
  assert.equal(entries[0].class, 2);
  assert.equal(entries[0].metricGate, 'absolute-timing-cleared');
  assert.equal(entries[0].id, 'f2');
});

test('classifyFixes: carries fix id through and preserves the whole entry list', async () => {
  const { entries } = await classifyFixes({
    fixes: [
      { id: 'a', metric: 'CLS', op: 'attribute' },
      { id: 'b', metric: 'CLS', op: 'css-override' },
      { id: 'c', metric: 'CLS', op: 'htl-structural', selector: 'apps/x/c/c.html' },
    ],
    stack: 'aem-cs',
    attribute: attributeNever(),
  });
  assert.deepEqual(entries.map((e) => e.id), ['a', 'b', 'c']);
  assert.deepEqual(entries.map((e) => e.class), [1, 2, 3]);
});

// ===========================================================================
// AC 4 — operator summary: "validates now" vs "guidance-only".
// ===========================================================================

test('AC 4: summary splits validates-now (Class 1/2/3-clientlib) from guidance-only (Class 3-htl)', async () => {
  const { summary } = await classifyFixes({
    fixes: [
      { id: 'a', metric: 'CLS', op: 'attribute' },              // Class 1
      { id: 'b', metric: 'CLS', op: 'css-override' },           // Class 2
      { id: 'c', metric: 'LCP', op: 'clientlib-reorder' },      // Class 3-clientlib
      { id: 'd', metric: 'CLS', op: 'htl-structural', selector: 'apps/x/c/c.html' }, // Class 3-htl
    ],
    stack: 'aem-cs',
    attribute: attributeNever(),
  });
  assert.equal(summary.validatesNow, 3, 'Class 1 + Class 2 + Class 3-clientlib validate now');
  assert.equal(summary.guidanceOnly, 1, 'only Class 3-htl is guidance-only');
  assert.ok(typeof summary.line === 'string' && summary.line.length > 0, 'human-readable summary line');
});

// ===========================================================================
// AC 5 — artifact envelope conforms to ADR-0012.
// ===========================================================================

test('AC 5: buildClassification emits an ADR-0012 envelope (schemaVersion/kind/generatedAt/stack/entries/summary)', () => {
  const entries = [
    classifyFix({ id: 'a', op: 'attribute', metric: 'CLS', attribution: null }),
    classifyFix({ id: 'b', op: 'css-override', metric: 'CLS', attribution: null }),
  ];
  const env = buildClassification({ entries, stack: 'aem-cs' });
  assert.equal(env.schemaVersion, '1.0');
  assert.equal(env.kind, 'fix-classification');
  assert.ok(typeof env.generatedAt === 'string' && !Number.isNaN(Date.parse(env.generatedAt)));
  assert.equal(env.stack, 'aem-cs');
  assert.ok(Array.isArray(env.entries) && env.entries.length === 2);
  assert.ok(env.summary && typeof env.summary === 'object');
  assert.equal(env.summary.total, 2);
});

test('AC 5: envelope entries carry the full per-fix shape', () => {
  const env = buildClassification({
    entries: [classifyFix({ id: 'x', op: 'css-override', metric: 'CLS', attribution: null })],
    stack: 'aem-cs',
  });
  const e = env.entries[0];
  for (const key of ['id', 'class', 'subclass', 'route', 'metricGate', 'rationale']) {
    assert.ok(Object.prototype.hasOwnProperty.call(e, key), `entry has ${key}`);
  }
});

// ===========================================================================
// A concrete entry per required class (the reporting matrix in the slice).
// ===========================================================================

test('reporting matrix: one entry per class variant with correct route + gate', async () => {
  const { entries } = await classifyFixes({
    fixes: [
      { id: 'class1', metric: 'CLS', op: 'attribute' },
      { id: 'class2-cls', metric: 'CLS', op: 'css-override' },
      { id: 'class2-abs', metric: 'LCP', op: 'css-override', implicatedClientlibUrl: 'https://x/etc.clientlibs/a.min.css', selector: '.hero' },
      { id: 'class3-from-2b', metric: 'LCP', op: 'css-override' },
      { id: 'class3-htl', metric: 'CLS', op: 'htl-structural', selector: 'apps/x/c/c.html' },
    ],
    stack: 'aem-cs',
    attribute: async () => attributedReservable,
  });
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  assert.deepEqual(
    [byId['class1'].class, byId['class1'].route, byId['class1'].metricGate],
    [1, 'mode-a', 'n/a'],
  );
  assert.deepEqual(
    [byId['class2-cls'].class, byId['class2-cls'].route, byId['class2-cls'].metricGate],
    [2, 'delta-splice', 'cls-ok'],
  );
  assert.deepEqual(
    [byId['class2-abs'].class, byId['class2-abs'].route, byId['class2-abs'].metricGate],
    [2, 'delta-splice', 'absolute-timing-cleared'],
  );
  assert.deepEqual(
    [byId['class3-from-2b'].class, byId['class3-from-2b'].route],
    [3, 'producer-required'],
  );
  assert.deepEqual(
    [byId['class3-htl'].class, byId['class3-htl'].subclass, byId['class3-htl'].route],
    [3, 'htl', 'producer-required'],
  );
});

test('escalations (2b/2c/2d/AC-3) carry subclass "architectural"; a literal HTL restructure carries "htl"', () => {
  // 2b escalation
  assert.equal(classifyFix({ op: 'css-override', metric: 'LCP', attribution: null }).subclass, 'architectural');
  // 2c escalation
  assert.equal(classifyFix({ op: 'css-override', metric: 'CLS', attribution: attributedOrderDependent }).subclass, 'architectural');
  // 2d escalation
  assert.equal(classifyFix({ op: 'css-override', metric: 'CLS', attribution: readableButUnattributed }).subclass, 'architectural');
  // AC-3 unknown-op escalation
  assert.equal(classifyFix({ op: 'weird', metric: 'CLS', attribution: null }).subclass, 'architectural');
  // literal HTL restructure keeps subclass htl
  assert.equal(classifyFix({ op: 'htl-structural', metric: 'CLS', selector: 'apps/x/c/c.html', attribution: null }).subclass, 'htl');
  // Class 3-clientlib is NOT producer-required (validates now via local build)
  assert.equal(classifyFix({ op: 'clientlib-reorder', metric: 'LCP', attribution: null }).route, 'local-build-modeb');
});

test('reporting matrix: class3-from-2c (order-dependent CLS) is present via orchestrator', async () => {
  const { entries } = await classifyFixes({
    fixes: [{
      id: 'class3-from-2c', metric: 'CLS', op: 'css-override',
      selector: '.section', implicatedClientlibUrl: 'https://x/etc.clientlibs/a.min.css',
    }],
    stack: 'aem-cs',
    attribute: async () => attributedOrderDependent,
  });
  assert.equal(entries[0].class, 3);
  assert.equal(entries[0].route, 'producer-required');
});
