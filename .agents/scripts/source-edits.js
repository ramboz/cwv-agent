/**
 * source-edits.js — format the Finding-native `sourceEdits` records into a
 * clean unified diff for the SpaceCat suggestion `patchContent`.
 *
 * `fix-findings.json` carries the raw, tool-agnostic source-edit records
 * (`sourceEdits: [{ file, before, after, line? }]`, the load-bearing subset of
 * source-mapper.js's edit objects). The SpaceCat-specific unified diff is needed
 * ONLY at upload, so it is derived here at publish time — keeping the Finding
 * Finding-native (spec 003-04 publish-time-derivation decision, ADR-0006).
 *
 * This module is the minimal, pure formatter that proves the diff is derivable
 * from `sourceEdits`. The `cwv-publish` skill (spec 003-02) is the intended
 * caller; it will reconcile each edit against the real source file (line
 * numbers, surrounding context) before POSTing. This formatter deliberately
 * does NOT read the filesystem — it formats exactly what the records carry.
 *
 * Limitations (all reconciled by cwv-publish / spec 003-02 against the real
 * source — this formatter proves derivability, it does NOT emit the final
 * git-applicable diff):
 *   1. The line anchor is used verbatim from the record (`line`, or 1 when
 *      null); no surrounding context lines, so the `@@` header is best-effort.
 *   2. Per-edit sections are joined with a single newline — no blank-line
 *      separation — and multiple edits to the SAME file are NOT coalesced into
 *      one hunk-set.
 *   3. A pure insertion (empty `before`) or deletion (empty `after`) emits a
 *      malformed hunk — a spurious empty `-`/`+` line and a `,1` count —
 *      because `toLines('')` returns `['']` (see below).
 *
 * Zero runtime dependencies.
 *
 * Usage:
 *   import { editsToUnifiedDiff } from './source-edits.js';
 *   const patchContent = editsToUnifiedDiff(finding.sourceEdits);
 */

/**
 * Split a possibly-multiline string into lines (no trailing empty element for a
 * trailing newline). Returns [''] for the empty string so a pure insertion /
 * deletion still produces one diff line — note this yields a malformed hunk
 * (a spurious empty `-`/`+` line + a `,1` count); real insert/delete semantics
 * are reconciled by 003-02 against the source (header limitation #3).
 * @param {string} s
 * @returns {string[]}
 */
function toLines(s) {
  if (s === '' || s === undefined || s === null) return [''];
  return String(s).split(/\r?\n/);
}

/**
 * Format a single source-edit record as one unified-diff file section.
 * @param {{file:string, before:string, after:string, line?:number|null}} edit
 * @returns {string}
 */
function editToDiffSection(edit) {
  const file = edit.file;
  const beforeLines = toLines(edit.before);
  const afterLines = toLines(edit.after);
  // 1-indexed hunk start. Fall back to line 1 when the record has no line
  // anchor (e.g. the EDS block-decorator append case, where line is null).
  const start = typeof edit.line === 'number' && edit.line > 0 ? edit.line : 1;

  const out = [];
  out.push(`--- a/${file}`);
  out.push(`+++ b/${file}`);
  out.push(`@@ -${start},${beforeLines.length} +${start},${afterLines.length} @@`);
  for (const l of beforeLines) out.push(`-${l}`);
  for (const l of afterLines) out.push(`+${l}`);
  return out.join('\n');
}

/**
 * Build a clean unified diff (no prose) from a `sourceEdits` array. Sections are
 * joined with a single newline (no blank-line separation); edits to the same
 * file are emitted as separate sections in order, NOT coalesced — adequate for
 * the single-edit-per-finding common case (header limitations #2; 003-02
 * coalesces same-file hunks against the real source).
 *
 * @param {Array<{file:string, before:string, after:string, line?:number|null}>} sourceEdits
 * @returns {string} a unified diff suitable for SpaceCat `patchContent`
 */
function editsToUnifiedDiff(sourceEdits) {
  if (!Array.isArray(sourceEdits) || sourceEdits.length === 0) return '';
  return sourceEdits.map(editToDiffSection).join('\n');
}

export { editsToUnifiedDiff };
