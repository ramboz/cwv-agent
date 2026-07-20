#!/usr/bin/env node

/**
 * forbidden-technique-validator.js — the fix-step post-validator (spec 015-05,
 * ADR-0015 §3 "Fix — forbidden-technique validator").
 *
 * Runs a playbook's `forbidden_techniques` regexes against the ADDED (`+`) lines
 * of a candidate fix diff and rejects the diff on a match, surfacing the
 * playbook `reason` verbatim so the fix agent can re-prompt. This is the
 * deterministic guard against the project's recurring failure mode: reintroducing
 * a documented anti-pattern (`min-height: 0`, `font-display: block`, HTTP
 * `Link:` preload, ...).
 *
 * Edge scoping (ADR-0015 crux — guards false rejections): rules are unioned from
 * the resolved issue_type's playbook PLUS playbooks reached over `complements`
 * edges ONLY. `prefer_instead` and `orthogonal` edges contribute NO rules — a
 * redirected/orthogonal playbook's forbidden techniques are irrelevant to THIS
 * fix and unioning them would false-reject valid fixes. We therefore do our own
 * complements-only closure rather than reusing resolveChain's all-edges closure
 * (whose per-node edge tags are UNIONED across every reaching path, so a node
 * reached by both `complements` and `orthogonal` cannot be distinguished there).
 *
 * Risk-tier gate (ADR-0015 §4, ADR-0008): `risk_tier: high` emits NO code change
 * — it routes to a guidance-mode finding; `medium`/`low` allow a code change
 * (medium after the validation loop, low auto-fixable).
 *
 * Regex portability (AC-1): `forbidden_techniques` patterns are authored in
 * Python `re` syntax. Most constructs are identical in the JS engine and pass
 * through untouched. Python-only constructs (named groups, inline scoped flags,
 * possessive quantifiers, atomic groups, `\A`/`\Z`/`\z`) are DETECTED and
 * EXCLUDED with an explicit reason rather than silently mistranslated.
 *
 * Backtracking safety (AC-7): every added line is capped to MAX_SCAN_LEN chars
 * before a regex is run against it. Playbook patterns are required to be
 * backtracking-safe (_FORMAT.md), so a bounded input length bounds the work —
 * a pathological line cannot hang the validator.
 *
 * Reuse, not duplication:
 *   - single-playbook loading + flavor resolution: attribution.js
 *     (`loadPlaybook`, `resolveFlavor`) — the same front-matter parser that
 *     surfaces `forbiddenTechniques` + `flavorOverrides`;
 *   - typed see_also edge parsing: playbook-see-also-lint.js
 *     (`extractFrontMatter`, `parseSeeAlso`).
 *
 * Pure functions + a thin CLI (import.meta guard). ESM only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlaybook, resolveFlavor } from './attribution.js';
import { extractFrontMatter, parseSeeAlso } from './playbook-see-also-lint.js';

/**
 * Maximum number of characters of any single added line that a regex is run
 * against. Playbook patterns are required backtracking-safe (_FORMAT.md); a
 * bounded input length bounds the matcher's work so a pathological line cannot
 * hang the validator (AC-7). 4000 comfortably exceeds any realistic source line.
 */
export const MAX_SCAN_LEN = 4000;

// ---------------------------------------------------------------------------
// AC-1 — Python `re` → JS RegExp translation (detect-and-exclude, never
// silently mistranslate).
// ---------------------------------------------------------------------------

/**
 * Python-only constructs the JS engine cannot run equivalently. Each is matched
 * on the RAW pattern text; a hit means the pattern is EXCLUDED (not translated)
 * with the paired reason. NOTE: the scan is a plain raw-text match — it is NOT
 * character-class / escaped-literal aware, so a construct appearing inside a
 * char class or as an escaped literal could false-exclude. This is safe for the
 * current trusted playbook pattern set (verified: no such case); tighten to a
 * class-aware scan if playbook patterns ever grow that complex.
 */
