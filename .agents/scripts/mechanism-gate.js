#!/usr/bin/env node

/**
 * mechanism-gate.js — the ADR-0011 mechanism-before-fix gate, extended with the
 * playbook `required_validation` preconditions unioned along `routes_to` edges
 * (spec 015-04, ADR-0015 §3).
 *
 * ADR-0011 / 003-03 already gate `rootCause: true` on reproduce + negative-
 * control + a discriminating test. This module adds the *playbook-sourced*
 * layer: before a Finding may be promoted to `rootCause: true`, every
 * `required_validation` precondition declared by the root playbook AND by every
 * playbook reachable from it via a `routes_to` edge (the diagnostic-router
 * closure) must be satisfied. `prefer_instead`, `complements`, and `orthogonal`
 * edges are NOT diagnostic routing — a playbook reached ONLY via those edges
 * contributes NONE of its preconditions (ADR-0015 §3: "union along routes_to
 * ONLY").
 *
 * Reuse, not duplication:
 *   - the edge-tagged playbook closure comes from playbook-chain.js
 *     (`resolveChain`), which each 015 consumer applies its own edge policy on
 *     top of;
 *   - single-playbook front-matter (incl. the parsed `requiredValidation`
 *     list) comes from attribution.js (`loadPlaybook`).
 *
 * Public API:
 *   - requiredValidationIds(issueType, flavor, opts) -> [{ id, playbook }]
 *   - checkMechanismPreconditions(issueType, flavor, satisfiedIds) -> { ok, unmet }
 *   - VALIDATION_HANDLERS — the known-id registry (known-vs-unknown messaging).
 *
 * Pure functions: no I/O beyond reading playbook files via loadPlaybook /
 * resolveChain; deterministic for a given (root, flavor, opts, playbook dir).
 */

import { resolveChain } from './playbook-chain.js';
import { loadPlaybook } from './attribution.js';

/**
 * Registry of the `required_validation` ids known across the current playbook
 * set. Its ONLY role in the gate is to distinguish a *known-but-unsatisfied*
 * precondition from an *unknown* one for messaging — satisfaction itself is
 * supplied by the caller's `satisfiedIds`, never inferred here. An id present
 * in a playbook's `required_validation` but ABSENT from this registry is
 * treated as `unknown`: it still lands in `unmet` (never silently satisfied).
 * This module performs NO I/O — it does not itself write to refinement-todo;
 * registry coverage against the real playbook set is enforced by the drift-guard
 * test in mechanism-gate.test.js (a newly-added unregistered id fails that test),
 * and any genuinely-unhandled id is recorded in docs/refinement-todo.md by hand
 * per the 015-04 DoD (currently none — all playbook ids are registered).
 *
 * Each value is a short human label used when surfacing an unmet precondition.
 */
export const VALIDATION_HANDLERS = {
  // layout-shift
  cls_element_attribution_available: 'CLS shift source attributed to a named DOM node (rect before/after)',
  shifting_element_classified: 'the shifting element is classified (image / text / injected container)',
  // image-sizing
  dimensions_known_at_render_time: 'the image intrinsic dimensions are known at render time',
  srcset_check: 'srcset/responsive-image variants have been checked',
  markup_source_in_repo: 'the markup source is present in the pulled repo',
  // font-fallback
  font_face_declarations_inventoried: '@font-face declarations inventoried',
  custom_fonts_distinguished_from_system: 'custom fonts distinguished from system fonts',
  per_font_fix_independently_assessed: 'each font fix independently assessed',
  font_metric_data_available: 'font metric data available (only for the size-adjust fix)',
  css_source_in_repo: 'the CSS source is present in the pulled repo',
  // font-format
  modern_format_version_exists: 'a modern (WOFF2/WOFF) format version exists',
  all_font_face_declarations_aggregated: 'all @font-face declarations aggregated',
  self_hosted_vs_cdn_determined: 'self-hosted vs CDN-served fonts determined',
  // font-preload
  same_font_uses_font_display_optional: 'the preloaded @font-face uses font-display: optional (primary gate)',
  font_url_is_stable: 'the font URL is stable (not cache-busted)',
  crossorigin_matches_font_face: 'crossorigin matches the @font-face crossorigin',
  single_clear_injection_point: 'a single clear injection point exists',
  // blocking-resource
  no_synchronous_dependents: 'no synchronous dependents on the deferred resource',
  no_above_fold_selectors_in_css: 'no above-the-fold selectors in the deferred CSS',
  bundle_dependency_graph_clear: 'the bundle dependency graph is clear',
  // bundling
  block_init_order_preserved: 'block init order preserved across the split',
  file_size_inventory_built: 'a file-size inventory has been built',
  target_template_scope_clear: 'the target template scope is clear',
  // compression
  cdn_yaml_present: 'cdn.yaml is present',
  server_config_writable: 'the CDN/server config is in this repo and writable',
  // general
  cannot_classify_to_specific_type: 'the finding cannot be classified to a specific type',
  // interaction
  runtime_profiling_available: 'runtime profiling is available',
  interaction_handler_attributed: 'the interaction handler is attributed',
  inp_phase_classified: 'the INP phase (input delay / processing / presentation) is classified',
  // js-execution
  long_task_url_attributed: 'the long-task URL is attributed',
  js_can_be_deferred_or_split: 'the JS can be safely deferred or split',
  // inline-css
  inline_style_block_exists: 'the inline <style> block exists',
  rules_already_in_stylesheet: 'the rules already exist in a stylesheet',
  // lcp-image
  lcp_via_lighthouse_attribution: 'LCP element confirmed via Lighthouse attribution',
  no_existing_fetchpriority: 'no existing fetchpriority on the LCP image',
  image_not_js_lazy_loaded: 'the LCP image is not JS lazy-loaded',
  // request-chain
  chain_mapped_to_specific_calls: 'the request chain is mapped to specific calls',
  reordering_safe_per_dependency_graph: 'reordering is safe per the dependency graph',
  // resource-hints
  target_on_lcp_critical_chain: 'the target is on the LCP critical chain (primary gate)',
  target_not_deferred: 'the target is not a defer-safe domain',
  hint_not_already_present: 'the resource hint is not already present',
  crossorigin_for_font_origins: 'crossorigin is set for font origins',
  // resource-preload
  as_attribute_correct_for_resource_type: 'the as= attribute is correct for the resource type',
  crossorigin_if_cross_origin: 'crossorigin is set if the resource is cross-origin',
  resource_url_is_stable: 'the resource URL is stable (not cache-busted)',
  resource_on_critical_render_path: 'the resource is on the critical render path',
  // third-party
  script_classified_by_deferral_safety: 'the third-party script is classified by deferral safety',
  not_tag_manager_managed: 'the script is not tag-manager-managed',
  script_reference_in_markup: 'the script reference is in the markup or a bundle in this repo',
  // ttfb
  root_cause_classified: 'the TTFB root cause is classified',
  server_cache_config_writable: 'the server cache config is in this repo and writable',
  server_profiling_available: 'server-side profiling is available',
  jcr_query_plan_available: 'the JCR query plan is available',
  // unused-code
  lighthouse_coverage_confirms_unused: 'Lighthouse coverage confirms the code is unused',
  not_polyfill: 'the unused code is not a polyfill',
  not_user_action_gated: 'the unused code is not user-action-gated',
  cross_template_usage_checked: 'cross-template usage has been checked',
};

