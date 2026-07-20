import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  translatePattern,
  collectForbiddenRules,
  validateFixDiff,
  riskTierPolicy,
  addedLines,
  MAX_SCAN_LEN,
} from '../forbidden-technique-validator.js';
import { loadPlaybook } from '../attribution.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYBOOKS_DIR = path.resolve(here, '../../references/playbooks');

/** Enumerate every real playbook issue_type. */
function playbookIssueTypes() {
  return fs.readdirSync(PLAYBOOKS_DIR)
    .filter((f) => f.endsWith('.md') && f !== '_FORMAT.md' && f !== 'README.md')
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

/** Every raw forbidden_technique pattern (universal + flavor_override extras). */
function allRealPatterns() {
  const out = [];
  for (const it of playbookIssueTypes()) {
    const fm = loadPlaybook(it, { dir: PLAYBOOKS_DIR }).frontmatter;
    if (!fm) continue;
    for (const e of Array.isArray(fm.forbiddenTechniques) ? fm.forbiddenTechniques : []) {
      if (e && typeof e.pattern === 'string') out.push({ playbook: it, pattern: e.pattern });
    }
    const ov = fm.flavorOverrides || {};
    for (const fl of Object.keys(ov)) {
      const ex = ov[fl] && ov[fl].extra_forbidden_techniques;
      for (const e of Array.isArray(ex) ? ex : []) {
        if (e && typeof e.pattern === 'string') out.push({ playbook: it, pattern: e.pattern });
      }
    }
  }
  return out;
}

// --- AC-1: every real pattern is translatable-or-excluded, never throws; ----
//          every ok:true source compiles.
test('AC-1: every forbidden_techniques pattern translates or is excluded with a reason (never throws)', () => {
  const patterns = allRealPatterns();
  assert.ok(patterns.length >= 30, `expected the real playbook set (~32 patterns), got ${patterns.length}`);

  let translated = 0;
  const excluded = [];
  for (const { playbook, pattern } of patterns) {
    let res;
    assert.doesNotThrow(() => { res = translatePattern(pattern); }, `translatePattern threw for ${playbook}: ${pattern}`);
    assert.equal(typeof res.ok, 'boolean');
    if (res.ok) {
      assert.equal(typeof res.source, 'string');
      assert.equal(res.reason, null);
      // ok:true source must compile as a JS RegExp.
      assert.doesNotThrow(() => new RegExp(res.source), `ok:true source did not compile: ${res.source}`);
      translated += 1;
    } else {
      assert.equal(res.source, null);
      assert.equal(typeof res.reason, 'string');
      assert.ok(res.reason.length > 0);
      excluded.push({ playbook, pattern, reason: res.reason });
    }
  }
  // Surface the count (visible with node --test reporter's diagnostics).
  console.log(`AC-1: translated=${translated} excluded=${excluded.length}`);
  for (const e of excluded) console.log(`  EXCLUDED [${e.playbook}] ${JSON.stringify(e.pattern)} — ${e.reason}`);
});

// --- AC-2: diff scanning — only ADDED lines, not context/removed/+++ header. -
test('AC-2: font-display: block on a + line is a violation; on -/context/+++ it is not', () => {
  const flavor = 'eds';
  const it = 'font-fallback'; // its forbidden_techniques include font-display:\s*block\b

  const addedDiff = [
    '--- a/styles.css',
    '+++ b/styles.css',
    '@@ -1,2 +1,3 @@',
    ' body { color: black; }',
    '+.hero { font-display: block; }',
  ].join('\n');
  const added = validateFixDiff(addedDiff, it, flavor, { dir: PLAYBOOKS_DIR });
  assert.equal(added.ok, false);
  assert.ok(added.violations.some((v) => /font-display/.test(v.pattern)));

  // Same text on a removed line + a context line + the +++ header → no violation.
  const cleanDiff = [
    '--- a/styles.css',
    '+++ b/font-display: block.css', // pathological +++ path — must be ignored
    '@@ -1,3 +1,2 @@',
    '-.hero { font-display: block; }',
    ' .other { font-display: block; }',
    '+.hero { font-display: swap; }',
  ].join('\n');
  const clean = validateFixDiff(cleanDiff, it, flavor, { dir: PLAYBOOKS_DIR });
  assert.equal(clean.ok, true, `expected no violation, got ${JSON.stringify(clean.violations)}`);
});

// --- addedLines unit: +++ header excluded, leading + stripped. ---------------
test('addedLines: strips leading +, excludes the +++ header', () => {
  const diff = '+++ b/x.css\n+added one\n-removed\n context\n+added two';
  assert.deepEqual(addedLines(diff), ['added one', 'added two']);
});

// --- AC-3: edge scoping — complements fires, prefer_instead/orthogonal doesn't
test('AC-3: a complements-reached rule fires; a prefer_instead/orthogonal-reached rule does not', () => {
  const flavor = 'eds';
  const root = 'font-fallback';
  // Real graph: font-fallback --orthogonal--> font-format ; --complements--> font-preload.
  const rules = collectForbiddenRules(root, flavor, { dir: PLAYBOOKS_DIR });
  const playbooks = new Set(rules.map((r) => r.playbook));

  assert.ok(playbooks.has('font-fallback'), 'root playbook rules must be present');
  assert.ok(playbooks.has('font-preload'), 'complements-reached playbook rules must be present');
  assert.ok(!playbooks.has('font-format'), 'orthogonal-reached playbook rules must NOT be present');

  // font-format only reachable via orthogonal — its @font-face ttf pattern must NOT fire.
  const fontFormatDiff = [
    '+++ b/fonts.css',
    '+@font-face { src: url(/a.ttf) format("truetype"); }',
  ].join('\n');
  const ff = validateFixDiff(fontFormatDiff, root, flavor, { dir: PLAYBOOKS_DIR });
  assert.equal(ff.ok, true, `orthogonal-reached rule must not fire: ${JSON.stringify(ff.violations)}`);

  // font-preload reached via complements — its crossorigin-less preload pattern must fire.
  const preloadDiff = [
    '+++ b/head.html',
    '+<link rel="preload" as="font" href="/x.woff2">',
  ].join('\n');
  const pl = validateFixDiff(preloadDiff, root, flavor, { dir: PLAYBOOKS_DIR });
  assert.equal(pl.ok, false, 'complements-reached rule must fire');
  assert.ok(pl.violations.some((v) => v.playbook === 'font-preload'));
});

// --- AC-4: on_flavors scoping — a rule scoped to [eds] does not fire for cs. -
test('AC-4: an on_flavors:[eds] rule does not fire for flavor cs', () => {
  // lcp-image has: pattern rel="preload" as="image" with on_flavors: [eds].
  const diff = '+++ b/head.html\n+<link rel="preload" as="image" href="/hero.jpg">';

  const eds = validateFixDiff(diff, 'lcp-image', 'eds', { dir: PLAYBOOKS_DIR });
  assert.ok(eds.violations.some((v) => v.playbook === 'lcp-image' && /preload/.test(v.pattern)),
    'the [eds]-scoped preload-image rule must fire for eds');

  const cs = validateFixDiff(diff, 'lcp-image', 'cs', { dir: PLAYBOOKS_DIR });
  assert.ok(!cs.violations.some((v) => /as\\s\*=\\s\*"image"/.test(v.pattern) && v.playbook === 'lcp-image'),
    'the [eds]-scoped preload-image rule must NOT fire for cs');
  // The other lcp-image rules (loading=lazy) are universal, so cs may still have
  // violations from those — but not from the eds-only preload-image rule.
  const edsOnlyRule = collectForbiddenRules('lcp-image', 'cs', { dir: PLAYBOOKS_DIR })
    .filter((r) => /as\\s\*=\\s\*"image"/.test(r.pattern));
  assert.equal(edsOnlyRule.length, 0, 'the eds-only preload-image rule must be dropped from the cs rule set');
});

// --- AC-5: on match, ok:false and the violation carries the reason verbatim. -
test('AC-5: a violation carries the playbook reason verbatim', () => {
  const flavor = 'eds';
  const it = 'layout-shift'; // has min-height:\s*0 with a specific reason
  const fm = loadPlaybook(it, { dir: PLAYBOOKS_DIR }).frontmatter;
  const minHeightRule = fm.forbiddenTechniques.find((e) => /min-height/.test(e.pattern));
  assert.ok(minHeightRule, 'layout-shift should have a min-height rule');

  const diff = '+++ b/block.css\n+.banner { min-height: 0 !important; }';
  const res = validateFixDiff(diff, it, flavor, { dir: PLAYBOOKS_DIR });
  assert.equal(res.ok, false);
  const v = res.violations.find((x) => /min-height/.test(x.pattern));
  assert.ok(v, 'min-height violation expected');
  assert.equal(v.reason, minHeightRule.reason, 'reason must be surfaced verbatim');
});

// --- AC-6: risk-tier gate. high -> no code change; medium/low -> allowed. ----
test('AC-6: riskTierPolicy — high blocks a code change; medium/low allow it', () => {
  // Real tiers: high = interaction, js-execution, ttfb (+ 1). medium/low allow.
  const high = riskTierPolicy('interaction', 'eds', { dir: PLAYBOOKS_DIR });
  assert.equal(high.tier, 'high');
  assert.equal(high.allowsCodeChange, false);

  const medium = riskTierPolicy('layout-shift', 'eds', { dir: PLAYBOOKS_DIR });
  assert.equal(medium.tier, 'medium');
  assert.equal(medium.allowsCodeChange, true);

  const low = riskTierPolicy('font-fallback', 'eds', { dir: PLAYBOOKS_DIR });
  assert.equal(low.tier, 'low');
  assert.equal(low.allowsCodeChange, true);

  // Sanity: exactly the documented count of high-tier playbooks (4).
  const highs = playbookIssueTypes().filter((it) => riskTierPolicy(it, null, { dir: PLAYBOOKS_DIR }).tier === 'high');
  assert.equal(highs.length, 4, `expected 4 high-tier playbooks, got ${highs.length}: ${highs}`);
});

// --- AC-7: backtracking safety — a pathological long line completes bounded. -
test('AC-7: a pathological long added line completes within a bound (no hang)', () => {
  // A very long line + a pattern present in the rule set. The MAX_SCAN_LEN cap
  // bounds the matcher's work regardless of line length.
  const long = 'a'.repeat(200000);
  const diff = `+++ b/x.css\n+${long}\n+.banner { min-height: 0; }`;
  const start = Date.now();
  const res = validateFixDiff(diff, 'layout-shift', 'eds', { dir: PLAYBOOKS_DIR });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `validator took ${elapsed}ms — expected < 2000ms`);
  // The real min-height addition is still caught despite the pathological line.
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => /min-height/.test(v.pattern)));
  assert.ok(MAX_SCAN_LEN <= 4000, 'scan cap should bound line length');
});

