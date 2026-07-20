import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  requiredValidationIds,
  checkMechanismPreconditions,
  VALIDATION_HANDLERS,
} from '../mechanism-gate.js';
import { loadPlaybook } from '../attribution.js';

// These tests run against the REAL vendored playbook set (per the DoD) except
// the isolated fixture cases (no-precondition passthrough, unknown-id), which
// need a synthetic temp-dir playbook graph to be exercised deterministically.

const idsOf = (rows) => new Set(rows.map((r) => r.id));

/** Write a minimal playbook (front-matter only) into `dir`. */
function writePlaybook(dir, issueType, { flavors = ['eds', 'cs', 'ams'], required = [], seeAlso = [] } = {}) {
  const lines = ['---', `issue_type: ${issueType}`, `applicable_flavors: [${flavors.join(', ')}]`, 'risk_tier: low'];
  if (required.length) {
    lines.push('required_validation:');
    for (const r of required) lines.push(`  - ${r}`);
  }
  if (seeAlso.length) {
    lines.push('see_also:');
    for (const e of seeAlso) {
      lines.push(`  - playbook: ${e.playbook}`);
      lines.push(`    edge: ${e.edge}`);
      lines.push(`    reason: "${e.reason || 'fixture edge'}"`);
    }
  }
  lines.push('---', '', `# ${issueType}`, '');
  fs.writeFileSync(path.join(dir, `${issueType}.md`), lines.join('\n'));
}

// --- AC-1: routes_to union; non-routes_to edge contributes nothing ----------

test('AC-1: layout-shift unions its own + routes_to children ids; complements-only ids are absent', () => {
  // layout-shift (cs) -> routes_to image-sizing, routes_to font-fallback,
  //                      complements font-preload.
  // font-fallback -> complements font-preload (so font-preload is reached ONLY
  // via complements — never routes_to). Its `same_font_uses_font_display_optional`
  // precondition must therefore be ABSENT.
  const rows = requiredValidationIds('layout-shift', 'cs');
  const ids = idsOf(rows);

  // layout-shift's own required_validation.
  assert.ok(ids.has('cls_element_attribution_available'), 'own id present');
  assert.ok(ids.has('shifting_element_classified'), 'own id present');
  // routes_to image-sizing.
  assert.ok(ids.has('dimensions_known_at_render_time'), 'routes_to image-sizing id present');
  // routes_to font-fallback.
  assert.ok(ids.has('font_face_declarations_inventoried'), 'routes_to font-fallback id present');

  // font-preload is reached ONLY via complements edges -> contributes nothing.
  assert.ok(!ids.has('same_font_uses_font_display_optional'),
    'complements-only playbook (font-preload) contributes NO precondition');
  assert.ok(!ids.has('crossorigin_matches_font_face'),
    'complements-only playbook (font-preload) contributes NO precondition');

  // originating playbook is recorded.
  const attr = rows.find((r) => r.id === 'cls_element_attribution_available');
  assert.equal(attr.playbook, 'layout-shift', 'originating playbook recorded');
});

