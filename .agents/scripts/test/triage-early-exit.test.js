#!/usr/bin/env node

/**
 * Tests for .agents/scripts/triage-early-exit.js — the pure-function helper
 * that encodes cwv-triage Step 6b's field-already-passing decision.
 *
 * Also covers a hand-built passing-envelope fixture going through the
 * finding-schema validator (smoke test that the validator's loose
 * top-level-field policy does not reject `status: "passing"` + `passing`).
 */

import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';

import {
  decideEarlyExit,
  buildPassingEnvelope,
  computePressure,
  GOOD_THRESHOLDS,
  FIELD_SOURCES,
} from '../triage-early-exit.js';
import { validateEnvelope } from '../finding-schema.js';

const FIXTURES = path.join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// computePressure
// ---------------------------------------------------------------------------

test('computePressure: the pets-site case-shaped GOOD reading', () => {
  const { maxPressure, perMetric } = computePressure({ LCP: 1393, CLS: 0.02, INP: 106 });
  assert.ok(maxPressure < 1.0, `expected < 1.0, got ${maxPressure}`);
  assert.ok(perMetric.LCP < 1.0);
  assert.ok(perMetric.CLS < 1.0);
  assert.ok(perMetric.INP < 1.0);
});

test('computePressure: LCP at threshold reads as pressure 1.0', () => {
  const { perMetric } = computePressure({ LCP: 2500 });
  assert.equal(perMetric.LCP, 1.0);
});

test('computePressure: missing metric → null, not 0', () => {
  const { perMetric } = computePressure({ LCP: 1000 });
  assert.equal(perMetric.LCP, 0.4);
  assert.equal(perMetric.CLS, null);
  assert.equal(perMetric.INP, null);
});

// ---------------------------------------------------------------------------
// decideEarlyExit — the core rule
// ---------------------------------------------------------------------------

test('decideEarlyExit: the pets-site case 2026-04-17 (all GOOD on PHONE + DESKTOP) → passing', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE:   { source: 'crux', metrics: { LCP: 1393, CLS: 0.02, INP: 106 } },
      DESKTOP: { source: 'crux', metrics: { LCP: 1120, CLS: 0.01, INP: 88  } },
    },
    targetMetrics: ['LCP', 'CLS', 'INP'],
  });
  assert.ok(dec.passing, `expected passing, got: ${dec.reasonIfNotPassing}`);
  assert.equal(dec.passing.reason, 'field-already-good');
  assert.deepEqual(dec.passing.checked, ['LCP', 'CLS', 'INP']);
  assert.ok(dec.passing.byFormFactor.PHONE.maxPressure < 1.0);
  assert.ok(dec.passing.byFormFactor.DESKTOP.maxPressure < 1.0);
  assert.deepEqual(dec.passing.thresholds, GOOD_THRESHOLDS);
});

test('decideEarlyExit: one metric at threshold (pressure == 1.0) → NOT passing', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE: { source: 'crux', metrics: { LCP: 2500, CLS: 0.02, INP: 106 } },
    },
  });
  assert.equal(dec.passing, null);
  assert.match(dec.reasonIfNotPassing, /LCP pressure/);
});

test('decideEarlyExit: all GOOD on PHONE but DESKTOP has poor LCP → NOT passing', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE:   { source: 'crux', metrics: { LCP: 1393, CLS: 0.02, INP: 106 } },
      DESKTOP: { source: 'crux', metrics: { LCP: 4200, CLS: 0.01, INP: 88  } },
    },
  });
  assert.equal(dec.passing, null);
  assert.match(dec.reasonIfNotPassing, /DESKTOP/);
});

test('decideEarlyExit: PSI-only signal → NOT passing (PSI is lab, not field)', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE: { source: 'psi', metrics: { LCP: 1200, CLS: 0.01, INP: 90 } },
    },
  });
  assert.equal(dec.passing, null);
  assert.match(dec.reasonIfNotPassing, /not field data/);
});

test('decideEarlyExit: RUM source counts as field (Helix-instrumented)', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE: { source: 'rum', metrics: { LCP: 1800, CLS: 0.04, INP: 150 } },
    },
  });
  assert.ok(dec.passing, `expected passing, got: ${dec.reasonIfNotPassing}`);
  assert.equal(dec.passing.byFormFactor.PHONE.source, 'rum');
});

test('decideEarlyExit: RUM GOOD + CrUX NI on same FF → NOT passing (CrUX wins at 28d)', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE: { source: 'rum', metrics: { LCP: 1800, CLS: 0.04, INP: 150 } },
    },
    cruxOverride: {
      PHONE: { source: 'crux', metrics: { LCP: 3200, CLS: 0.04, INP: 150 } },
    },
  });
  assert.equal(dec.passing, null);
  assert.match(dec.reasonIfNotPassing, /CrUX/);
});

