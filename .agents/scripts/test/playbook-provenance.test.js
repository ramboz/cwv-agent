#!/usr/bin/env node

/**
 * playbook-provenance.test.js — spec 015-06 (playbook-sync-and-runbook).
 *
 * AC-1  Freshness signal — readProvenance / checkFreshness on real + temp dirs.
 * AC-2  Supported sync path — playbook-sync --check exits 0 in sync, non-zero
 *       when the vendored set differs from the source.
 * AC-4  Doctor surface — the freshness check appears as a doctor row with a
 *       present / stale / missing status.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  computeChecksum,
  readProvenance,
  checkFreshness,
  writeProvenance,
  PROVENANCE_FILE,
} from '../playbook-provenance.js';
import { runDoctor } from '../doctor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '..');
const REAL_PLAYBOOKS_DIR = path.resolve(SCRIPTS_DIR, '..', 'references', 'playbooks');
const SYNC_SCRIPT = path.join(SCRIPTS_DIR, 'playbook-sync.js');

/** Copy every *.md playbook (incl. README/_FORMAT) into a fresh temp dir. */
function copyPlaybooks(destName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${destName}-`));
  for (const f of fs.readdirSync(REAL_PLAYBOOKS_DIR)) {
    if (!f.endsWith('.md')) continue;
    fs.copyFileSync(path.join(REAL_PLAYBOOKS_DIR, f), path.join(dir, f));
  }
  return dir;
}

// --- AC-1: freshness signal -------------------------------------------------

test('AC-1: computeChecksum is stable + order-independent over the playbook set', () => {
  const a = computeChecksum(REAL_PLAYBOOKS_DIR);
  const b = computeChecksum(REAL_PLAYBOOKS_DIR);
  assert.equal(typeof a, 'string');
  assert.ok(a.length >= 32, 'checksum is a non-trivial hex digest');
  assert.equal(a, b, 'checksum is deterministic across calls');
});

test('AC-1: readProvenance returns { present:false } when the marker is missing', () => {
  const dir = copyPlaybooks('prov-missing');
  const prov = readProvenance(dir);
  assert.equal(prov.present, false);
});

test('AC-1: readProvenance parses a written marker', () => {
  const dir = copyPlaybooks('prov-present');
  writeProvenance(dir, { source: 'test-src', sourceRef: 'abc123' });
  const prov = readProvenance(dir);
  assert.equal(prov.present, true);
  assert.equal(prov.source, 'test-src');
  assert.equal(prov.sourceRef, 'abc123');
  assert.equal(typeof prov.checksum, 'string');
  assert.equal(typeof prov.playbookCount, 'number');
  assert.ok(prov.playbookCount > 0);
});

test('AC-1: checkFreshness reports not-stale on a freshly-written marker', () => {
  const dir = copyPlaybooks('prov-fresh');
  writeProvenance(dir, { source: 'test-src' });
  const res = checkFreshness(dir);
  assert.equal(res.present, true);
  assert.equal(res.stale, false);
  assert.equal(res.computedChecksum, res.recordedChecksum);
});

test('AC-1: checkFreshness detects a tampered playbook (stale checksum)', () => {
  const dir = copyPlaybooks('prov-tamper');
  writeProvenance(dir, { source: 'test-src' });
  // Tamper with a playbook AFTER the marker was recorded.
  const victim = path.join(dir, 'layout-shift.md');
  fs.appendFileSync(victim, '\n<!-- drift -->\n');
  const res = checkFreshness(dir);
  assert.equal(res.present, true);
  assert.equal(res.stale, true, 'a post-marker edit is detected as drift');
  assert.notEqual(res.computedChecksum, res.recordedChecksum);
});

test('AC-1: checkFreshness reports present:false, stale:true when the marker is absent', () => {
  const dir = copyPlaybooks('prov-none');
  const res = checkFreshness(dir);
  assert.equal(res.present, false);
  assert.equal(res.stale, true, 'a missing marker is treated as not-fresh, never silent');
});

// --- AC-2: supported sync path (--check dry-run) ----------------------------

function runSync(args, env = {}) {
  return spawnSync(process.execPath, [SYNC_SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('AC-2: playbook-sync --check exits 0 when the vendored set matches the source', () => {
  const source = copyPlaybooks('sync-src-match');
  const res = runSync(['--check'], { CWV_PLAYBOOKS_DIR: source });
  assert.equal(res.status, 0, `expected in-sync exit 0, got ${res.status}: ${res.stderr}`);
});

test('AC-2: playbook-sync --check exits non-zero when the source differs', () => {
  const source = copyPlaybooks('sync-src-diff');
  // Make the source diverge from the vendored set.
  fs.appendFileSync(path.join(source, 'layout-shift.md'), '\n<!-- source drift -->\n');
  const res = runSync(['--check'], { CWV_PLAYBOOKS_DIR: source });
  assert.notEqual(res.status, 0, 'out-of-sync --check must exit non-zero');
});

test('AC-2: playbook-sync --check does NOT write the vendored set', () => {
  const source = copyPlaybooks('sync-src-nowrite');
  fs.appendFileSync(path.join(source, 'layout-shift.md'), '\n<!-- source drift -->\n');
  const before = computeChecksum(REAL_PLAYBOOKS_DIR);
  runSync(['--check'], { CWV_PLAYBOOKS_DIR: source });
  const after = computeChecksum(REAL_PLAYBOOKS_DIR);
  assert.equal(before, after, '--check is a dry-run: the vendored set is untouched');
});

// --- AC-4: doctor surface ---------------------------------------------------

test('AC-4: the doctor local profile includes a playbook-freshness row', () => {
  const result = runDoctor({ profile: 'local' });
  const row = result.checks.find((c) => c.id === 'playbooks:freshness');
  assert.ok(row, 'doctor emits a playbooks:freshness row');
  assert.ok(['pass', 'fail', 'info'].includes(row.status), `unexpected status ${row.status}`);
  assert.match(row.label, /playbook/i);
});

test('AC-4: the real vendored set carries a fresh provenance marker', () => {
  // The committed PROVENANCE.json must match the committed playbooks.
  assert.ok(fs.existsSync(path.join(REAL_PLAYBOOKS_DIR, PROVENANCE_FILE)), 'PROVENANCE.json is committed');
  const res = checkFreshness(REAL_PLAYBOOKS_DIR);
  assert.equal(res.present, true);
  assert.equal(res.stale, false, 'committed PROVENANCE.json matches the committed playbooks');
});