// --- AC-3 (fixture path): a temp-dir graph proving prefer_instead is dropped. -
test('AC-3 (fixture): prefer_instead-reached rules are dropped even when the target has a unique pattern', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftv-'));
  try {
    // root --prefer_instead--> superseded ; root --complements--> paired
    fs.writeFileSync(path.join(dir, 'root.md'), [
      '---',
      'issue_type: root',
      'applicable_flavors: [eds]',
      'risk_tier: medium',
      'forbidden_techniques:',
      "  - pattern: 'ROOTPAT'",
      '    reason: "root rule"',
      'see_also:',
      '  - playbook: superseded',
      '    edge: prefer_instead',
      '    reason: "redirected"',
      '  - playbook: paired',
      '    edge: complements',
      '    reason: "additive"',
      '---',
      '# Root',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'superseded.md'), [
      '---',
      'issue_type: superseded',
      'applicable_flavors: [eds]',
      'risk_tier: medium',
      'forbidden_techniques:',
      "  - pattern: 'SUPERSEDEDPAT'",
      '    reason: "should never fire from root"',
      '---',
      '# Superseded',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'paired.md'), [
      '---',
      'issue_type: paired',
      'applicable_flavors: [eds]',
      'risk_tier: medium',
      'forbidden_techniques:',
      "  - pattern: 'PAIREDPAT'",
      '    reason: "fires from root via complements"',
      '---',
      '# Paired',
    ].join('\n'));

    const rules = collectForbiddenRules('root', 'eds', { dir });
    const pbs = new Set(rules.map((r) => r.playbook));
    assert.ok(pbs.has('root'));
    assert.ok(pbs.has('paired'));
    assert.ok(!pbs.has('superseded'), 'prefer_instead target must contribute no rules');

    const diff = '+++ b/x\n+SUPERSEDEDPAT here\n+PAIREDPAT here';
    const res = validateFixDiff(diff, 'root', 'eds', { dir });
    assert.equal(res.ok, false);
    assert.ok(res.violations.some((v) => v.pattern === 'PAIREDPAT'));
    assert.ok(!res.violations.some((v) => v.pattern === 'SUPERSEDEDPAT'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- translatePattern: exclusion coverage for each Python-only construct. -----
test('translatePattern excludes Python-only constructs with a reason', () => {
  const cases = [
    '(?P<name>abc)',       // named group
    '(?P=name)',           // named backref
    '(?>abc)',             // atomic group
    '(?i)abc',             // inline flags
    '(?i:abc)',            // scoped inline flags
    'a*+',                 // possessive
    '\\Aabc',              // \A anchor
    'abc\\Z',              // \Z anchor
  ];
  for (const c of cases) {
    const r = translatePattern(c);
    assert.equal(r.ok, false, `expected exclusion for ${c}`);
    assert.equal(r.source, null);
    assert.ok(r.reason && r.reason.length > 0);
  }
  // Common portable constructs pass through unchanged.
  for (const c of ['\\s*', '\\bfoo\\b', '(?:a|b)+', 'x(?!y)', 'a{2,4}', '[a-z]\\d']) {
    const r = translatePattern(c);
    assert.equal(r.ok, true, `expected pass-through for ${c}: ${r.reason}`);
    assert.equal(r.source, c);
  }
});
