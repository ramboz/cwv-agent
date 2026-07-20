#!/usr/bin/env node

/**
 * Tests for .agents/scripts/measure-quality.js — the pure measurement-reliability
 * assessor behind the oracle's UNRELIABLE verdict and the launcher's adaptive
 * runs (ROADMAP G2).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessReliability,
  assessLauncherOutput,
  DEFAULTS,
  ABS_SPREAD_FLOOR,
} from '../measure-quality.js';

// ---------------------------------------------------------------------------
// assessReliability — sample-count gate
// ---------------------------------------------------------------------------

test('assessReliability: fewer than minSamples → unreliable', () => {
  const r = assessReliability([2000, 2100], { metric: 'LCP' }); // n=2 < default 3
  assert.equal(r.reliable, false);
  assert.equal(r.n, 2);
  assert.match(r.reason, /only 2 valid samples/);
});

test('assessReliability: exactly minSamples with low spread → reliable', () => {
  const r = assessReliability([2000, 2050, 2100], { metric: 'LCP' });
  assert.equal(r.reliable, true);
  assert.equal(r.n, 3);
});

test('assessReliability: single sample → unreliable (singular wording)', () => {
  const r = assessReliability([2000], { metric: 'LCP' });
  assert.equal(r.reliable, false);
  assert.match(r.reason, /only 1 valid sample;/);
});

test('assessReliability: custom minSamples honored', () => {
  assert.equal(assessReliability([2000, 2100], { metric: 'LCP', minSamples: 2 }).reliable, true);
  assert.equal(assessReliability([2000, 2100, 2200], { metric: 'LCP', minSamples: 5 }).reliable, false);
});

test('assessReliability: non-numeric / non-finite samples are filtered out', () => {
  const r = assessReliability([2000, null, NaN, '2100', Infinity, 2200, 2300], { metric: 'LCP' });
  assert.equal(r.n, 3); // only 2000, 2200, 2300 count
  assert.equal(r.reliable, true);
});

// ---------------------------------------------------------------------------
// assessReliability — relative-spread gate
// ---------------------------------------------------------------------------

test('assessReliability: IQR ≫ median → unreliable (noisy)', () => {
  const r = assessReliability([500, 3000, 6000, 12000], { metric: 'LCP' });
  assert.equal(r.reliable, false);
  assert.match(r.reason, /too noisy/);
  assert.ok(r.relSpread > DEFAULTS.maxRelSpread);
});

test('assessReliability: tight cluster → reliable, low relSpread', () => {
  const r = assessReliability([2000, 2010, 2020, 2030, 2040], { metric: 'LCP' });
  assert.equal(r.reliable, true);
  assert.ok(r.relSpread < 0.1, `relSpread=${r.relSpread}`);
});

test('assessReliability: maxRelSpread=null disables the noise gate', () => {
  const r = assessReliability([500, 3000, 6000, 12000], { metric: 'LCP', maxRelSpread: null });
  assert.equal(r.reliable, true);
});

test('assessReliability: fast page — large RELATIVE spread but tiny ABSOLUTE swing → reliable', () => {
  // example.com shape: a cold run-1 outlier (1094) over a ~220ms steady state.
  // relIQR is large but absolute IQR is well under the LCP floor (1000ms).
  const r = assessReliability([205, 215, 225, 1094], { metric: 'LCP' });
  assert.equal(r.reliable, true, `reason=${r.reason}`);
  assert.ok(r.relSpread > DEFAULTS.maxRelSpread, 'relative spread is genuinely large');
});

test('assessReliability: near-zero CLS with tiny absolute IQR → reliable', () => {
  // median ~0.01, IQR ~0.01 — absolutely stable. Below the CLS abs IQR floor.
  const r = assessReliability([0.005, 0.01, 0.015, 0.02], { metric: 'CLS' });
  assert.equal(r.reliable, true, `reason=${r.reason}`);
  assert.ok(ABS_SPREAD_FLOOR.CLS > 0.02);
});

test('assessReliability: large CLS with wide absolute IQR → noisy', () => {
  // median ~0.35, IQR ~0.47 (> CLS abs floor 0.1) and relIQR > 0.6 → flagged.
  const r = assessReliability([0.01, 0.2, 0.5, 1.0], { metric: 'CLS' });
  assert.equal(r.reliable, false);
  assert.match(r.reason, /too noisy/);
});

test('assessReliability: empty input → unreliable n=0', () => {
  const r = assessReliability([], { metric: 'LCP' });
  assert.equal(r.reliable, false);
  assert.equal(r.n, 0);
});

// ---------------------------------------------------------------------------
// assessLauncherOutput
// ---------------------------------------------------------------------------

function mkRuns(perMetric) {
  // perMetric: { lcp: [..], cls: [..] } → runs[] aligned by index
  const n = Math.max(...Object.values(perMetric).map((a) => a.length));
  const runs = [];
  for (let i = 0; i < n; i += 1) {
    const cwv = {};
    for (const [k, arr] of Object.entries(perMetric)) {
      cwv[k] = arr[i] != null ? { value: arr[i] } : { value: null, reason: 'not-observed' };
    }
    runs.push({ cwv });
  }
  return { url: 'https://x.test/', runs };
}

test('assessLauncherOutput: all metrics reliable → allReliable true', () => {
  const doc = mkRuns({ lcp: [2000, 2050, 2100], cls: [0.01, 0.02, 0.03] });
  const out = assessLauncherOutput(doc, ['LCP', 'CLS']);
  assert.equal(out.allReliable, true);
  assert.equal(out.perMetric.LCP.reliable, true);
  assert.equal(out.perMetric.CLS.reliable, true);
});

test('assessLauncherOutput: one sparse metric → allReliable false, others still assessed', () => {
  const doc = mkRuns({ lcp: [2000, 2050, 2100], inp: [120] }); // inp n=1
  const out = assessLauncherOutput(doc, ['LCP', 'INP']);
  assert.equal(out.allReliable, false);
  assert.equal(out.perMetric.LCP.reliable, true);
  assert.equal(out.perMetric.INP.reliable, false);
  assert.equal(out.perMetric.INP.n, 1);
});

test('assessLauncherOutput: empty runs → every metric unreliable', () => {
  const out = assessLauncherOutput({ runs: [] }, ['LCP', 'CLS']);
  assert.equal(out.allReliable, false);
  assert.equal(out.perMetric.LCP.n, 0);
});