/**
 * The UNION of `required_validation` ids from the root playbook and every
 * playbook in the resolveChain closure reached via a `routes_to` edge. A
 * playbook reached ONLY via prefer_instead / complements / orthogonal edges
 * contributes NOTHING (ADR-0015 §3). De-duped by id: the first originating
 * playbook (in BFS chain order) wins.
 *
 * @param {string} issueType - the root playbook's issue_type.
 * @param {string|null} flavor - eds|cs|ams|headless (or any label resolveFlavor accepts).
 * @param {object} [opts] - forwarded to resolveChain / loadPlaybook ({ depth, dir, source }).
 * @returns {{ id: string, playbook: string }[]}
 */
export function requiredValidationIds(issueType, flavor, opts = {}) {
  const chain = resolveChain(issueType, flavor, opts);
  const loadOpts = opts.dir ? { dir: opts.dir } : undefined;
  const seen = new Set();
  const out = [];
  for (const entry of chain) {
    const edges = Array.isArray(entry.edges) ? entry.edges : [];
    // The root always contributes; every other node contributes ONLY when it
    // was reached (at least in part) via a routes_to edge.
    const contributes = edges.includes('root') || edges.includes('routes_to');
    if (!contributes) continue;
    const pb = loadPlaybook(entry.issueType, loadOpts);
    const ids = (pb && pb.frontmatter && pb.frontmatter.requiredValidation) || [];
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, playbook: entry.issueType });
    }
  }
  return out;
}

/**
 * The mechanism-precondition gate. Collects the `routes_to`-unioned
 * `required_validation` ids for the root issue type, then partitions them
 * against the caller-supplied `satisfiedIds`.
 *
 * `ok` is true iff every collected precondition is satisfied. `unmet` names
 * each unsatisfied precondition with its originating playbook and whether it is
 * `known` (in VALIDATION_HANDLERS) or `unknown` (no registered handler). An
 * unknown id is NEVER silently treated as satisfied — if it's not in
 * `satisfiedIds`, it lands in `unmet`.
 *
 * @param {string} issueType
 * @param {string|null} flavor
 * @param {Iterable<string>} [satisfiedIds] - ids the diagnosis has confirmed.
 * @param {object} [opts] - forwarded to requiredValidationIds.
 * @returns {{ ok: boolean, unmet: { id: string, playbook: string, known: boolean, label: string|null }[] }}
 */
export function checkMechanismPreconditions(issueType, flavor, satisfiedIds = [], opts = {}) {
  const satisfied = satisfiedIds instanceof Set ? satisfiedIds : new Set(satisfiedIds || []);
  const collected = requiredValidationIds(issueType, flavor, opts);
  const unmet = [];
  for (const { id, playbook } of collected) {
    if (satisfied.has(id)) continue;
    const known = Object.prototype.hasOwnProperty.call(VALIDATION_HANDLERS, id);
    unmet.push({ id, playbook, known, label: known ? VALIDATION_HANDLERS[id] : null });
  }
  return { ok: unmet.length === 0, unmet };
}