const PYTHON_ONLY = [
  { test: /\(\?P</, reason: 'Python named group (?P<name>…) — not portable to the JS RegExp engine' },
  { test: /\(\?P=/, reason: 'Python named backreference (?P=name) — not portable' },
  { test: /\(\?>/, reason: 'atomic group (?>…) — unsupported by the JS RegExp engine' },
  { test: /\\A/, reason: 'Python \\A anchor — use ^ (JS has no \\A)' },
  { test: /\\Z/, reason: 'Python \\Z anchor — use $ (JS has no \\Z)' },
  { test: /\\z/, reason: 'Python \\z anchor — unsupported in JS' },
];

/**
 * Scan for an inline scoped flag group `(?i)`, `(?s)`, `(?m)`, `(?x)`, `(?a)`,
 * `(?L)`, `(?u)` OR the scoped form `(?i:...)`. JS only accepts flags on the
 * RegExp object, not mid-pattern, so these are excluded. A leading whole-pattern
 * `(?i)`/`(?s)`/`(?m)` is technically hoistable to a RegExp flag, but hoisting
 * changes match semantics subtly (e.g. `(?s)` dotAll) and the DoR forbids silent
 * mistranslation, so we exclude and log rather than guess.
 */
const INLINE_FLAGS = /\(\?[aiLmsux]+[):]/;

/**
 * Possessive quantifiers (`*+`, `++`, `?+`, `{m,n}+`). These are a Python 3.11+
 * / regex-module construct absent from the JS engine; excluded. We look for a
 * quantifier immediately followed by `+` that is not itself part of `{...}`.
 */
const POSSESSIVE = /(?:[*+?]|\})\+/;

/**
 * Translate a Python `re` pattern to a JS RegExp source string.
 *
 * The common `forbidden_techniques` vocabulary — `\s`, `\b`, `\d`, `\w`,
 * character classes, `(?:...)` non-capturing groups, `(?!...)`/`(?=...)`
 * look-ahead, quantifiers, anchors — is identical between the two engines and
 * passes through unchanged. Python-only constructs are DETECTED and returned as
 * `{ ok: false, reason }` (never silently mistranslated). The translated source
 * is compiled with `new RegExp(...)`; a compile error is likewise reported as an
 * exclusion, so this function never throws for a caller.
 *
 * @param {string} pyPattern
 * @returns {{ ok: boolean, source: string|null, reason: string|null }}
 */
export function translatePattern(pyPattern) {
  if (typeof pyPattern !== 'string' || pyPattern === '') {
    return { ok: false, source: null, reason: 'empty or non-string pattern' };
  }

  for (const { test, reason } of PYTHON_ONLY) {
    if (test.test(pyPattern)) return { ok: false, source: null, reason };
  }
  if (INLINE_FLAGS.test(pyPattern)) {
    return { ok: false, source: null, reason: 'inline scoped flags (?i)/(?s)/(?m)/(?i:…) — JS accepts flags only on the RegExp, not mid-pattern' };
  }
  if (POSSESSIVE.test(pyPattern)) {
    return { ok: false, source: null, reason: 'possessive quantifier (*+/++/?+) — unsupported by the JS RegExp engine' };
  }

  // No portability blocker detected — the source is used verbatim. Validate it
  // compiles; if the JS engine rejects it, exclude with the engine's message.
  try {
     
    new RegExp(pyPattern);
  } catch (err) {
    return { ok: false, source: null, reason: `does not compile as a JS RegExp: ${err.message}` };
  }
  return { ok: true, source: pyPattern, reason: null };
}

// ---------------------------------------------------------------------------
// Front-matter access — forbidden_techniques (+ flavor_overrides extras) and
// see_also edges, via the shared parsers.
// ---------------------------------------------------------------------------

/** The playbook's `applicable_flavors` (normalized to an array). */
function applicableFlavors(pb) {
  const fl = pb && pb.frontmatter && pb.frontmatter.applicableFlavors;
  return Array.isArray(fl) ? fl : [];
}

/**
 * Read a playbook's raw forbidden_technique entries for the resolved flavor:
 * the universal `forbidden_techniques` list PLUS
 * `flavor_overrides.<flavor>.extra_forbidden_techniques`. Each entry keeps its
 * `pattern`, `reason`, and `on_flavors` (default = the playbook's
 * applicable_flavors). Entries not applicable to `flavor` are dropped here (AC-4).
 *
 * @param {object} pb - loadPlaybook result
 * @param {string|null} flavor - resolved flavor (eds|cs|ams|headless) or null
 * @returns {{pattern: string, reason: string, playbook: string}[]}
 */
function playbookRules(pb, flavor) {
  if (!pb || !pb.frontmatter) return [];
  const fm = pb.frontmatter;
  const defaultFlavors = applicableFlavors(pb);
  const out = [];

  const admit = (entry) => {
    if (!entry || typeof entry.pattern !== 'string') return;
    // A rule's on_flavors (default = the playbook's applicable_flavors). When a
    // flavor is resolved, drop a rule not applicable to it (AC-4). With no
    // resolved flavor we cannot scope, so every rule is admitted.
    const rawOn = entry.on_flavors;
    const on = Array.isArray(rawOn) ? rawOn : (rawOn == null ? defaultFlavors : [rawOn]);
    if (flavor && Array.isArray(on) && on.length > 0 && !on.includes(flavor)) return;
    out.push({ pattern: entry.pattern, reason: entry.reason || '', playbook: pb.issueType });
  };

  for (const entry of Array.isArray(fm.forbiddenTechniques) ? fm.forbiddenTechniques : []) admit(entry);

  // flavor_overrides.<flavor>.extra_forbidden_techniques — extras layered on for
  // the resolved flavor only.
  if (flavor && fm.flavorOverrides && typeof fm.flavorOverrides === 'object') {
    const ov = fm.flavorOverrides[flavor];
    const extras = ov && ov.extra_forbidden_techniques;
    for (const entry of Array.isArray(extras) ? extras : []) {
      // extra_forbidden_techniques are per-flavor by construction; admit
      // regardless of a (redundant) on_flavors, still respecting an explicit one.
      admit(entry);
    }
  }

  return out;
}

/** Outgoing `complements`-typed see_also targets of a playbook. */
function complementsTargets(pb) {
  if (!pb || !pb.file) return [];
  let fm = '';
  try { fm = extractFrontMatter(fs.readFileSync(pb.file, 'utf8')); } catch { return []; }
  return parseSeeAlso(fm)
    .filter((e) => e && e.playbook && e.edge === 'complements')
    .map((e) => e.playbook);
}

/**
 * The complements-only closure of playbooks whose rules apply to THIS fix: the
 * resolved issue_type plus every playbook reachable over `complements` edges
 * (transitively — a complement's complement still complements the fix path).
 * `prefer_instead` and `orthogonal` edges are never followed (ADR-0015 crux).
 * Cycle-safe via a visited-set. A playbook not applicable to the resolved flavor
 * is excluded and not expanded through.
 *
 * We deliberately do NOT reuse resolveChain's closure: it unions ALL edge types
 * and its per-node `edges` tag is the union across every reaching path, so a
 * node reached by both `complements` and `orthogonal` is indistinguishable — it
 * cannot express "reached ONLY via complements".
 *
 * @param {string} issueType - root issue_type
 * @param {string|null} flavor - resolved flavor
 * @param {object} loadOpts - { dir } passed to loadPlaybook
 * @returns {object[]} loaded playbooks in traversal order (root first)
 */
function complementsClosure(issueType, flavor, loadOpts) {
  const root = loadPlaybook(issueType, loadOpts);
  if (!root) return [];
  const flavors = applicableFlavors(root);
  if (flavor && flavors.length > 0 && !flavors.includes(flavor)) return [];

  const visited = new Set([issueType]);
  const order = [root];
  const queue = [root];
  while (queue.length) {
    const pb = queue.shift();
    for (const target of complementsTargets(pb)) {
      if (visited.has(target)) continue;
      visited.add(target);
      const child = loadPlaybook(target, loadOpts);
      if (!child) continue;
      const cf = applicableFlavors(child);
      if (flavor && cf.length > 0 && !cf.includes(flavor)) continue;
      order.push(child);
      queue.push(child);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect the forbidden-technique rules that apply to a fix on `issueType` /
 * `flavor`: the issue_type's playbook plus its complements-only closure (AC-3),
 * scoped to the resolved flavor (AC-4). Each rule is translated (AC-1) — a
 * translatable rule carries `jsSource`; an untranslatable one carries `excluded`
 * (the reason) and no `jsSource`.
 *
 * @param {string} issueType
 * @param {string|null} flavor - a bare flavor or any label resolveFlavor accepts
 * @param {object} [opts]
 * @param {string} [opts.dir] - override the playbooks directory
 * @param {string} [opts.source] - a pulled source tree, for flavor resolution
 * @returns {{pattern: string, reason: string, playbook: string, jsSource?: string, excluded?: string}[]}
 */
export function collectForbiddenRules(issueType, flavor, opts = {}) {
  const loadOpts = opts.dir ? { dir: opts.dir } : undefined;
  const resolvedFlavor = resolveFlavor({ flavor, source: opts.source });
  const playbooks = complementsClosure(issueType, resolvedFlavor, loadOpts);

  const rules = [];
  for (const pb of playbooks) {
    for (const raw of playbookRules(pb, resolvedFlavor)) {
      const t = translatePattern(raw.pattern);
      if (t.ok) rules.push({ ...raw, jsSource: t.source });
      else rules.push({ ...raw, excluded: t.reason });
    }
  }
  return rules;
}

/**
 * Extract the ADDED lines of a unified diff — lines beginning with a single `+`
 * but NOT the `+++ ` file header. The leading `+` is stripped from the returned
 * text (the added content itself is scanned, not the diff marker).
 *
 * @param {string} diffText
 * @returns {string[]}
 */
export function addedLines(diffText) {
  if (typeof diffText !== 'string' || diffText === '') return [];
  const out = [];
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++')) continue; // file header — not an addition
    if (line.startsWith('+')) out.push(line.slice(1));
  }
  return out;
}

/**
 * Validate a candidate fix diff against the forbidden techniques scoped to the
 * fix's issue_type + complements closure + flavor. Each translatable rule's JS
 * regex is tested against every added line (capped to MAX_SCAN_LEN — AC-7);
 * every match is a violation carrying the playbook `reason` verbatim (AC-5).
 *
 * Untranslatable rules are skipped for matching (they were excluded upstream and
 * logged); they cannot silently pass or fail a diff.
 *
 * @param {string} diffText - a unified diff
 * @param {string} issueType
 * @param {string|null} flavor
 * @param {object} [opts] - see collectForbiddenRules
 * @returns {{ ok: boolean, violations: {pattern: string, reason: string, playbook: string, line: string}[], excludedRules: object[] }}
 */
export function validateFixDiff(diffText, issueType, flavor, opts = {}) {
  const rules = collectForbiddenRules(issueType, flavor, opts);
  const lines = addedLines(diffText);
  const violations = [];
  const excludedRules = [];

  for (const rule of rules) {
    if (rule.excluded) { excludedRules.push(rule); continue; }
    let re;
    try {
      re = new RegExp(rule.jsSource);
    } catch (err) {
      // Should not happen (translatePattern already compiled it), but never let
      // a bad pattern throw out of the validator.
      excludedRules.push({ ...rule, excluded: `compile failed at match time: ${err.message}` });
      continue;
    }
    for (const raw of lines) {
      const line = raw.length > MAX_SCAN_LEN ? raw.slice(0, MAX_SCAN_LEN) : raw;
      re.lastIndex = 0;
      if (re.test(line)) {
        violations.push({ pattern: rule.pattern, reason: rule.reason, playbook: rule.playbook, line: raw });
      }
    }
  }

  return { ok: violations.length === 0, violations, excludedRules };
}

/**
 * The risk-tier policy for a fix on `issueType` / `flavor` (ADR-0015 §4,
 * ADR-0008). `high` → no code change may be emitted (route to guidance-mode);
 * `medium`/`low` → a code change is allowed (medium after the validation loop).
 *
 * @param {string} issueType
 * @param {string|null} flavor
 * @param {object} [opts] - see collectForbiddenRules
 * @returns {{ tier: string|null, allowsCodeChange: boolean }}
 */
export function riskTierPolicy(issueType, flavor, opts = {}) {
  const loadOpts = opts.dir ? { dir: opts.dir } : undefined;
  const pb = loadPlaybook(issueType, loadOpts);
  const tier = (pb && pb.frontmatter && pb.frontmatter.riskTier) || null;
  return { tier, allowsCodeChange: tier !== 'high' };
}

// ---------------------------------------------------------------------------
// CLI — validate a diff file, or audit pattern translatability.
// ---------------------------------------------------------------------------

function isMain() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function auditAllPatterns(dir) {
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== '_FORMAT.md' && f !== 'README.md')
    .sort();
  let translated = 0;
  const excluded = [];
  for (const f of files) {
    const it = f.replace(/\.md$/, '');
    const pb = loadPlaybook(it, { dir });
    const fm = pb && pb.frontmatter;
    if (!fm) continue;
    const entries = [];
    for (const e of Array.isArray(fm.forbiddenTechniques) ? fm.forbiddenTechniques : []) entries.push(e);
    const ov = fm.flavorOverrides || {};
    for (const fl of Object.keys(ov)) {
      const ex = ov[fl] && ov[fl].extra_forbidden_techniques;
      for (const e of Array.isArray(ex) ? ex : []) entries.push(e);
    }
    for (const e of entries) {
      const t = translatePattern(e && e.pattern);
      if (t.ok) translated += 1;
      else excluded.push({ playbook: it, pattern: e && e.pattern, reason: t.reason });
    }
  }
  return { translated, excluded };
}

if (isMain()) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const defaultDir = process.env.CWV_PLAYBOOKS_DIR || path.resolve(here, '../references/playbooks');
  const args = process.argv.slice(2);

  if (args[0] === '--audit') {
    const dir = args[1] ? path.resolve(args[1]) : defaultDir;
    const { translated, excluded } = auditAllPatterns(dir);
    process.stdout.write(`forbidden_techniques translatability audit (${dir}):\n`);
    process.stdout.write(`  translated: ${translated}\n  excluded:   ${excluded.length}\n`);
    for (const e of excluded) process.stdout.write(`  - ${e.playbook}: ${JSON.stringify(e.pattern)} — ${e.reason}\n`);
    process.exit(0);
  }

  // node forbidden-technique-validator.js <diff.patch> <issueType> [--flavor f] [--dir d]
  const positional = [];
  let flavor = null;
  let dir = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--flavor') flavor = args[++i];
    else if (args[i] === '--dir') dir = args[++i];
    else positional.push(args[i]);
  }
  const [diffPath, issueType] = positional;
  if (!diffPath || !issueType) {
    process.stderr.write('Usage: forbidden-technique-validator.js <diff.patch> <issueType> [--flavor f] [--dir d]\n');
    process.stderr.write('       forbidden-technique-validator.js --audit [playbooks-dir]\n');
    process.exit(64);
  }
  const diffText = fs.readFileSync(path.resolve(process.cwd(), diffPath), 'utf8');
  const opts = dir ? { dir: path.resolve(dir) } : {};
  const policy = riskTierPolicy(issueType, flavor, opts);
  if (!policy.allowsCodeChange) {
    process.stdout.write(`risk_tier=${policy.tier}: no code change permitted — route to guidance-mode (ADR-0008).\n`);
    process.exit(2);
  }
  const { ok, violations } = validateFixDiff(diffText, issueType, flavor, opts);
  if (ok) {
    process.stdout.write(`OK — no forbidden techniques (issue_type=${issueType}, risk_tier=${policy.tier}).\n`);
    process.exit(0);
  }
  process.stderr.write(`REJECTED — ${violations.length} forbidden technique(s):\n`);
  for (const v of violations) process.stderr.write(`  - [${v.playbook}] ${v.reason}\n      matched: ${v.line.trim()}\n`);
  process.exit(1);
}
