#!/usr/bin/env node

/**
 * playbook-sync.js — the 015-06 supported playbook sync path (ADR-0015
 * §Consequences: "the manual `cp` sync becomes a real risk that
 * needs a supported path"). Replaces the ad-hoc `cp` documented in
 * `references/playbooks/README.md`.
 *
 * The vendored playbooks under `.agents/references/playbooks/` are the source
 * of truth the 015-03/04/05 gates enforce. This script refreshes them from a
 * source directory and rewrites `PROVENANCE.json` (a stable checksum marker),
 * so a stale set is detectable via `playbook-provenance.js` / `npm run doctor`.
 *
 * Source directory resolution (first hit wins):
 *   1. `--source <dir>` CLI flag
 *   2. `CWV_PLAYBOOKS_DIR` env
 *   3. nothing (the set is owned in-repo).
 *
 * Modes:
 *   (default) refresh — copy `*.md` issue-type playbooks from the source into
 *     the vendored dir, then rewrite PROVENANCE.json. Prints what changed.
 *   `--check` — DRY RUN: compare the vendored set to the source WITHOUT
 *     writing. Exit 0 when in sync, non-zero (3) when they differ. This is the
 *     CI/doctor-friendly drift probe.
 *   `--source-ref <ref>` — record a commit/snapshot ref in the marker.
 *
 * ESM only. Zero runtime deps.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  playbookFiles,
  computeChecksum,
  writeProvenance,
  PROVENANCE_FILE,
} from './playbook-provenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDORED_DIR = path.resolve(__dirname, '..', 'references', 'playbooks');

/**
 * Resolve the source playbooks directory from CLI flag → env. The playbook set
 * is owned in-repo; syncing from an external curated set is optional.
 * @param {string|null} sourceFlag
 * @returns {string|null}
 */
export function resolveSourceDir(sourceFlag) {
  if (sourceFlag) return path.resolve(sourceFlag);
  if (process.env.CWV_PLAYBOOKS_DIR) return path.resolve(process.env.CWV_PLAYBOOKS_DIR);
  return null;
}

/**
 * Diff the enforced playbook sets of two directories by per-file content.
 * @param {string} sourceDir
 * @param {string} vendoredDir
 * @returns {{ inSync: boolean, added: string[], removed: string[], changed: string[] }}
 */
export function diffSets(sourceDir, vendoredDir) {
  const src = new Set(playbookFiles(sourceDir));
  const dst = new Set(playbookFiles(vendoredDir));
  const added = [];
  const removed = [];
  const changed = [];
  for (const f of src) {
    if (!dst.has(f)) {
      added.push(f);
      continue;
    }
    const a = fs.readFileSync(path.join(sourceDir, f));
    const b = fs.readFileSync(path.join(vendoredDir, f));
    if (!a.equals(b)) changed.push(f);
  }
  for (const f of dst) {
    if (!src.has(f)) removed.push(f);
  }
  return {
    inSync: added.length === 0 && removed.length === 0 && changed.length === 0,
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

function parseArgs(argv) {
  const parsed = { check: false, source: null, sourceRef: null, help: false, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') parsed.check = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--source') parsed.source = argv[++i] || null;
    else if (arg.startsWith('--source=')) parsed.source = arg.slice('--source='.length);
    else if (arg === '--source-ref') parsed.sourceRef = argv[++i] || null;
    else if (arg.startsWith('--source-ref=')) parsed.sourceRef = arg.slice('--source-ref='.length);
    else parsed.error = `unknown argument "${arg}"`;
  }
  return parsed;
}

function usage() {
  return [
    'Usage: node .agents/scripts/playbook-sync.js [--check] [--source <dir>] [--source-ref <ref>]',
    '',
    'Refresh the vendored CWV playbooks and rewrite PROVENANCE.json.',
    'Source dir resolves from --source, then CWV_PLAYBOOKS_DIR.',
    '',
    '  --check        Dry run: report drift vs the source, write nothing. Exit 3 if out of sync.',
    '  --source <d>   Source playbooks directory (overrides CWV_PLAYBOOKS_DIR).',
    '  --source-ref   Commit/snapshot ref to record in the marker.',
    '',
  ].join('\n');
}

function printDiff(out, diff) {
  for (const f of diff.added) out(`  + ${f} (new in source)`);
  for (const f of diff.removed) out(`  - ${f} (only in vendored)`);
  for (const f of diff.changed) out(`  ~ ${f} (content differs)`);
}

/**
 * Copy the source's enforced playbook set into the vendored dir, removing any
 * vendored issue-type playbook no longer present in the source. Returns the diff
 * that was applied.
 */
function applyRefresh(sourceDir, vendoredDir, diff) {
  for (const f of [...diff.added, ...diff.changed]) {
    fs.copyFileSync(path.join(sourceDir, f), path.join(vendoredDir, f));
  }
  for (const f of diff.removed) {
    fs.rmSync(path.join(vendoredDir, f), { force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (args.error) {
    process.stderr.write(`${args.error}\n${usage()}`);
    return 2;
  }

  const sourceDir = resolveSourceDir(args.source);
  const out = (line) => process.stdout.write(`${line}\n`);

  if (!sourceDir || !fs.existsSync(sourceDir) || playbookFiles(sourceDir).length === 0) {
    process.stderr.write(
      `source playbooks directory not found or empty: ${sourceDir || '(unset)'}\n`
      + 'Point --source or CWV_PLAYBOOKS_DIR at a playbooks directory.\n',
    );
    return 4;
  }

  const diff = diffSets(sourceDir, VENDORED_DIR);

  if (args.check) {
    if (diff.inSync) {
      out(`in sync: vendored playbooks match ${sourceDir} (checksum ${String(computeChecksum(VENDORED_DIR)).slice(0, 12)})`);
      return 0;
    }
    out(`OUT OF SYNC: vendored playbooks differ from ${sourceDir}`);
    printDiff(out, diff);
    out('Run without --check to refresh, then commit the updated set + PROVENANCE.json.');
    return 3;
  }

  if (diff.inSync) {
    out(`already in sync with ${sourceDir}; rewriting ${PROVENANCE_FILE} marker`);
  } else {
    out(`refreshing vendored playbooks from ${sourceDir}:`);
    printDiff(out, diff);
    applyRefresh(sourceDir, VENDORED_DIR, diff);
  }

  const marker = writeProvenance(VENDORED_DIR, { source: sourceDir, sourceRef: args.sourceRef });
  out(`wrote ${PROVENANCE_FILE}: ${marker.playbookCount} playbooks, checksum ${String(marker.checksum).slice(0, 12)}`);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = main();
}

export { parseArgs, main };
