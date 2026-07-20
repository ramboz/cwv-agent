#!/usr/bin/env node

/**
 * Tests for rank-candidates.js — deterministic ranking of diagnose findings
 * into orchestrate-consumable candidates.
 *
 * Covers: filter rules (status, empty patches, min confidence), impact
 * normalization (ms vs CLS score), stable sort order, envelope / array /
 * single-finding input shapes.
 */

import {
  extractFindings,
  impactMsEquivalent,
  hasNonEmptyPatches,
  findingToCandidate,
  rankCandidates,
  inferInterventionType,
  extractCanonicalUrls,
  extractAttributionTargets,
  dedupeCandidates,
  sourceTierOf,
  rank,
  deriveStructuralGate,
  applyStructuralGateToCandidates,
} from '../rank-candidates.js';

// Silence dedup stderr logs during the test run; restore after.
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  if (typeof chunk === 'string' && chunk.includes('"rank-candidates.dedupe"')) return true;
  return origStderrWrite(chunk, ...rest);
};

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}\n`);
}
function test(name, fn) {
  try { fn(); record(name, true); }
  catch (err) { record(name, false, err && err.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ---------------------------------------------------------------------------
// Fixture builders — minimal findings matching the schema's shape
// ---------------------------------------------------------------------------

function mkFinding(over = {}) {
  return {
    schemaVersion: '1.0',
    id: 'diagnose-lcp-1',
    timestamp: '2026-04-17T00:00:00Z',
    url: 'https://example.test/',
    skill: 'cwv-diagnose',
    source: 'har',
    metric: ['LCP'],
    type: 'bottleneck',
    severity: 'high',
    rootCause: true,
    cause: 'hero image not preloaded',
    evidence: [{ kind: 'cwv-attribution', data: { target: 'img.hero' } }],
    recommendation: 'preload hero image',
    patches: { preloads: [{ href: '/hero.jpg', as: 'image', fetchpriority: 'high' }] },
    confidence: 0.85,
    impactReduction: { metric: 'LCP', valueMs: 1200 },
    status: 'proposed',
    ...over,
  };
}

function mkEnvelope(findings) {
  return {
    schemaVersion: '1.0',
    skill: 'cwv-diagnose',
    url: 'https://example.test/',
    timestamp: '2026-04-17T00:00:00Z',
    findings,
  };
}

function mkStructuralFinding(over = {}) {
  return mkFinding({
    id: 'diagnose-eds-structure-1',
    source: 'html',
    metric: ['CLS', 'LCP'],
    type: 'bottleneck',
    cause: 'EDS reveal/page-shape contract is broken',
    evidence: [{
      kind: 'rule-violation',
      data: {
        ruleId: 'html/eds-structural-contract',
        context: {
          gateResult: 'fail',
          reasons: ['first meaningful section is section 6'],
        },
      },
    }],
    recommendation: 'Restore the EDS reveal and eager-section contract.',
    patches: undefined,
    confidence: 0.7,
    impactReduction: { metric: 'CLS', score: 0.1 },
    rootCause: true,
    structuralGate: {
      name: 'eds-structural-contract',
      result: 'fail',
      reasons: ['first meaningful section is section 6'],
    },
    ...over,
  });
}

// ---------------------------------------------------------------------------
// extractFindings
// ---------------------------------------------------------------------------

test('extractFindings: envelope → findings array', () => {
  const e = mkEnvelope([mkFinding()]);
  assert(extractFindings(e).length === 1);
});

test('extractFindings: bare array → returned as-is', () => {
  const arr = [mkFinding(), mkFinding({ id: 'diagnose-lcp-2' })];
  assert(extractFindings(arr).length === 2);
});

test('extractFindings: single bare finding → wrapped in array', () => {
  const f = mkFinding();
  assert(extractFindings(f).length === 1);
  assert(extractFindings(f)[0].id === 'diagnose-lcp-1');
});

test('extractFindings: empty object → empty array', () => {
  assert(extractFindings({}).length === 0);
});

// ---------------------------------------------------------------------------
// impactMsEquivalent
// ---------------------------------------------------------------------------

test('impactMsEquivalent: valueMs returned as abs', () => {
  assert(impactMsEquivalent({ metric: 'LCP', valueMs: 1200 }) === 1200);
  assert(impactMsEquivalent({ metric: 'LCP', valueMs: -300 }) === 300);
});

test('impactMsEquivalent: CLS score scaled ×1000 for ranking', () => {
  assert(impactMsEquivalent({ metric: 'CLS', score: 0.05 }) === 50);
  assert(impactMsEquivalent({ metric: 'CLS', score: -0.03 }) === 30);
});

test('impactMsEquivalent: missing fields → 0', () => {
  assert(impactMsEquivalent({}) === 0);
  assert(impactMsEquivalent(null) === 0);
});

// ---------------------------------------------------------------------------
// hasNonEmptyPatches
// ---------------------------------------------------------------------------

test('hasNonEmptyPatches: non-empty array value → true', () => {
  assert(hasNonEmptyPatches({ preloads: [{ href: '/a.jpg' }] }) === true);
});

test('hasNonEmptyPatches: empty array value → false', () => {
  assert(hasNonEmptyPatches({ preloads: [] }) === false);
});

test('hasNonEmptyPatches: empty object → false', () => {
  assert(hasNonEmptyPatches({}) === false);
});

test('hasNonEmptyPatches: null / non-object → false', () => {
  assert(hasNonEmptyPatches(null) === false);
  assert(hasNonEmptyPatches([]) === false);
});

// ---------------------------------------------------------------------------
// findingToCandidate — filter rules
// ---------------------------------------------------------------------------

test('findingToCandidate: proposed with patches → candidate', () => {
  const c = findingToCandidate(mkFinding(), 0.5);
  assert(c !== null);
  assert(c.id === 'diagnose-lcp-1');
  assert(c.metric === 'LCP');
  assert(c.expectedImpactMs === 1200);
  assert(c.confidence === 0.85);
  assert(c.rankScore === 1200 * 0.85);
});

test('findingToCandidate: status=rejected → null', () => {
  const c = findingToCandidate(mkFinding({ status: 'rejected' }), 0.5);
  assert(c === null);
});

test('findingToCandidate: missing patches → null', () => {
  const c = findingToCandidate(mkFinding({ patches: {} }), 0.5);
  assert(c === null);
});

test('findingToCandidate: patches undefined → null', () => {
  const f = mkFinding();
  delete f.patches;
  const c = findingToCandidate(f, 0.5);
  assert(c === null);
});

test('findingToCandidate: confidence below minConfidence → null', () => {
  const c = findingToCandidate(mkFinding({ confidence: 0.4 }), 0.5);
  assert(c === null);
});

test('findingToCandidate: CLS score → expectedImpactScore + rankScore in ms-equiv', () => {
  const f = mkFinding({
    id: 'diagnose-cls-1',
    metric: ['CLS'],
    impactReduction: { metric: 'CLS', score: 0.05 },
  });
  const c = findingToCandidate(f, 0.5);
  assert(c !== null);
  assert(c.expectedImpactMs === null);
  assert(c.expectedImpactScore === 0.05);
  assert(c.rankScore === 50 * 0.85, `rankScore=${c.rankScore}`);
});

// ---------------------------------------------------------------------------
// rankCandidates — sort order
// ---------------------------------------------------------------------------

test('rankCandidates: higher rankScore first', () => {
  const list = [
    { id: 'a', rankScore: 100, confidence: 0.8 },
    { id: 'b', rankScore: 500, confidence: 0.7 },
    { id: 'c', rankScore: 200, confidence: 0.9 },
  ];
  const sorted = rankCandidates(list);
  assert(sorted.map((c) => c.id).join(',') === 'b,c,a');
});

test('rankCandidates: tie on rankScore → higher confidence first', () => {
  const list = [
    { id: 'a', rankScore: 100, confidence: 0.7 },
    { id: 'b', rankScore: 100, confidence: 0.9 },
  ];
  const sorted = rankCandidates(list);
  assert(sorted[0].id === 'b');
});

test('rankCandidates: tie on rankScore + confidence → id ascending', () => {
  const list = [
    { id: 'diagnose-lcp-2', rankScore: 100, confidence: 0.8 },
    { id: 'diagnose-lcp-1', rankScore: 100, confidence: 0.8 },
  ];
  const sorted = rankCandidates(list);
  assert(sorted[0].id === 'diagnose-lcp-1');
});

// ---------------------------------------------------------------------------
// rank() — end-to-end
// ---------------------------------------------------------------------------

test('rank: end-to-end envelope with mixed findings', () => {
  // Distinct patches + distinct attribution targets so the dedup pass
  // leaves them as separate candidates.
  const e = mkEnvelope([
    mkFinding({
      id: 'lcp-big',
      confidence: 0.85,
      impactReduction: { metric: 'LCP', valueMs: 1200 },
      evidence: [{ kind: 'cwv-attribution', data: { target: 'img.hero.big' } }],
      patches: { preloads: [{ href: '/hero-big.jpg', as: 'image', fetchpriority: 'high' }] },
    }),
    mkFinding({
      id: 'lcp-small',
      confidence: 0.85,
      impactReduction: { metric: 'LCP', valueMs: 200 },
      evidence: [{ kind: 'cwv-attribution', data: { target: 'img.hero.small' } }],
      patches: { preloads: [{ href: '/hero-small.jpg', as: 'image', fetchpriority: 'high' }] },
    }),
    mkFinding({ id: 'rejected', status: 'rejected' }),
    mkFinding({ id: 'nopatch', patches: {} }),
    mkFinding({ id: 'lowconf', confidence: 0.3 }),
  ]);
  const out = rank(e, { minConfidence: 0.5 });
  assert(out.candidates.length === 2, `got ${out.candidates.length}`);
  assert(out.candidates[0].id === 'lcp-big', `first=${out.candidates[0].id}`);
  assert(out.candidates[1].id === 'lcp-small');
  assert(out.sourceFindings === 5);
  assert(out.dropped === 3);
  assert(out.url === 'https://example.test/');
});

test('rank: zero candidates after filtering', () => {
  const e = mkEnvelope([
    mkFinding({ id: 'a', status: 'rejected' }),
    mkFinding({ id: 'b', patches: {} }),
  ]);
  const out = rank(e, { minConfidence: 0.5 });
  assert(out.candidates.length === 0);
  assert(out.dropped === 2);
});

test('rank: url override takes precedence over envelope.url', () => {
  const e = mkEnvelope([mkFinding()]);
  const out = rank(e, { url: 'https://other.test/' });
  assert(out.url === 'https://other.test/');
});

test('rank: accepts bare array of findings', () => {
  const out = rank([mkFinding()], {});
  assert(out.candidates.length === 1);
  assert(out.sourceFindings === 1);
});

test('rank: output is deterministic — same input → identical candidate order', () => {
  const e = mkEnvelope([
    mkFinding({ id: 'c', confidence: 0.8, impactReduction: { metric: 'LCP', valueMs: 400 } }),
    mkFinding({ id: 'a', confidence: 0.8, impactReduction: { metric: 'LCP', valueMs: 400 } }),
    mkFinding({ id: 'b', confidence: 0.8, impactReduction: { metric: 'LCP', valueMs: 400 } }),
  ]);
  const r1 = rank(e, {});
  const r2 = rank(e, {});
  assert(r1.candidates.map((c) => c.id).join(',') === r2.candidates.map((c) => c.id).join(','));
  assert(r1.candidates[0].id === 'a', `first=${r1.candidates[0].id}`);
});

test('deriveStructuralGate: summarizes failing EDS structural findings', () => {
  const gate = deriveStructuralGate([mkStructuralFinding()]);
  assert(gate.result === 'fail', `got ${JSON.stringify(gate)}`);
  assert(gate.sourceFindingIds.includes('diagnose-eds-structure-1'));
  assert(gate.reasons.some((reason) => /meaningful section/.test(reason)));
});

test('deriveStructuralGate: preserves clean EDS pass from analyzer metadata', () => {
  const env = mkEnvelope([]);
  env.meta = {
    structuralGate: {
      name: 'eds-structural-contract',
      result: 'pass',
      reasons: [],
    },
  };
  const gate = deriveStructuralGate(env);
  assert(gate.result === 'pass', `got ${JSON.stringify(gate)}`);
});

test('applyStructuralGateToCandidates: marks CLS style shims as probe-only when EDS gate fails', () => {
  const gate = deriveStructuralGate([mkStructuralFinding()]);
  const candidate = findingToCandidate(mkFinding({
    id: 'diagnose-cls-shim',
    metric: ['CLS'],
    confidence: 0.85,
    impactReduction: { metric: 'CLS', score: 0.2 },
    patches: { markup: [{ selector: '.tabs', attrs: { style: 'min-height: 900px' } }] },
  }), 0.5);

  const out = applyStructuralGateToCandidates([candidate], gate);

  assert(out[0].probeOnly === true, 'CLS style shim should be probe-only');
  assert(out[0].promotionBlocked === true, 'CLS style shim should block promotion');
  assert(out[0].originalConfidence === 0.85);
  assert(out[0].confidence <= 0.49, `confidence should be capped below promotion threshold, got ${out[0].confidence}`);
  assert(out[0].rankScore < candidate.rankScore, 'rankScore should be recomputed after confidence cap');
});

test('rank: failing structural gate is attached to output and selector-only CLS candidates', () => {
  const env = mkEnvelope([
    mkStructuralFinding(),
    mkFinding({
      id: 'diagnose-cls-shim',
      metric: ['CLS'],
      impactReduction: { metric: 'CLS', score: 0.2 },
      patches: { markup: [{ selector: '.tabs', attrs: { style: 'min-height: 900px' } }] },
    }),
    mkFinding({
      id: 'diagnose-lcp-preload',
      metric: ['LCP'],
      impactReduction: { metric: 'LCP', valueMs: 800 },
      patches: { preloads: [{ href: '/hero.jpg', as: 'image' }] },
    }),
  ]);

  const out = rank(env, { minConfidence: 0.5 });

  assert(out.structuralGate.result === 'fail');
  const shim = out.candidates.find((candidate) => candidate.id === 'diagnose-cls-shim');
  const preload = out.candidates.find((candidate) => candidate.id === 'diagnose-lcp-preload');
  assert(shim.probeOnly === true, 'CLS shim should be probe-only');
  assert(preload.probeOnly !== true, 'LCP preload should not be probe-only');
});

test('rank: clean structural pass from metadata is attached and does not block CLS candidates', () => {
  const env = mkEnvelope([
    mkFinding({
      id: 'diagnose-cls-shim',
      metric: ['CLS'],
      impactReduction: { metric: 'CLS', score: 0.2 },
      patches: { markup: [{ selector: '.tabs', attrs: { style: 'min-height: 900px' } }] },
    }),
  ]);
  env.meta = {
    structuralGate: {
      name: 'eds-structural-contract',
      result: 'pass',
      reasons: [],
    },
  };

  const out = rank(env, { minConfidence: 0.5 });

  assert(out.structuralGate.result === 'pass', `got ${JSON.stringify(out.structuralGate)}`);
  assert(out.candidates[0].probeOnly !== true, 'passing gate should not make CLS candidate probe-only');
});

// ---------------------------------------------------------------------------
// inferInterventionType
// ---------------------------------------------------------------------------

test('inferInterventionType: markup name=fetchpriority → fetchpriority', () => {
  const t = inferInterventionType({ markup: [{ selector: 'img', action: 'setAttribute', name: 'fetchpriority', value: 'high' }] });
  assert(t === 'fetchpriority', `got ${t}`);
});

test('inferInterventionType: markup attrs.fetchpriority (new emitter shape) → fetchpriority', () => {
  const t = inferInterventionType({ markup: [{ selector: 'img', attrs: { fetchpriority: 'high' } }] });
  assert(t === 'fetchpriority', `got ${t}`);
});

test('inferInterventionType: markup attr=defer (alt field name) → defer', () => {
  const t = inferInterventionType({ markup: [{ selector: 'script', action: 'setAttribute', attr: 'defer', value: 'true' }] });
  assert(t === 'defer', `got ${t}`);
});

test('inferInterventionType: preloads → preload', () => {
  const t = inferInterventionType({ preloads: [{ href: '/a.jpg', as: 'image' }] });
  assert(t === 'preload', `got ${t}`);
});

test('inferInterventionType: loading attr → loading', () => {
  const t = inferInterventionType({ markup: [{ selector: 'img', name: 'loading', value: 'lazy' }] });
  assert(t === 'loading', `got ${t}`);
});

test('inferInterventionType: unknown → other:action:name fallback', () => {
  const t = inferInterventionType({ markup: [{ selector: 'div', action: 'injectMeta', name: 'viewport' }] });
  assert(t === 'other:injectMeta:viewport', `got ${t}`);
});

test('inferInterventionType: empty/null → null', () => {
  assert(inferInterventionType(null) === null);
  assert(inferInterventionType({}) === null);
  assert(inferInterventionType({ markup: [] }) === null);
});

// ---------------------------------------------------------------------------
// extractCanonicalUrls
// ---------------------------------------------------------------------------

test('extractCanonicalUrls: resource-timing evidence URL', () => {
  const f = mkFinding({
    evidence: [
      { kind: 'resource-timing', data: { url: 'https://x.com/a.jpg?b=2&a=1', type: 'img' } },
    ],
    // Override default patches so only evidence URL is extracted.
    patches: { markup: [{ selector: 'img', name: 'fetchpriority', value: 'high' }] },
  });
  const urls = extractCanonicalUrls(f);
  assert(urls.includes('https://x.com/a.jpg?a=1&b=2'), `expected canonical in ${JSON.stringify(urls)}`);
});

test('extractCanonicalUrls: pulls from patches.markup selector', () => {
  const f = mkFinding({
    evidence: [],
    patches: { markup: [{ selector: "img[src='https://x.com/a.jpg']", attrs: { fetchpriority: 'high' } }] },
  });
  const urls = extractCanonicalUrls(f);
  assert(urls.includes('https://x.com/a.jpg'), `got ${urls}`);
});

test('extractCanonicalUrls: decodes &#x26; in evidence match', () => {
  const f = mkFinding({
    evidence: [
      { kind: 'rule-violation', data: { match: 'https://x.com/a.jpg?width=750&#x26;format=webply', ruleId: 'r' } },
    ],
    patches: { markup: [{ selector: 'img', name: 'fetchpriority', value: 'high' }] },
  });
  const urls = extractCanonicalUrls(f);
  assert(urls.some((u) => u.includes('format=webply')), `got ${urls}`);
  assert(!urls.some((u) => u.includes('&#x26;')), 'entities should be decoded');
});

test('extractCanonicalUrls: relative resolved against finding.url', () => {
  const f = mkFinding({
    url: 'https://pets.example.com/',
    evidence: [
      { kind: 'resource-timing', data: { url: './media_abc.jpg?width=750&#x26;format=jpg' } },
    ],
  });
  const urls = extractCanonicalUrls(f);
  assert(urls[0].startsWith('https://pets.example.com/'), `got ${urls[0]}`);
});

test('extractCanonicalUrls: patch URLs beat contextual attribution URLs', () => {
  const lcpUrl = 'https://cdn.example.test/hero.avif';
  const fontUrl = 'https://www.example.test/fonts/brand.woff2';
  const f = mkFinding({
    evidence: [
      { kind: 'cwv-attribution', metric: 'LCP', data: { url: lcpUrl, target: null } },
      { kind: 'resource-timing', data: { url: fontUrl, type: 'font' } },
    ],
    patches: { preloads: [{ href: fontUrl, as: 'font', crossorigin: 'anonymous' }] },
  });
  const urls = extractCanonicalUrls(f);
  assert(urls.length === 1, `expected only patch URL, got ${JSON.stringify(urls)}`);
  assert(urls[0] === fontUrl, `expected ${fontUrl}, got ${urls[0]}`);
});

// ---------------------------------------------------------------------------
// extractAttributionTargets
// ---------------------------------------------------------------------------

test('extractAttributionTargets: pulls non-null targets', () => {
  const f = mkFinding({
    evidence: [
      { kind: 'cwv-attribution', metric: 'LCP', data: { target: 'img.hero' } },
      { kind: 'cwv-attribution', metric: 'LCP', data: { target: null } },
    ],
  });
  const t = extractAttributionTargets(f);
  assert(t.length === 1);
  assert(t[0] === 'img.hero');
});

test('extractAttributionTargets: empty for findings without cwv-attribution', () => {
  const f = mkFinding({ evidence: [{ kind: 'resource-timing', data: { url: 'https://x.com/a' } }] });
  assert(extractAttributionTargets(f).length === 0);
});

// ---------------------------------------------------------------------------
// dedupeCandidates — core cases
// ---------------------------------------------------------------------------

function mkDedupFindings({ url1, url2, intervention1, intervention2, id1 = 'a', id2 = 'b', conf1 = 0.8, conf2 = 0.6, target1, target2 }) {
  const mkPatch = (iv, url) => {
    if (iv === 'fetchpriority') return { markup: [{ selector: `img[src="${url}"]`, name: 'fetchpriority', value: 'high' }] };
    if (iv === 'preload') return { preloads: [{ href: url, as: 'image' }] };
    if (iv === 'loading') return { markup: [{ selector: `img[src="${url}"]`, name: 'loading', value: 'lazy' }] };
    return { markup: [{ selector: `img[src="${url}"]`, name: 'fetchpriority', value: 'high' }] };
  };
  const mkEv = (url, tgt) => {
    const ev = [{ kind: 'resource-timing', data: { url } }];
    if (tgt) ev.push({ kind: 'cwv-attribution', metric: 'LCP', data: { target: tgt } });
    return ev;
  };
  return [
    mkFinding({ id: id1, confidence: conf1, evidence: mkEv(url1, target1), patches: mkPatch(intervention1, url1) }),
    mkFinding({ id: id2, confidence: conf2, evidence: mkEv(url2, target2), patches: mkPatch(intervention2, url2) }),
  ];
}

test('dedupeCandidates: same canonical URL + same intervention → merged', () => {
  const findings = mkDedupFindings({
    url1: 'https://x.com/a.jpg?b=2&a=1',
    url2: 'https://x.com/a.jpg?a=1&b=2',
    intervention1: 'fetchpriority',
    intervention2: 'fetchpriority',
  });
  const cands = findings.map((f) => findingToCandidate(f, 0.5));
  const out = dedupeCandidates(cands, findings);
  assert(out.length === 1, `expected 1 candidate, got ${out.length}`);
  assert(out[0].id === 'a', `expected kept=a, got ${out[0].id}`);
  assert(out[0].relatedFindingIds.includes('b'), `related missing b: ${JSON.stringify(out[0].relatedFindingIds)}`);
  assert(Array.isArray(out[0].mergedSources));
});

test('dedupeCandidates: same URL, DIFFERENT interventions → both kept', () => {
  const findings = mkDedupFindings({
    url1: 'https://x.com/a.jpg',
    url2: 'https://x.com/a.jpg',
    intervention1: 'fetchpriority',
    intervention2: 'preload',
  });
  const cands = findings.map((f) => findingToCandidate(f, 0.5));
  const out = dedupeCandidates(cands, findings);
  assert(out.length === 2, `expected 2, got ${out.length}`);
});

test('dedupeCandidates: different canonical URLs, same intervention → both kept', () => {
  const findings = mkDedupFindings({
    url1: 'https://x.com/a.jpg',
    url2: 'https://x.com/b.jpg',
    intervention1: 'fetchpriority',
    intervention2: 'fetchpriority',
  });
  const cands = findings.map((f) => findingToCandidate(f, 0.5));
  const out = dedupeCandidates(cands, findings);
  assert(out.length === 2, `expected 2, got ${out.length}`);
});

test('dedupeCandidates: same contextual LCP URL but different preload hrefs → both kept', () => {
  const lcpUrl = 'https://cdn.example.test/hero.avif';
  const mk = (id, href, valueMs) => mkFinding({
    id,
    evidence: [
      { kind: 'cwv-attribution', metric: 'LCP', data: { url: lcpUrl, target: null } },
      { kind: 'resource-timing', data: { url: href, type: 'font' } },
    ],
    patches: { preloads: [{ href, as: 'font', crossorigin: 'anonymous' }] },
    impactReduction: { metric: 'LCP', valueMs },
  });
  const findings = [
    mk('font-a', 'https://www.example.test/fonts/a.woff2', 1200),
    mk('font-b', 'https://www.example.test/fonts/b.woff2', 1300),
  ];
  const cands = findings.map((f) => findingToCandidate(f, 0.5));
  const out = dedupeCandidates(cands, findings);
  assert(out.length === 2, `expected 2, got ${out.length}`);
});

test('dedupeCandidates: the pets-site case case — format=webply vs format=jpg → NOT merged by URL (documented gotcha)', () => {
  const findings = mkDedupFindings({
    url1: 'https://pets.example.com/media_1a26.jpg?width=750&format=webply&optimize=medium',
    url2: './media_1a26.jpg?width=750&#x26;format=jpg&#x26;optimize=medium',
    intervention1: 'fetchpriority',
    intervention2: 'fetchpriority',
  });
  for (const f of findings) f.url = 'https://pets.example.com/';
  const cands = findings.map((f) => findingToCandidate(f, 0.5));
  const out = dedupeCandidates(cands, findings);
  assert(out.length === 2, `webply and jpg are distinct resources — got ${out.length} merged`);
});

test('dedupeCandidates: the pets-site case case — BUT same attribution.target → merged', () => {
  const findings = mkDedupFindings({
    url1: 'https://pets.example.com/media_1a26.jpg?width=750&format=webply&optimize=medium',
    url2: './media_1a26.jpg?width=750&#x26;format=jpg&#x26;optimize=medium',
    intervention1: 'fetchpriority',
    intervention2: 'fetchpriority',
    target1: 'div.hero-banner>picture>img',
    target2: 'div.hero-banner>picture>img',
  });
  for (const f of findings) f.url = 'https://pets.example.com/';
  const cands = findings.map((f) => findingToCandidate(f, 0.5));
  const out = dedupeCandidates(cands, findings);
  assert(out.length === 1, `attribution.target should merge — got ${out.length}`);
  assert(out[0].relatedFindingIds.includes('b'));
});

test('dedupeCandidates: candidate without URL or target → passes through', () => {
  const f1 = mkFinding({ id: 'a', evidence: [], patches: { markup: [{ action: 'injectMeta', name: 'viewport', content: 'width=device-width' }] } });
  const f2 = mkFinding({ id: 'b', evidence: [], patches: { markup: [{ action: 'injectMeta', name: 'viewport', content: 'width=device-width' }] } });
  const cands = [findingToCandidate(f1, 0.5), findingToCandidate(f2, 0.5)];
  const out = dedupeCandidates(cands, [f1, f2]);
  // No URL/target match keys → no merge.
  assert(out.length === 2, `expected 2, got ${out.length}`);
});

test('dedupeCandidates: keeper is highest rankScore', () => {
  // id "z" has confidence 0.9 (higher rankScore); id "a" has 0.6.
  const findings = mkDedupFindings({
    url1: 'https://x.com/a.jpg',
    url2: 'https://x.com/a.jpg',
    intervention1: 'fetchpriority',
    intervention2: 'fetchpriority',
    id1: 'a', conf1: 0.6,
    id2: 'z', conf2: 0.9,
  });
  const cands = findings.map((f) => findingToCandidate(f, 0.5));
  const out = dedupeCandidates(cands, findings);
  assert(out.length === 1);
  assert(out[0].id === 'z', `keeper should be higher-rank z, got ${out[0].id}`);
  assert(out[0].relatedFindingIds.includes('a'));
});

// ---------------------------------------------------------------------------
// sourceTierOf + source-tier precedence in dedup (Rule 5a) — ROADMAP #2
// ---------------------------------------------------------------------------

test('sourceTierOf: field=1, lab=2, static=3, speculative=4, unknown sorts last', () => {
  assert(sourceTierOf({ source: 'rum' }) === 1);
  assert(sourceTierOf({ source: 'crux' }) === 1);
  assert(sourceTierOf({ source: 'har' }) === 2);
  assert(sourceTierOf({ source: 'perf_observer' }) === 2);
  assert(sourceTierOf({ source: 'html' }) === 3);
  assert(sourceTierOf({ source: 'code' }) === 4);
  assert(sourceTierOf({ source: null }) === 99);
  assert(sourceTierOf({}) === 99);
});

test('sourceTierOf: best (lowest) tier across source + mergedSources', () => {
  // A lab-primary finding that already absorbed a field source counts as field.
  assert(sourceTierOf({ source: 'har', mergedSources: ['har', 'rum'] }) === 1);
});

// The core of #2: a RUM/field finding must keep the merge slot over a higher-
// rankScore lab finding on the same resource — field is ground truth for "users
// feel this." Pre-fix, the lab finding (higher rankScore) won and the RUM one
// was folded away, contradicting the documented Rule 5a.
test('dedupeCandidates: field (rum) finding supersedes higher-rankScore lab finding on same URL', () => {
  const url = 'https://x.com/hero.jpg';
  const mk = (id, source, conf, valueMs) => mkFinding({
    id, source, confidence: conf,
    evidence: [{ kind: 'resource-timing', data: { url } }],
    patches: { markup: [{ selector: `img[src="${url}"]`, name: 'fetchpriority', value: 'high' }] },
    impactReduction: { metric: 'LCP', valueMs },
  });
  const lab = mk('wf-lcp-1', 'perf_observer', 0.85, 2000); // rankScore 1700 (higher)
  const field = mk('rum-lcp-1', 'rum', 0.7, 500);          // rankScore 350  (lower, but tier 1)
  const findings = [lab, field];
  const cands = findings.map((f) => findingToCandidate(f, 0.5));
  const out = dedupeCandidates(cands, findings);
  assert(out.length === 1, `expected 1, got ${out.length}`);
  assert(out[0].id === 'rum-lcp-1', `field finding must keep the slot, got ${out[0].id}`);
  assert(out[0].relatedFindingIds.includes('wf-lcp-1'), 'lab id folded into relatedFindingIds');
  assert(out[0].mergedSources.includes('perf_observer'), 'lab source folded into mergedSources');
});

test('dedupeCandidates: within the same tier, rankScore still decides (no tier regression)', () => {
  const url = 'https://x.com/hero.jpg';
  const mk = (id, conf, valueMs) => mkFinding({
    id, source: 'har', confidence: conf,
    evidence: [{ kind: 'resource-timing', data: { url } }],
    patches: { markup: [{ selector: `img[src="${url}"]`, name: 'fetchpriority', value: 'high' }] },
    impactReduction: { metric: 'LCP', valueMs },
  });
  const lo = mk('lo', 0.6, 1000); // rankScore 600
  const hi = mk('hi', 0.9, 1000); // rankScore 900
  const findings = [lo, hi];
  const cands = findings.map((f) => findingToCandidate(f, 0.5));
  const out = dedupeCandidates(cands, findings);
  assert(out.length === 1);
  assert(out[0].id === 'hi', `same tier → highest rankScore kept, got ${out[0].id}`);
});

// ---------------------------------------------------------------------------
// rank() end-to-end with dedup
// ---------------------------------------------------------------------------

test('rank: end-to-end dedup merges duplicate candidates', () => {
  const findings = mkDedupFindings({
    url1: 'https://x.com/a.jpg?b=2&a=1',
    url2: 'https://x.com/a.jpg?a=1&b=2',
    intervention1: 'fetchpriority',
    intervention2: 'fetchpriority',
  });
  const env = mkEnvelope(findings);
  const out = rank(env, { minConfidence: 0.5 });
  assert(out.candidates.length === 1, `got ${out.candidates.length}`);
  assert(out.mergedDuplicates === 1, `got mergedDuplicates=${out.mergedDuplicates}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) {
  for (const f of failed) process.stdout.write(`  FAIL: ${f.name} — ${f.detail}\n`);
  process.exit(1);
}
process.exit(0);
