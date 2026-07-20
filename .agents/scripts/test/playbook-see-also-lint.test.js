#!/usr/bin/env node

/**
 * Tests for playbook-see-also-lint.js — validates the typed `see_also`
 * cross-reference graph across the CWV playbooks (spec 015-01):
 *   - every see_also.playbook names an existing playbook file (AC-3)
 *   - every edge is one of the four allowed types (AC-4)
 *   - the see_also graph is acyclic; a cycle is detected + reported (AC-4)
 *   - the lint is green on the real playbook set (AC-5)
 *
 * Fixtures are built in an OS temp dir (never under the real playbooks dir)
 * and cleaned up after each case.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintSeeAlso } from '../playbook-see-also-lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_PLAYBOOKS_DIR = path.resolve(__dirname, '../../references/playbooks');

/** Build a minimal playbook markdown file with a `see_also` front-matter block. */
function playbook(issueType, seeAlso) {
  const lines = ['---', `issue_type: ${issueType}`];
  if (seeAlso && seeAlso.length) {
    lines.push('see_also:');
    for (const e of seeAlso) {
      lines.push(`  - playbook: ${e.playbook}`);
      lines.push(`    edge: ${e.edge}`);
      lines.push(`    reason: "${e.reason || 'test'}"`);
    }
  }
  lines.push('---', '', `# ${issueType}`, '');
  return lines.join('\n');
}

/** Create a temp playbook dir; caller writes files then lints; auto-cleaned. */
function withTempDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'see-also-lint-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// (a) AC-5 — the real playbook set lints clean.
test('lintSeeAlso: real playbook dir is ok', () => {
  const res = lintSeeAlso(REAL_PLAYBOOKS_DIR);
  assert.equal(res.ok, true, `expected clean lint, got errors: ${JSON.stringify(res.errors)}`);
  assert.deepEqual(res.errors, []);
});

// (b) AC-3 — a see_also target that does not exist fails.
test('lintSeeAlso: fails on non-existent target playbook', () => {
  withTempDir(
    {
      'a.md': playbook('a', [{ playbook: 'does-not-exist', edge: 'complements' }]),
      'b.md': playbook('b', []),
    },
    (dir) => {
      const res = lintSeeAlso(dir);
      assert.equal(res.ok, false);
      assert.ok(
        res.errors.some((e) => e.includes('does-not-exist')),
        `expected an error mentioning the missing target, got: ${JSON.stringify(res.errors)}`,
      );
    },
  );
});

// (c) AC-4 — an unknown edge value fails.
test('lintSeeAlso: fails on unknown edge value', () => {
  withTempDir(
    {
      'a.md': playbook('a', [{ playbook: 'b', edge: 'depends_on' }]),
      'b.md': playbook('b', []),
    },
    (dir) => {
      const res = lintSeeAlso(dir);
      assert.equal(res.ok, false);
      assert.ok(
        res.errors.some((e) => e.includes('depends_on')),
        `expected an error mentioning the bad edge, got: ${JSON.stringify(res.errors)}`,
      );
    },
  );
});

// (d) AC-4 — a cycle is DETECTED and REPORTED, but is NON-FATAL: the resolver
// (015-02) is cycle-safe via a visited-set, so cycles are permitted. The cycle
// must appear in `warnings` (naming the nodes) while `ok` stays true.
test('lintSeeAlso: reports a cycle as a non-fatal warning (ok stays true)', () => {
  withTempDir(
    {
      'a.md': playbook('a', [{ playbook: 'b', edge: 'complements' }]),
      'b.md': playbook('b', [{ playbook: 'c', edge: 'complements' }]),
      'c.md': playbook('c', [{ playbook: 'a', edge: 'complements' }]),
    },
    (dir) => {
      const res = lintSeeAlso(dir);
      assert.equal(res.ok, true, `cycle must be non-fatal; got errors: ${JSON.stringify(res.errors)}`);
      assert.deepEqual(res.errors, []);
      assert.ok(
        res.warnings.some((w) => /cycle/i.test(w)),
        `expected a cycle warning, got: ${JSON.stringify(res.warnings)}`,
      );
      // The reported cycle should name the involved playbooks.
      assert.ok(
        res.warnings.some((w) => /cycle/i.test(w) && w.includes('a') && w.includes('b') && w.includes('c')),
        `expected the cycle warning to name a, b, c, got: ${JSON.stringify(res.warnings)}`,
      );
    },
  );
});

// (e) AC-4 — a self-loop (a -> a) is reported as a warning, non-fatal.
test('lintSeeAlso: reports a self-loop as a non-fatal warning', () => {
  withTempDir(
    {
      'a.md': playbook('a', [{ playbook: 'a', edge: 'complements' }]),
    },
    (dir) => {
      const res = lintSeeAlso(dir);
      assert.equal(res.ok, true, `self-loop must be non-fatal; got errors: ${JSON.stringify(res.errors)}`);
      assert.ok(
        res.warnings.some((w) => /cycle/i.test(w) && w.includes('a')),
        `expected a self-loop cycle warning naming 'a', got: ${JSON.stringify(res.warnings)}`,
      );
    },
  );
});

// (f) A nonexistent dir returns ok:false with an error (does not throw).
test('lintSeeAlso: nonexistent dir returns ok:false without throwing', () => {
  const missing = path.join(os.tmpdir(), 'see-also-lint-does-not-exist-' + Date.now());
  let res;
  assert.doesNotThrow(() => {
    res = lintSeeAlso(missing);
  });
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.length > 0,
    `expected at least one error for a missing dir, got: ${JSON.stringify(res.errors)}`,
  );
});