test('decideEarlyExit: RUM GOOD + CrUX also GOOD → passing', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE: { source: 'rum', metrics: { LCP: 1800, CLS: 0.04, INP: 150 } },
    },
    cruxOverride: {
      PHONE: { source: 'crux', metrics: { LCP: 2000, CLS: 0.05, INP: 180 } },
    },
  });
  assert.ok(dec.passing, `expected passing, got: ${dec.reasonIfNotPassing}`);
});

test('decideEarlyExit: INP missing but LCP+CLS GOOD → passing (absence tolerated only for INP)', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE: { source: 'crux', metrics: { LCP: 1393, CLS: 0.02 } },
    },
  });
  assert.ok(dec.passing, `expected passing, got: ${dec.reasonIfNotPassing}`);
});

test('decideEarlyExit: INP missing AND LCP poor → NOT passing', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE: { source: 'crux', metrics: { LCP: 3200, CLS: 0.02 } },
    },
  });
  assert.equal(dec.passing, null);
});

test('decideEarlyExit: LCP missing (even with CLS+INP GOOD) → NOT passing', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE: { source: 'crux', metrics: { CLS: 0.02, INP: 106 } },
    },
  });
  assert.equal(dec.passing, null);
  assert.match(dec.reasonIfNotPassing, /LCP/);
});

test('decideEarlyExit: empty formFactorSignals → NOT passing', () => {
  const dec = decideEarlyExit({ formFactorSignals: {} });
  assert.equal(dec.passing, null);
});

test('decideEarlyExit: unknown target metric (FCP) → NOT passing (conservative)', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE: { source: 'crux', metrics: { LCP: 1393, CLS: 0.02, INP: 106 } },
    },
    targetMetrics: ['LCP', 'CLS', 'INP', 'FCP'],
  });
  assert.equal(dec.passing, null);
  assert.match(dec.reasonIfNotPassing, /FCP/);
});

test('decideEarlyExit: CLS exactly at 0.1 → NOT passing (strict <, not ≤)', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE: { source: 'crux', metrics: { LCP: 1393, CLS: 0.1, INP: 106 } },
    },
  });
  assert.equal(dec.passing, null);
  assert.match(dec.reasonIfNotPassing, /CLS/);
});

// ---------------------------------------------------------------------------
// Envelope construction + validator smoke
// ---------------------------------------------------------------------------

test('buildPassingEnvelope produces a validator-clean envelope (empty findings)', () => {
  const dec = decideEarlyExit({
    formFactorSignals: {
      PHONE:   { source: 'crux', metrics: { LCP: 1393, CLS: 0.02, INP: 106 } },
      DESKTOP: { source: 'crux', metrics: { LCP: 1120, CLS: 0.01, INP: 88  } },
    },
  });
  const env = buildPassingEnvelope({
    url: 'https://pets.example.com/',
    recommendedFormFactor: 'PHONE',
    recommendedProfile: 'mobile-slow4g-4xcpu',
    passing: dec.passing,
    timestamp: '2026-04-17T12:00:00.000Z',
  });
  assert.equal(env.status, 'passing');
  const res = validateEnvelope(env);
  assert.equal(res.valid, true, `validator errors: ${JSON.stringify(res.errors)}`);
});

test('passing envelope fixture validates clean (the pets-site case, empty findings)', () => {
  const env = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'triage-passing.json'), 'utf8'));
  assert.equal(env.status, 'passing');
  const res = validateEnvelope(env);
  assert.equal(res.valid, true, `validator errors: ${JSON.stringify(res.errors)}`);
});

test('passing envelope fixture with rejected findings validates clean', () => {
  const env = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'triage-passing-with-rejected-findings.json'), 'utf8'));
  assert.equal(env.status, 'passing');
  assert.equal(env.findings.length, 1);
  assert.equal(env.findings[0].status, 'rejected');
  const res = validateEnvelope(env);
  assert.equal(res.valid, true, `validator errors: ${JSON.stringify(res.errors)}`);
});

test('non-passing envelope fixture has no status field and validates', () => {
  const env = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'triage-not-passing.json'), 'utf8'));
  assert.equal(env.status, undefined);
  const res = validateEnvelope(env);
  assert.equal(res.valid, true, `validator errors: ${JSON.stringify(res.errors)}`);
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

test('GOOD_THRESHOLDS matches web.dev CWV definitions (2500/0.1/200)', () => {
  assert.equal(GOOD_THRESHOLDS.LCP, 2500);
  assert.equal(GOOD_THRESHOLDS.CLS, 0.1);
  assert.equal(GOOD_THRESHOLDS.INP, 200);
});

test('FIELD_SOURCES is crux + rum only (PSI excluded)', () => {
  assert.ok(FIELD_SOURCES.has('crux'));
  assert.ok(FIELD_SOURCES.has('rum'));
  assert.ok(!FIELD_SOURCES.has('psi'));
});