test('AC-1 (fixture): a routes_to-only union proves prefer_instead/orthogonal contribute nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-gate-ac1-'));
  try {
    writePlaybook(dir, 'root-fix', {
      required: ['root_precond'],
      seeAlso: [
        { playbook: 'routed', edge: 'routes_to' },
        { playbook: 'redirected', edge: 'prefer_instead' },
        { playbook: 'sideways', edge: 'orthogonal' },
      ],
    });
    writePlaybook(dir, 'routed', { required: ['routed_precond'] });
    writePlaybook(dir, 'redirected', { required: ['redirected_precond'] });
    writePlaybook(dir, 'sideways', { required: ['sideways_precond'] });

    const ids = idsOf(requiredValidationIds('root-fix', 'eds', { dir }));
    assert.ok(ids.has('root_precond'), 'root contributes');
    assert.ok(ids.has('routed_precond'), 'routes_to child contributes');
    assert.ok(!ids.has('redirected_precond'), 'prefer_instead contributes nothing');
    assert.ok(!ids.has('sideways_precond'), 'orthogonal contributes nothing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- AC-2: gate blocks with named id + playbook when unsatisfied ------------

test('AC-2: empty satisfiedIds -> ok:false and unmet names id(s) + originating playbook', () => {
  const { ok, unmet } = checkMechanismPreconditions('layout-shift', 'cs', []);
  assert.equal(ok, false, 'gate refuses when nothing satisfied');
  const attr = unmet.find((u) => u.id === 'cls_element_attribution_available');
  assert.ok(attr, 'the blocking id is named');
  assert.equal(attr.playbook, 'layout-shift', 'the originating playbook is named');
  assert.equal(attr.known, true, 'a registry id is flagged known');
  assert.ok(typeof attr.label === 'string' && attr.label.length > 0, 'known id carries a label');

  // Satisfy every collected id -> gate opens.
  const all = requiredValidationIds('layout-shift', 'cs').map((r) => r.id);
  const opened = checkMechanismPreconditions('layout-shift', 'cs', all);
  assert.equal(opened.ok, true, 'gate opens once all preconditions satisfied');
  assert.deepEqual(opened.unmet, [], 'no unmet when all satisfied');
});

// --- AC-3: no-precondition routes_to chain -> passthrough -------------------

test('AC-3 (fixture): a routes_to chain with no required_validation -> ok:true, unmet empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-gate-ac3-'));
  try {
    // root declares nothing and routes_to a child that also declares nothing.
    writePlaybook(dir, 'bare-root', { seeAlso: [{ playbook: 'bare-child', edge: 'routes_to' }] });
    writePlaybook(dir, 'bare-child', {});

    const rows = requiredValidationIds('bare-root', 'eds', { dir });
    assert.deepEqual(rows, [], 'no preconditions collected');

    const { ok, unmet } = checkMechanismPreconditions('bare-root', 'eds', [], { dir });
    assert.equal(ok, true, 'gate is transparent when there are no preconditions');
    assert.deepEqual(unmet, [], 'nothing unmet');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- AC-4: unknown id surfaced (never silently satisfied) -------------------

test('AC-4 (fixture): an unknown id (no registry handler) appears in unmet with ok:false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-gate-ac4-'));
  try {
    writePlaybook(dir, 'novel', { required: ['brand_new_unregistered_precond'] });

    // The fixture id is intentionally not in the registry.
    assert.ok(!Object.prototype.hasOwnProperty.call(VALIDATION_HANDLERS, 'brand_new_unregistered_precond'),
      'the fixture id is genuinely unknown to the registry');

    const empty = checkMechanismPreconditions('novel', 'eds', [], { dir });
    assert.equal(empty.ok, false, 'unknown + unsatisfied -> gate refuses');
    const u = empty.unmet.find((x) => x.id === 'brand_new_unregistered_precond');
    assert.ok(u, 'unknown id present in unmet (never silently satisfied)');
    assert.equal(u.known, false, 'flagged unknown');
    assert.equal(u.label, null, 'unknown id carries no registry label');

    // With the id in satisfiedIds the gate opens (satisfaction is caller-supplied).
    const sat = checkMechanismPreconditions('novel', 'eds', ['brand_new_unregistered_precond'], { dir });
    assert.equal(sat.ok, true, 'once satisfied, the unknown id no longer blocks');
    assert.deepEqual(sat.unmet, [], 'nothing unmet when the collected id is satisfied');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Registry coverage: every REAL playbook required_validation id is known --

test('registry covers every base required_validation id in the real playbook set', () => {
  // Guard against silent drift: the four playbooks whose ids the ACs assert on
  // must be registry-known.
  for (const id of ['cls_element_attribution_available', 'shifting_element_classified',
    'dimensions_known_at_render_time', 'font_face_declarations_inventoried']) {
    assert.ok(Object.prototype.hasOwnProperty.call(VALIDATION_HANDLERS, id), `${id} registered`);
  }
});

// --- Drift guard: VALIDATION_HANDLERS must cover every real playbook id ------
// Converts silent registry drift (a new playbook required_validation id that
// falls through to `unknown` at runtime) into a caught test failure.
test('drift guard: every real playbook required_validation id is registered', () => {
  const dir = path.join(process.cwd(), '.agents/references/playbooks');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md');
  const missing = [];
  for (const f of files) {
    const issueType = f.replace(/\.md$/, '');
    const pb = loadPlaybook(issueType, { dir });
    const ids = (pb && pb.frontmatter && pb.frontmatter.requiredValidation) || [];
    for (const id of ids) {
      if (!Object.prototype.hasOwnProperty.call(VALIDATION_HANDLERS, id)) {
        missing.push(`${issueType}: ${id}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `unregistered required_validation ids (add to VALIDATION_HANDLERS or log to refinement-todo):\n${missing.join('\n')}`,
  );
});
