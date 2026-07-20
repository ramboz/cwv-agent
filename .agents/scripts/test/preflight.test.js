#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { checkPreflight, formatPreflightGate } from '../preflight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREFLIGHT_PATH = path.join(__dirname, '..', 'preflight.js');

function runPreflightCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [PREFLIGHT_PATH, ...args], {
      encoding: 'utf8',
      timeout: 10000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

function makeHealthyContext(overrides = {}) {
  return {
    env: {},
    nodeVersion: '20.11.1',
    packageJson: {
      scripts: {
        doctor: 'node .agents/scripts/doctor.js',
        measure: 'node .agents/scripts/launcher.js',
        setup: 'node .agents/scripts/setup.js',
      },
    },
    fileExists() {
      return true;
    },
    pathWritable() {
      return true;
    },
    moduleAvailable() {
      return true;
    },
    commandAvailable() {
      return true;
    },
    scriptHealth() {
      return { ok: true, detail: 'node --check passed' };
    },
    pathExists() {
      return true;
    },
    readJsonAbsolute() {
      return null;
    },
    adapterExists() {
      return true;
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC3 — default (no --preflight-profile) is a true no-op: no doctor call.
// ---------------------------------------------------------------------------

test('default (no profile, no skip) is a true no-op — never calls doctor', () => {
  let doctorInvoked = false;
  const context = makeHealthyContext({
    commandAvailable() {
      doctorInvoked = true;
      return true;
    },
    moduleAvailable() {
      doctorInvoked = true;
      return true;
    },
  });
  const result = checkPreflight({ context });

  assert.equal(result.ran, false);
  assert.equal(result.skipped, false);
  assert.equal(result.ok, true);
  assert.equal(result.profile, null);
  assert.equal(result.doctorResult, null);
  assert.equal(doctorInvoked, false, 'no-flag path must not touch doctor at all');
});

test('formatPreflightGate on the no-op result prints nothing and exits 0', () => {
  const result = checkPreflight({});
  const { text, exitCode } = formatPreflightGate(result);
  assert.equal(text, '');
  assert.equal(exitCode, 0);
});

// ---------------------------------------------------------------------------
// AC1/AC2 — --preflight-profile with a healthy context passes through.
// ---------------------------------------------------------------------------

test('--preflight-profile local with a healthy fake context passes through cleanly', () => {
  const context = makeHealthyContext();
  const result = checkPreflight({ profile: 'local', context });

  assert.equal(result.ran, true);
  assert.equal(result.skipped, false);
  assert.equal(result.ok, true);
  assert.equal(result.profile, 'local');
  assert.equal(result.doctorResult.status, 'ready');
  assert.equal(result.blockingChecks.length, 0);
  assert.equal(result.advisoryChecks.length, 0);

  const { text, exitCode } = formatPreflightGate(result);
  assert.equal(exitCode, 0);
  assert.equal(text, '', 'a clean pass with no advisories prints nothing (no friction)');
});

// ---------------------------------------------------------------------------
// Block only on VERIFIABLE-missing required checks (doctor `fail`/`not-wired`),
// NOT on doctor's rolled-up `ok` (which also flips false on a permanently
// `unknown` required check a zero-write doctor can't self-verify). ADR-0014:
// block on fail+not-wired, advise on unknown.
// ---------------------------------------------------------------------------

test('a required check with status `fail` blocks the run (exit 1)', () => {
  const context = makeHealthyContext({
    moduleAvailable(name) {
      return name !== 'puppeteer'; // module:puppeteer becomes a required fail
    },
  });
  const result = checkPreflight({ profile: 'local', context });

  assert.equal(result.ran, true);
  assert.equal(result.skipped, false);
  assert.equal(result.ok, false, 'ok now means "no blockers" — a fail is a blocker');
  assert.equal(result.blockingChecks.length, 1);
  assert.equal(result.blockingChecks[0].id, 'module:puppeteer');
  assert.equal(result.advisoryChecks.length, 0);

  const { text, exitCode } = formatPreflightGate(result);
  assert.equal(exitCode, 1);
  assert.match(text, /Puppeteer package availability/);
});

test('a genuinely missing required command (fail) still blocks a provider profile', () => {
  // No commands on PATH → mysticat/curl/jq are required `fail`s. That is a
  // verifiable-missing prerequisite, so it blocks regardless of the `unknown`
  // auth check that also sits in this profile.
  const context = makeHealthyContext({
    commandAvailable() {
      return false;
    },
  });
  const result = checkPreflight({ profile: 'publish-spacecat', context });

  assert.equal(result.ok, false);
  assert.ok(result.blockingChecks.some((c) => c.id === 'command:mysticat'));
  const { exitCode } = formatPreflightGate(result);
  assert.equal(exitCode, 1);
});

test('a required `unknown` check ADVISES (exit 0, visible warning) — does not refuse', () => {
  // publish-spacecat with all its required commands present: the only
  // remaining required non-pass is `manual:publish-spacecat-auth` (status
  // `unknown` — a zero-write doctor can't verify auth). doctor rolls this up
  // to ok:false, but the gate must NOT refuse a fully-tooled operator's run.
  const context = makeHealthyContext({
    commandAvailable() {
      return true; // mysticat, curl, jq all present
    },
  });
  const result = checkPreflight({ profile: 'publish-spacecat', context });

  assert.equal(result.doctorResult.ok, false, 'doctor still rolls up ok:false on the unknown');
  assert.equal(result.ok, true, 'gate ok — no fail/not-wired blockers');
  assert.equal(result.blockingChecks.length, 0);
  assert.ok(result.advisoryChecks.some((c) => c.id === 'manual:publish-spacecat-auth'));

  const { text, exitCode } = formatPreflightGate(result);
  assert.equal(exitCode, 0, 'unknown must not refuse the run');
  assert.match(text, /could not verify/i);
  assert.match(text, /SpaceCat api-service access|publish-spacecat-auth|mysticat/i);
});

test('a required `not-wired` adapter blocks the run (exit 1)', () => {
  // diagnose-cwv-agent's adapter is `not-wired` in this repo → a positive
  // "provider is unwired" determination, which blocks (unlike `unknown`).
  const result = checkPreflight({ profile: 'diagnose-cwv-agent', context: makeHealthyContext({
    adapterExists() {
      return false;
    },
  }) });

  assert.equal(result.ok, false);
  assert.ok(result.blockingChecks.some((c) => c.status === 'not-wired'));
  const { exitCode } = formatPreflightGate(result);
  assert.equal(exitCode, 1);
});

// ---------------------------------------------------------------------------
// AC4 — --skip-preflight bypasses a would-fail check, distinguishable from
// a clean pass.
// ---------------------------------------------------------------------------

test('--skip-preflight bypasses a would-fail check without invoking doctor', () => {
  let doctorInvoked = false;
  const context = makeHealthyContext({
    moduleAvailable() {
      doctorInvoked = true;
      return false; // would fail every module check if doctor ran
    },
  });
  const result = checkPreflight({ profile: 'local', skip: true, context });

  assert.equal(result.ran, false, 'doctor is never invoked when skipped');
  assert.equal(result.skipped, true);
  assert.equal(result.ok, true);
  assert.equal(result.doctorResult, null);
  assert.equal(doctorInvoked, false);

  const { text, exitCode } = formatPreflightGate(result);
  assert.equal(exitCode, 0);
  assert.match(text, /skipped/i);
  assert.match(text, /--skip-preflight/);
});

test('a skipped result is distinguishable from a clean pass result', () => {
  const context = makeHealthyContext();
  const clean = formatPreflightGate(checkPreflight({ profile: 'local', context }));
  const skipped = formatPreflightGate(checkPreflight({ profile: 'local', skip: true, context }));

  assert.notEqual(clean.text, skipped.text);
  assert.equal(clean.exitCode, 0);
  assert.equal(skipped.exitCode, 0);
  assert.match(skipped.text, /skipped/i);
  assert.doesNotMatch(clean.text, /skipped/i);
});

// ---------------------------------------------------------------------------
// No implicit mutation (AC5 in the slice / AC4 in the spec): checkPreflight
// only imports/calls runDoctor — never setup.js. Grep-verifiable statically,
// but assert here too that no `context.runCommand` call ever targets setup.js.
// ---------------------------------------------------------------------------

test('preflight never invokes setup.js, only doctor checks', () => {
  const runCommandCalls = [];
  const context = makeHealthyContext({
    runCommand(command, args = []) {
      runCommandCalls.push([command, ...args].join(' '));
      return { status: 0, stdout: '', stderr: '', error: null };
    },
  });
  checkPreflight({ profile: 'aem-clientlibs', context });

  assert.ok(
    runCommandCalls.every((call) => !/setup\.js/.test(call)),
    `expected no setup.js invocation, got: ${JSON.stringify(runCommandCalls)}`,
  );
});

// ---------------------------------------------------------------------------
// Unknown profile — checkPreflight surfaces runDoctor's throw; the CLI main()
// turns it into a clean usage error (exit 2), mirroring doctor.js's own main().
// ---------------------------------------------------------------------------

test('checkPreflight throws runDoctor\'s error for an unknown profile', () => {
  assert.throws(
    () => checkPreflight({ profile: 'not-a-real-profile', context: makeHealthyContext() }),
    /Unknown profile "not-a-real-profile"/,
  );
});

// ---------------------------------------------------------------------------
// Standalone CLI (the AUTHORITATIVE Step-0 gate). No browser is ever launched;
// preflight.js imports doctor.js only.
// ---------------------------------------------------------------------------

test('CLI: default profile (local) exits 0 cleanly (no blockers, no advisories)', () => {
  const result = runPreflightCli([]);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /could not verify/i, 'local has no advisories');
  assert.doesNotMatch(result.stdout, /FAIL/, 'local is a clean pass on this repo');
});

test('CLI: --profile with a VERIFIABLE-missing required prerequisite refuses (exit 1)', () => {
  // diagnose-cwv-agent's adapter is `not-wired` in-repo — a deterministic,
  // host-independent block (no env/tool dependency), unlike publish-spacecat
  // whose only non-pass on a tooled host is the non-blocking `unknown` auth.
  const result = runPreflightCli(['--profile', 'diagnose-cwv-agent']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /diagnose-cwv-agent provider adapter/);
});

test('CLI: --profile publish-spacecat ADVISES on unverifiable auth, does not refuse (exit 0)', () => {
  // On this repo's host, publish-spacecat's required commands (mysticat/curl/jq)
  // may or may not be present. If any are missing it's a genuine fail (exit 1);
  // if all present, only the `unknown` auth remains → advisory (exit 0). Assert
  // the key property: a bare `unknown` is never the sole reason for a refusal.
  const result = runPreflightCli(['--profile', 'publish-spacecat']);
  if (result.status === 0) {
    assert.match(result.stdout, /could not verify/i, 'exit 0 must carry the unknown advisory');
  } else {
    assert.equal(result.status, 1);
    // A block here must be a real fail (a missing command), not the unknown auth.
    assert.match(result.stdout, /not found on PATH|FAIL/i);
  }
});

test('CLI: --skip-preflight bypasses the gate, exit 0, visible, no browser', () => {
  const result = runPreflightCli(['--profile', 'diagnose-cwv-agent', '--skip-preflight']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /preflight: skipped \(--skip-preflight\) for profile "diagnose-cwv-agent"/);
  assert.doesNotMatch(result.stdout, /provider adapter/, 'a skipped gate never runs doctor');
});

test('CLI: an unknown --profile is a clean usage error (exit 2), not an uncaught throw', () => {
  const result = runPreflightCli(['--profile', 'not-a-real-profile']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown profile "not-a-real-profile"/);
  assert.match(result.stderr, /Usage:/);
});

test('CLI: --help prints usage and exits 0', () => {
  const result = runPreflightCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});
