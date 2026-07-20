#!/usr/bin/env node

/**
 * playbook-see-also-lint.js — validates the typed `see_also` cross-reference
 * graph across the CWV playbooks (spec 015-01, ADR-0015).
 *
 * Each playbook may carry an OPTIONAL `see_also` front-matter list; every
 * entry has `playbook` (target issue_type / filename without .md), `edge`
 * (one of the four allowed types), and `reason`. This lint checks:
 *
 *   - target existence : every see_also.playbook names an existing playbook
 *   - edge validity    : every edge is one of the four allowed types
 *
 * Cycles in the see_also graph are PERMITTED (the 015-02 resolver is cycle-safe
 * via a visited-set per ADR-0015 §3), so they are DETECTED and reported as
 * warnings but are NOT fatal — only a missing target or an unknown edge value
 * fails the lint.
 *
 * `lintSeeAlso(dir)` returns `{ ok: boolean, errors: string[], warnings: string[] }`.
 * Run as a CLI it lints the real playbook dir, prints any detected cycles to
 * stderr as warnings, and exits non-zero only on a hard error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The four typed cross-reference edges defined by ADR-0015 §2. */
export const ALLOWED_EDGES = ['routes_to', 'prefer_instead', 'complements', 'orthogonal'];

/**
 * Extract the `---`-fenced YAML front-matter block from a markdown source.
 * Returns the raw front-matter text, or '' when none is present.
 */
export function extractFrontMatter(source) {
  const text = source.charCodeAt(0) === 0xFEFF ? source.slice(1) : source;
  if (!text.startsWith('---')) return '';
  // Match the opening fence and the next closing fence on its own line.
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return match ? match[1] : '';
}

/**
 * Minimal parser for a `see_also:` list inside the front-matter. Handles the
 * subset of YAML the schema uses — a block sequence of maps, e.g.:
 *
 *   see_also:
 *     - playbook: font-fallback
 *       edge: prefer_instead
 *       reason: "superseded by the fallback playbook"
 *
 * Returns an array of `{ playbook, edge, reason }` (missing keys → undefined).
 * Non-see_also front-matter lines are ignored.
 */
export function parseSeeAlso(frontMatter) {
  const lines = frontMatter.split(/\r?\n/);
  const entries = [];
  let inSeeAlso = false;
  let seeAlsoIndent = 0;
  let current = null;

  // Drop a trailing inline `#` comment, but only when the `#` is OUTSIDE any
  // quoted string (so `reason: "text # still text"` keeps its hash).
  const stripInlineComment = (v) => {
    let quote = null;
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '#' && (i === 0 || /\s/.test(v[i - 1]))) {
        return v.slice(0, i);
      }
    }
    return v;
  };

  const stripQuotes = (v) => {
    const t = stripInlineComment(v).trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };

  for (const rawLine of lines) {
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    if (!inSeeAlso) {
      // Top-level key `see_also:` (with nothing after the colon).
      if (/^see_also\s*:\s*$/.test(line) && indent === 0) {
        inSeeAlso = true;
        seeAlsoIndent = indent;
        current = null;
      }
      continue;
    }

    // We are inside the see_also block. A new top-level key at the same or
    // lower indent than `see_also:` ends the block.
    if (indent <= seeAlsoIndent && /^[A-Za-z_][\w-]*\s*:/.test(line) && !line.startsWith('-')) {
      break;
    }

    if (line.startsWith('- ')) {
      // Start of a new list item; the rest of the line may hold the first key.
      current = {};
      entries.push(current);
      const rest = line.slice(2).trim();
      const kv = rest.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (kv) current[kv[1]] = stripQuotes(kv[2]);
    } else if (line === '-') {
      current = {};
      entries.push(current);
    } else if (current) {
      const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (kv) current[kv[1]] = stripQuotes(kv[2]);
    }
  }

  return entries;
}

/**
 * Detect all cycles in a directed graph expressed as `Map<node, string[]>`.
 * Returns an array of cycle paths (each a `string[]` of node names forming
 * the loop, first node repeated at the end for readability).
 */
function findCycles(graph) {
  const cycles = [];
  const seen = new Set();
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const stack = [];

  for (const node of graph.keys()) color.set(node, WHITE);

  const visit = (node) => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      if (!graph.has(next)) continue; // dangling target — handled elsewhere
      if (color.get(next) === GRAY) {
        // Back edge → cycle from `next` down the current stack to `node`.
        const start = stack.indexOf(next);
        const loop = stack.slice(start).concat(next);
        const key = [...loop].sort().join('|') + '::' + loop.length;
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(loop);
        }
      } else if (color.get(next) === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) visit(node);
  }

  return cycles;
}

/**
 * Lint the `see_also` graph across all `*.md` playbooks in `dir`.
 * `_FORMAT.md` and `README.md` are metadata, not playbooks — skipped.
 *
 * @param {string} dir - the playbook directory.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function lintSeeAlso(dir) {
  const errors = [];
  const warnings = [];

  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    return {
      ok: false,
      errors: [`cannot read playbook dir ${dir}: ${err.message}`],
      warnings: [],
    };
  }

  const playbookFiles = files
    .filter((f) => f.endsWith('.md') && f !== '_FORMAT.md' && f !== 'README.md')
    .sort();

  const known = new Set(playbookFiles.map((f) => f.replace(/\.md$/, '')));
  const graph = new Map();

  for (const file of playbookFiles) {
    const name = file.replace(/\.md$/, '');
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const fm = extractFrontMatter(source);
    const entries = parseSeeAlso(fm);
    const targets = [];

    entries.forEach((entry, i) => {
      const where = `${file} see_also[${i}]`;
      if (!entry.playbook) {
        errors.push(`${where}: missing 'playbook' field`);
      } else if (!known.has(entry.playbook)) {
        errors.push(`${where}: target playbook '${entry.playbook}' does not exist (no ${entry.playbook}.md)`);
      } else {
        targets.push(entry.playbook);
      }

      if (!entry.edge) {
        errors.push(`${where}: missing 'edge' field`);
      } else if (!ALLOWED_EDGES.includes(entry.edge)) {
        errors.push(
          `${where}: unknown edge '${entry.edge}' (allowed: ${ALLOWED_EDGES.join(', ')})`,
        );
      }
    });

    graph.set(name, targets);
  }

  // Cycles are PERMITTED (the resolver is cycle-safe) — report, don't fail.
  const cycles = findCycles(graph);
  for (const cycle of cycles) {
    warnings.push(`see_also graph has a cycle: ${cycle.join(' -> ')}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

// CLI entry — lint the real playbook dir; exit non-zero on failure.
function isMain() {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return invoked === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(here, '../references/playbooks');
  const { ok, errors, warnings } = lintSeeAlso(dir);
  for (const w of warnings) process.stderr.write(`  warning: ${w}\n`);
  if (ok) {
    process.stdout.write(`playbook see_also lint: OK (${dir})\n`);
    process.exit(0);
  } else {
    process.stderr.write(`playbook see_also lint: FAIL (${dir})\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
}
