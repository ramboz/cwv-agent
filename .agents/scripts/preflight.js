#!/usr/bin/env node

// ADR-0014 mechanism: an opt-in preflight gate a CLI script's main() can call
// before doing measurement/diagnosis/patch/publish work. Mirrors doctor.js's
// own split between a pure result-builder and an impure CLI main() — this
// module never calls process.exit; callers decide how to exit.
//
// Naming disambiguation: the "profile" this module resolves/checks is the
// EXECUTION/PROVIDER profile (doctor.js's `local`, `field-google`, ...) — NOT
// a caller's lab measurement profile (launcher.js/oracle.js `--profile`,
// e.g. `mobile-slow4g-4xcpu`).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXECUTION_PROFILES, runDoctor, formatDoctorText } from './doctor.js';

// ADR-0014 block/advise mapping. The gate must NOT key off doctor's rolled-up
// `ok` — doctor.js's summarize() flips ok:false when any required check is
// `fail`, `not-wired`, OR `unknown`, and a profile may carry a *permanently*
// `unknown` required check a zero-write doctor cannot self-verify. Keying off
// `ok` would permanently refuse such a run even for a fully provisioned
// operator. Instead:
//   - BLOCK (exit 1) on required `fail`/`not-wired` — doctor positively
//     determined the prerequisite is absent or the provider is unwired.
//   - ADVISE (exit 0 + visible warning) on required `unknown` — doctor could
//     not self-verify; surface it but do not refuse.
//   - Ignore `pass`/`info`.
const BLOCKING_STATUSES = ['fail', 'not-wired'];

/**
 * @param {object} o
 * @param {string|null} [o.profile] Execution/provider profile to preflight.
 *   When falsy and `skip` is falsy, this is a true no-op — no doctor call at
 *   all (see spec 014-01 AC3: the default/no-flag path must add zero cost).
 * @param {boolean} [o.skip] Explicit bypass (ADR-0014 escape hatch / AC4).
 *   When true, doctor is never invoked even if `profile` is set, and the
 *   result is tagged `skipped: true` so a bypassed run is distinguishable
 *   from both a clean pass and a not-run gate.
 * @param {object} [o.context] Forwarded to `runDoctor` (test seam).
 * @returns {{
 *   ran: boolean,
 *   skipped: boolean,
 *   ok: boolean,                 // "no blockers" — NOT doctorResult.ok
 *   profile: string|null,
 *   doctorResult: object|null,
 *   blockingChecks: object[],    // required fail/not-wired rows
 *   advisoryChecks: object[],    // required unknown rows
 * }}
 */
function checkPreflight({ profile = null, skip = false, context } = {}) {
  if (skip) {
    return {
      ran: false,
      skipped: true,
      ok: true,
      profile: profile || null,
      doctorResult: null,
      blockingChecks: [],
      advisoryChecks: [],
    };
  }
  if (!profile) {
    // No --preflight-profile flag passed: true no-op, matching today's
    // behavior exactly (no doctor subprocess work, no added latency).
    return {
      ran: false,
      skipped: false,
      ok: true,
      profile: null,
      doctorResult: null,
      blockingChecks: [],
      advisoryChecks: [],
    };
  }
  const doctorResult = runDoctor(
    context ? { profile, context } : { profile },
  );
  const requiredNonPass = doctorResult.checks.filter(
    (c) => c.required && c.status !== 'pass' && c.status !== 'info',
  );
  const blockingChecks = requiredNonPass.filter((c) => BLOCKING_STATUSES.includes(c.status));
  const advisoryChecks = requiredNonPass.filter((c) => c.status === 'unknown');
  return {
    ran: true,
    skipped: false,
    ok: blockingChecks.length === 0, // gate ok = no verifiable-missing blockers
    profile,
    doctorResult,
    blockingChecks,
    advisoryChecks,
  };
}

