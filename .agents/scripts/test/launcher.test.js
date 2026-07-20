import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseArgs,
  computeRunPlan,
  decideLauncherExit,
  normalizeDomSnapshotSelectors,
  redactDomSnapshotString,
  shouldRedactDomSnapshotAttribute,
  normalizeEdsStructureSnapshotOptions,
  readInjectedScripts,
  isNonEmptyPatchBundle,
  summarizePatchBundle,
  composePatchHandlers,
  DEFAULT_EDS_STRUCTURE_SNAPSHOT_LIMIT,
} from '../launcher.js';
import { describePatchModes } from '../patches/patch-modes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER_PATH = path.join(__dirname, '..', 'launcher.js');

function runLauncherCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [LAUNCHER_PATH, ...args], {
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

// ---------------------------------------------------------------------------
// Field-faithful default (ROADMAP G1, stage 1a)
//
// The launcher scrolls-to-quiescence by DEFAULT so the CLS it reports is the
// field-faithful CLS of record (post-load shifts: scroll-lazy ads, late/consent
// banners). `--no-scroll` is the explicit load-only opt-out for cost-sensitive
// runs (e.g. an LCP/INP-only experiment batch).
// ---------------------------------------------------------------------------

test('scroll (field-faithful) is ON by default', () => {
  const args = parseArgs(['--url', 'https://example.test/']);
  assert.equal(args.scroll, true);
});

test('--no-scroll opts out to a load-only run', () => {
  const args = parseArgs(['--url', 'https://example.test/', '--no-scroll']);
  assert.equal(args.scroll, false);
});

test('--scroll is accepted explicitly (matches the default)', () => {
  const args = parseArgs(['--url', 'https://example.test/', '--scroll']);
  assert.equal(args.scroll, true);
});

test('last scroll flag wins (toggle precedence)', () => {
  assert.equal(parseArgs(['--scroll', '--no-scroll']).scroll, false);
  assert.equal(parseArgs(['--no-scroll', '--scroll']).scroll, true);
});

test('unrelated defaults are unchanged (consent resolved later in main)', () => {
  const args = parseArgs(['--url', 'https://example.test/']);
  assert.equal(args.consent, null); // main() resolves null -> dismiss in scroll mode
  assert.equal(args.cohort, 'first-visit');
  assert.equal(args.profile, 'mobile-slow4g-4xcpu');
});

// ---------------------------------------------------------------------------
// response op (spec 016-04): Mode B response = fulfill a request URL with
// SUPPLIED bytes (distinct from rewriteBody's find/replace). composePatchHandlers
// builds a pure `responseReplacer(event) -> { body, contentType? } | null` that
// glob-matches the request URL; installFetchInterceptor prefers it over the
// find/replace path. Tested here OFFLINE with a fake CDP event — no browser.
// ---------------------------------------------------------------------------

function fakeEvent(url) {
  return { request: { url } };
}

test('responseReplacer: matches the request URL and returns the supplied bytes (AC1)', () => {
  const url = 'https://www.example.com/assets/bundles/site-base.min.css';
  const handlers = composePatchHandlers({
    response: [{ urlPattern: url, body: '.hero{contain:layout}', contentType: 'text/css' }],
  });
  assert.equal(typeof handlers.responseReplacer, 'function');
  const hit = handlers.responseReplacer(fakeEvent(url));
  assert.ok(hit, 'a matching request URL returns a hit');
  // The body is base64 (what Fetch.fulfillRequest expects); it decodes to the
  // supplied bytes.
  assert.equal(Buffer.from(hit.body, 'base64').toString('utf8'), '.hero{contain:layout}', 'the supplied bytes are returned');
  assert.equal(hit.contentType, 'text/css');
});

test('responseReplacer: glob patterns match; non-matching URLs return null', () => {
  const handlers = composePatchHandlers({
    response: [{ urlPattern: '*/site-base.min.css', body: '.a{}' }],
  });
  assert.ok(handlers.responseReplacer(fakeEvent('https://x/assets/bundles/site-base.min.css')));
  assert.equal(handlers.responseReplacer(fakeEvent('https://x/other.css')), null, 'non-match returns null');
});

test('responseReplacer: absent when no response op is present (purely additive)', () => {
  const handlers = composePatchHandlers({ block: ['*/ad.js'] });
  assert.equal(typeof handlers.responseReplacer, 'function', 'always a function (composable)');
  assert.equal(handlers.responseReplacer(fakeEvent('https://x/anything')), null, 'no response op → always null');
});

test('responseReplacer: does not disturb the existing bodyRewriter (find/replace still works)', () => {
  const handlers = composePatchHandlers({
    rewriteBody: [{ urlPattern: '*', replacements: [{ find: 'a', replace: 'b' }] }],
  });
  // responseReplacer never fires (no response op), so the find/replace path is
  // unchanged — the bodyRewriter still transforms a matching body.
  assert.equal(handlers.responseReplacer(fakeEvent('https://x/')), null);
  const encoded = Buffer.from('aaa', 'utf8').toString('base64');
  const out = handlers.bodyRewriter(fakeEvent('https://x/'), encoded);
  assert.equal(Buffer.from(out, 'base64').toString('utf8'), 'bbb', 'bodyRewriter unaffected by the response op');
});

test('injected script bundle includes fonts collector', () => {
  const injected = readInjectedScripts();
  assert.equal(typeof injected.fonts, 'string');
  assert.match(injected.fonts, /__fonts_snapshot/);
  assert.match(injected.resources, /__resources_snapshot/);
  assert.match(injected.cwvCombined, /__cwv_snapshot/);
});

test('summarizePatchBundle records URL-bearing patch surfaces without rewrite bodies', () => {
  const bundle = {
    preloads: [{ href: 'https://cdn.example.com/hero.webp', as: 'image', fetchpriority: 'high' }],
    rewriteBody: [{
      urlPattern: '*theme.js*',
      replacements: [
        { find: '.show(e)', replace: '.show()' },
        { find: '</body>', replace: '<script src="https://tag.example.com/injected.js"></script></body>' },
        { find: '</head>', replace: '<link href="/styles/injected.css" rel="stylesheet"></head>' },
      ],
    }],
    markup: [
      { selector: 'script[src*="tag.example.com"]', attrs: { defer: '' } },
      { selector: '#loader', attrs: { src: 'https://tag.example.com/injected.js', 'data-token': 'secret' } },
    ],
  };
  assert.equal(isNonEmptyPatchBundle(bundle), true);
  const summary = summarizePatchBundle(bundle);
  assert.equal(summary.applied, true);
  assert.deepEqual(summary.counts.preloads, 1);
  assert.deepEqual(summary.preloads[0], {
    href: 'https://cdn.example.com/hero.webp',
    as: 'image',
    fetchpriority: 'high',
  });
  assert.deepEqual(summary.rewriteBody, [{
    urlPattern: '*theme.js*',
    injectedUrls: ['https://tag.example.com/injected.js', '/styles/injected.css'],
  }]);
  assert.deepEqual(summary.markup[1], {
    selector: '#loader',
    attrs: { src: 'https://tag.example.com/injected.js' },
  });
  assert.ok(!JSON.stringify(summary).includes('.show(e)'), 'rewrite body strings are not copied into launcher output');
  assert.equal(isNonEmptyPatchBundle({}), false);
});

// Spec 016-02 AC2: when the bundle is non-empty, appliedPatches carries a
// `modes` array of ASV-shaped descriptors alongside the existing summary. This
// mirrors the launcher wiring (output.appliedPatches = summarizePatchBundle(...);
// output.appliedPatches.modes = describePatchModes(...)) without booting Chrome.
test('appliedPatches carries a Mode A/B `modes` descriptor array (spec 016-02)', () => {
  const bundle = {
    markup: [{ selector: 'img.hero', attrs: { fetchpriority: 'high' } }],
    block: ['*/ad.js'],
    rewriteBody: [{ urlPattern: '*', replacements: [{ find: '</head>', replace: '<style>a{}</style></head>' }] }],
  };
  assert.equal(isNonEmptyPatchBundle(bundle), true);
  const appliedPatches = summarizePatchBundle(bundle);
  appliedPatches.modes = describePatchModes(bundle);
  assert.ok(Array.isArray(appliedPatches.modes));
  // Every descriptor carries a mode plus either an op (Mode A) or a spliceKind (Mode B).
  for (const d of appliedPatches.modes) {
    assert.ok(d.mode === 'A' || d.mode === 'B');
    if (d.mode === 'A') assert.ok(typeof d.op === 'string');
    else assert.ok(typeof d.spliceKind === 'string');
  }
  // block/preload/header ops are flagged workbench-only (no ASV Mode A analog).
  const blockDesc = appliedPatches.modes.find((d) => d.op === 'block');
  assert.equal(blockDesc.workbenchOnly, true);
  // The existing summary is untouched by the modes addition.
  assert.equal(appliedPatches.applied, true);
});

test('--dom-snapshot-selector accepts comma-separated selectors and repeats', () => {
  const args = parseArgs([
    '--url', 'https://example.test/',
    '--dom-snapshot-selector', '#FindCare, #select-your-insurance',
    '--dom-snapshot-selector', '.tabs-wrapper',
  ]);
  assert.deepEqual(args.domSnapshotSelectors, ['#FindCare', '#select-your-insurance', '.tabs-wrapper']);
});

test('normalizeDomSnapshotSelectors trims empty values', () => {
  assert.deepEqual(normalizeDomSnapshotSelectors(' #a, , .b '), ['#a', '.b']);
  assert.deepEqual(normalizeDomSnapshotSelectors(''), []);
});

test('DOM snapshot redaction masks common sensitive text and attributes', () => {
  assert.equal(redactDomSnapshotString('Contact jane@example.com'), 'Contact [redacted-email]');
  assert.equal(redactDomSnapshotString('Call +1 (415) 555-1234'), 'Call [redacted-phone]');
  assert.equal(redactDomSnapshotString('id 4111 1111 1111 1111'), 'id [redacted-number]');
  assert.equal(shouldRedactDomSnapshotAttribute('data-token', 'abc123'), true);
  assert.equal(shouldRedactDomSnapshotAttribute('href', 'https://example.test/?session=abc123'), true);
  assert.equal(shouldRedactDomSnapshotAttribute('class', 'tabs-wrapper'), false);
});

test('normalizeDomSnapshotSelectors preserves array selector entries', () => {
  assert.deepEqual(
    normalizeDomSnapshotSelectors([' #FindCare,#select-your-insurance ', '', null, ' .tab-panel ']),
    ['#FindCare,#select-your-insurance', '.tab-panel'],
  );
});

// ---------------------------------------------------------------------------
// EDS structure snapshot flag
// ---------------------------------------------------------------------------

test('--eds-structure-snapshot is opt-in and uses a bounded default section limit', () => {
  const defaults = parseArgs(['--url', 'https://example.test/']);
  assert.equal(defaults.edsStructureSnapshot, false);
  assert.equal(defaults.edsStructureSnapshotLimit, DEFAULT_EDS_STRUCTURE_SNAPSHOT_LIMIT);

  const enabled = parseArgs(['--url', 'https://example.test/', '--eds-structure-snapshot']);
  assert.equal(enabled.edsStructureSnapshot, true);
  assert.equal(enabled.edsStructureSnapshotLimit, DEFAULT_EDS_STRUCTURE_SNAPSHOT_LIMIT);
});

test('--eds-structure-snapshot-limit overrides the section scan cap', () => {
  const args = parseArgs([
    '--url', 'https://example.test/',
    '--eds-structure-snapshot',
    '--eds-structure-snapshot-limit', '12',
  ]);
  assert.equal(args.edsStructureSnapshot, true);
  assert.equal(args.edsStructureSnapshotLimit, 12);
});

test('normalizeEdsStructureSnapshotOptions bounds limit and preserves phase labels', () => {
  assert.deepEqual(
    normalizeEdsStructureSnapshotOptions({}),
    { limit: DEFAULT_EDS_STRUCTURE_SNAPSHOT_LIMIT, phase: 'snapshot' },
  );
  assert.deepEqual(
    normalizeEdsStructureSnapshotOptions({ limit: 999, phase: 'pre-scroll' }),
    { limit: 50, phase: 'pre-scroll' },
  );
  assert.deepEqual(
    normalizeEdsStructureSnapshotOptions({ limit: '6.8', phase: ' post-scroll ' }),
    { limit: 6, phase: 'post-scroll' },
  );
});

// ---------------------------------------------------------------------------
// V2 — tolerate a failed run instead of aborting the batch
//
// A single nav timeout on a flaky slow target used to abort the whole launcher
// batch (exit 1) after one of N runs. The loop now skips/retries a failed run
// and continues toward the cap, only failing if it can't reach --min-samples
// successful runs. New flags: --nav-timeout, --max-failures.
// ---------------------------------------------------------------------------

test('--nav-timeout overrides the per-navigation timeout; defaults to 60000', () => {
  assert.equal(parseArgs(['--url', 'https://example.test/']).navTimeout, 60000);
  assert.equal(parseArgs(['--nav-timeout', '30000']).navTimeout, 30000);
});

test('--max-failures parses; defaults to null (computeRunPlan supplies the scaled default)', () => {
  assert.equal(parseArgs(['--url', 'https://example.test/']).maxFailures, null);
  assert.equal(parseArgs(['--max-failures', '1']).maxFailures, 1);
});

test('computeRunPlan: single-run default needs 1 success and allows a couple retries', () => {
  const p = computeRunPlan({ runs: 1, minSamples: 3 });
  assert.equal(p.floorRuns, 1);
  assert.equal(p.capRuns, 1);
  assert.equal(p.targetSuccesses, 1);
  assert.equal(p.adaptive, false);
  assert.equal(p.requiredSuccesses, 1, 'min(min-samples 3, capRuns 1) = 1 — never require more than requested');
  assert.equal(p.maxFailures, 2, 'default tolerance max(2, floorRuns)');
  assert.equal(p.attemptCap, 3, 'capRuns 1 + 2 tolerated');
});

test('computeRunPlan: a 5-run batch aims for 5 but is usable at min-samples 3', () => {
  const p = computeRunPlan({ runs: 5, minSamples: 3 });
  assert.equal(p.capRuns, 5);
  assert.equal(p.targetSuccesses, 5);
  assert.equal(p.requiredSuccesses, 3);
  assert.equal(p.maxFailures, 5, 'tolerate up to floorRuns failed attempts');
  assert.equal(p.attemptCap, 10);
});

test('computeRunPlan: adaptive (--runs floor, --max-runs cap)', () => {
  const p = computeRunPlan({ runs: 5, maxRuns: 8, minSamples: 3 });
  assert.equal(p.floorRuns, 5);
  assert.equal(p.capRuns, 8);
  assert.equal(p.adaptive, true);
  assert.equal(p.targetSuccesses, 8);
  assert.equal(p.requiredSuccesses, 3);
});

test('computeRunPlan: requiredSuccesses honors a higher --min-samples but caps at capRuns', () => {
  assert.equal(computeRunPlan({ runs: 5, minSamples: 5 }).requiredSuccesses, 5);
  assert.equal(computeRunPlan({ runs: 2, minSamples: 5 }).requiredSuccesses, 2, 'cannot need more than requested');
});

test('computeRunPlan: --max-failures 0 restores strict abort-on-first-failure (no extra attempts)', () => {
  const p = computeRunPlan({ runs: 5, minSamples: 3, maxFailures: 0 });
  assert.equal(p.maxFailures, 0);
  assert.equal(p.attemptCap, 5, 'no retry budget → attemptCap === capRuns');
});

test('computeRunPlan: tolerates missing/garbage input with sane defaults', () => {
  const p = computeRunPlan({});
  assert.equal(p.floorRuns, 1);
  assert.equal(p.capRuns, 1);
  assert.ok(p.requiredSuccesses >= 1);
  assert.ok(p.attemptCap >= p.capRuns);
});

test('decideLauncherExit: 0 iff successes reach requiredSuccesses, else 1', () => {
  const p = computeRunPlan({ runs: 5, minSamples: 3 }); // requiredSuccesses 3
  assert.equal(decideLauncherExit(5, p), 0);
  assert.equal(decideLauncherExit(3, p), 0, 'min-samples floor met');
  assert.equal(decideLauncherExit(2, p), 1, 'below min-samples → unusable');
  assert.equal(decideLauncherExit(0, p), 1);
});

// ---------------------------------------------------------------------------
// ADR-0014 / spec 014-01 — opt-in doctor preflight gate
//
// --preflight-profile and --skip-preflight are parsed by parseArgs; the gate
// itself (checkPreflight/formatPreflightGate) lives in preflight.js and is
// unit-tested there. Here: flag parsing, plus the CLI's exit-code behavior
// (0/1/2, matching doctor.js's own convention) for the argument-validation
// path that runs entirely before any Puppeteer/measurement work starts.
// ---------------------------------------------------------------------------

test('--preflight-profile and --skip-preflight parse; default to off', () => {
  const defaults = parseArgs(['--url', 'https://example.test/']);
  assert.equal(defaults.preflightProfile, null);
  assert.equal(defaults.skipPreflight, false);

  const withProfile = parseArgs(['--url', 'https://example.test/', '--preflight-profile', 'field-google']);
  assert.equal(withProfile.preflightProfile, 'field-google');
  assert.equal(withProfile.skipPreflight, false);

  const withSkip = parseArgs(['--url', 'https://example.test/', '--skip-preflight']);
  assert.equal(withSkip.skipPreflight, true);
  assert.equal(withSkip.preflightProfile, null);
});

test('CLI: no --preflight-profile is a no-op — usage error path unaffected (exit 2, no doctor text)', () => {
  const result = runLauncherCli([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--url is required/);
  assert.doesNotMatch(result.stderr, /cwv doctor:/);
});

test('CLI: --preflight-profile with a VERIFIABLE-missing required prerequisite refuses before any measurement (exit 1)', () => {
  // field-google requires GOOGLE_* env keys; with none configured the missing
  // env is a deterministic BLOCK (fail), unlike a bare `unknown` which the
  // gate surfaces as a non-blocking advisory (block on fail+not-wired, advise
  // on unknown). The gate runs before any Puppeteer work.
  const result = runLauncherCli(['--url', 'https://example.test/', '--preflight-profile', 'field-google']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GOOGLE_CRUX_API_KEY|GOOGLE_PAGESPEED_INSIGHTS_API_KEY/);
});

test('CLI: an unknown --preflight-profile is a clean usage error (exit 2), not an uncaught throw', () => {
  const result = runLauncherCli(['--url', 'https://example.test/', '--preflight-profile', 'not-a-real-profile']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown profile "not-a-real-profile"/);
  assert.doesNotMatch(result.stderr, /phase.*main/, 'must be a clean usage error, not the generic outer catch');
});

// Note: the hermetic --skip-preflight bypass assertion lives in
// preflight.test.js (standalone CLI, no browser). The launcher's own
// --preflight-profile gate (exit 1 on missing prerequisite) is covered above;
// --skip-preflight parsing is covered by the parseArgs test.
