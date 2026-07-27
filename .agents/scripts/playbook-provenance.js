#!/usr/bin/env node

/**
 * playbook-provenance.js — the 015-06 freshness signal for the vendored
 * playbook set (ADR-0015 §Consequences: "gates now depend on playbook
 * freshness, so the manual `cp` sync becomes a real risk that needs a
 * supported path").
 *
 * Once the diagnose/mechanism-gate/fix-validator consumers (015-03/04/05)
 * depend on the playbook bodies + front matter, a silently-stale vendored set
 * enforces the wrong rules. This module makes staleness DETECTABLE, never
 * silent, via a committed provenance marker (`PROVENANCE.json`) that pins a
 * stable checksum over the playbook `.md` files. `playbook-sync.js` writes the
 * marker; `doctor.js` surfaces `checkFreshness` as a preflight row.
 *
 * Pure functions + a small marker writer. ESM only. Zero runtime deps.
 *
 * The checksum covers the ISSUE-TYPE playbooks only — the `.md` files EXCLUDING
 * `README.md` (provenance/docs) and `_FORMAT.md` (the schema doc). Those two
 * are human documentation, not gate inputs, so a docs edit does not spuriously
 * flag the enforced set as stale. Both the filename and the file bytes feed the
 * hash so a rename or content change is detected.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** The provenance marker filename, colocated with the playbooks it describes. */
export const PROVENANCE_FILE = 'PROVENANCE.json';

/** Docs `.md` files that are NOT part of the enforced playbook set. */
const NON_PLAYBOOK_MD = new Set(['README.md', '_FORMAT.md']);

/**
 * The sorted list of issue-type playbook filenames in `dir` (the enforced set:
 * every `.md` except the docs files). Sorted so the checksum is
 * order-independent.
 * @param {string} dir
 * @returns {string[]}
 */
export function playbookFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.md') && !NON_PLAYBOOK_MD.has(f))
    .sort();
}

/**
 * A stable SHA-256 over the enforced playbook set in `dir`. Each file
 * contributes its name plus a per-file content digest, concatenated in sorted
 * order — so the result is deterministic and order-independent, and any rename
 * or content edit changes it. Returns null when the directory is unreadable.
 * @param {string} dir
 * @returns {string|null}
 */
export function computeChecksum(dir) {
  const files = playbookFiles(dir);
  if (files.length === 0) return null;
  const hash = crypto.createHash('sha256');
  for (const name of files) {
    let text;
    try {
      // Normalize line endings so a CRLF checkout (Windows / git autocrlf) does
      // not compute a different checksum than an LF-recorded marker.
      text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
    } catch {
      return null;
    }
    const fileDigest = crypto.createHash('sha256').update(text).digest('hex');
    hash.update(`${name}\0${fileDigest}\n`);
  }
  return hash.digest('hex');
}

/**
 * Read + parse the provenance marker in `dir`. Returns `{ present: false }`
 * when the marker is missing or unparseable (never throws) — a missing marker
 * is a detectable state, not a silent success.
 * @param {string} dir
 * @returns {object} the parsed marker with `present: true`, or `{ present: false }`.
 */
export function readProvenance(dir) {
  const file = path.join(dir, PROVENANCE_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { present: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { present: false };
  }
  if (!parsed || typeof parsed !== 'object') return { present: false };
  return { present: true, ...parsed };
}

/**
 * Compare the recorded checksum against a fresh recompute over the current
 * playbook files. `stale` is true when the marker is missing OR the recorded
 * checksum no longer matches — so a stale/missing set is never silent.
 * @param {string} dir
 * @returns {{ present: boolean, stale: boolean, computedChecksum: string|null, recordedChecksum: string|null }}
 */
export function checkFreshness(dir) {
  const prov = readProvenance(dir);
  const computedChecksum = computeChecksum(dir);
  if (!prov.present) {
    return { present: false, stale: true, computedChecksum, recordedChecksum: null };
  }
  const recordedChecksum = typeof prov.checksum === 'string' ? prov.checksum : null;
  return {
    present: true,
    stale: recordedChecksum == null || recordedChecksum !== computedChecksum,
    computedChecksum,
    recordedChecksum,
  };
}

/**
 * Write (or rewrite) the provenance marker for the playbook set in `dir`,
 * recomputing the checksum + playbook count over the current files.
 *
 * @param {string} dir - the vendored playbooks directory.
 * @param {object} [meta]
 * @param {string} [meta.source] - the source of truth (repo/path).
 * @param {string} [meta.sourceRef] - a commit / snapshot ref of the source.
 * @param {string} [meta.syncedAt] - ISO timestamp (defaults to now).
 * @returns {object} the marker that was written.
 */
export function writeProvenance(dir, meta = {}) {
  const files = playbookFiles(dir);
  const marker = {
    source: meta.source || 'cwv-agent:.agents/references/playbooks (owned in-repo)',
    sourceRef: meta.sourceRef || null,
    syncedAt: meta.syncedAt || new Date().toISOString(),
    playbookCount: files.length,
    checksum: computeChecksum(dir),
  };
  fs.writeFileSync(
    path.join(dir, PROVENANCE_FILE),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
  return marker;
}

export default { readProvenance, checkFreshness, computeChecksum, writeProvenance };