/**
 * Render a preflight result for CLI output and decide the process exit code,
 * mirroring doctor.js's own CLI convention: 0 = ok/no-op/advisory-only,
 * 1 = blocked. (Usage/argument errors, exit 2, are the caller's own parseArgs
 * concern — this helper only covers the gate's pass/block/advise/skip states.)
 *
 * On a block, print doctor's own report (which lists the failing rows). On a
 * clean-but-advisory pass, print only the advisory warnings (not the whole
 * report), so a fully provisioned publish/source run proceeds with a visible
 * "could not verify auth" note rather than a refusal.
 *
 * @param {ReturnType<typeof checkPreflight>} result
 * @returns {{ text: string, exitCode: 0|1 }}
 */
function formatPreflightGate(result) {
  if (result.skipped) {
    return {
      text: `preflight: skipped (--skip-preflight)${result.profile ? ` for profile "${result.profile}"` : ''}\n`,
      exitCode: 0,
    };
  }
  if (!result.ran) {
    return { text: '', exitCode: 0 };
  }
  const advisoryLines = result.advisoryChecks.map(
    (c) => `⚠ preflight: could not verify ${c.label}${c.detail ? ` — ${c.detail}` : ''}`,
  );
  if (result.blockingChecks.length > 0) {
    // Blocked: print doctor's full report (lists the failing rows verbatim),
    // plus the advisories alongside so nothing is hidden. Exit 1.
    const parts = [formatDoctorText(result.doctorResult)];
    if (advisoryLines.length) parts.push(`${advisoryLines.join('\n')}\n`);
    return { text: parts.join(''), exitCode: 1 };
  }
  // No blockers: advise-only (or clean). Exit 0.
  const text = advisoryLines.length ? `${advisoryLines.join('\n')}\n` : '';
  return { text, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Standalone CLI. This is the AUTHORITATIVE Step-0 gate (ADR-0014 / spec
// 014-01): cwv-orchestrate runs `node .agents/scripts/preflight.js --profile
// <resolved>` as its very first action — BEFORE creating progress/{slug}/ and
// before any launcher.js call — so a missing required prerequisite refuses the
// run without creating a directory or invoking the launcher (AC2 ordering).
// The launcher.js --preflight-profile flag remains a defense-in-depth layer.
//
// Exit-code convention mirrors doctor.js's own main(): 0 = ok/skipped/no-op,
// 1 = not-ready, 2 = usage/argument error.
// ---------------------------------------------------------------------------

function usage() {
  return `Usage: npm run preflight -- [--profile <name>] [--skip-preflight]\n\nProfiles: ${Object.keys(EXECUTION_PROFILES).join(', ')}\n`;
}

function parseArgs(argv) {
  // Default profile `local` so the standalone gate always runs a real check
  // (local is a no-op in practice — no required prerequisites — but it still
  // prints doctor's ready report, unlike the pure checkPreflight no-op path).
  const parsed = { profile: 'local', skip: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--skip-preflight') {
      parsed.skip = true;
    } else if (arg === '--profile') {
      const value = argv[i + 1];
      if (!value) return { ...parsed, error: '--profile requires a profile name' };
      parsed.profile = value;
      i += 1;
    } else if (arg.startsWith('--profile=')) {
      parsed.profile = arg.slice('--profile='.length);
    } else {
      return { ...parsed, error: `unknown argument "${arg}"` };
    }
  }
  return parsed;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (args.error) {
    process.stderr.write(`${args.error}\n${usage()}`);
    return 2;
  }
  try {
    const result = checkPreflight({ profile: args.profile, skip: args.skip });
    const gate = formatPreflightGate(result);
    if (gate.text) process.stdout.write(gate.text);
    return gate.exitCode;
  } catch (error) {
    // runDoctor throws on an unknown profile — surface it as a clean usage
    // error (exit 2), exactly as doctor.js's own main() does.
    process.stderr.write(`${error.message}\n${usage()}`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { checkPreflight, formatPreflightGate, parseArgs, main };
