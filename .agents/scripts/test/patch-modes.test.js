import test from 'node:test';
import assert from 'node:assert/strict';

import { describePatchModes, classifyRewriteRule } from '../patches/patch-modes.js';

// ---------------------------------------------------------------------------
// Spec 016-02 — Mode A/B validate vocabulary (ADR-0016 §3)
//
// describePatchModes(bundle) maps every existing workbench patch op onto the
// ASV Mode A / Mode B vocabulary. This is a RE-LABELING function: pure, no
// measurement or interception side effects. Field names must match ASV's shape
// (`{ target, op, value }` for Mode A; `{ target, spliceKind, bytes|subtreeHtml }`
// for Mode B) so slice 016-06 maps without translation.
// ---------------------------------------------------------------------------

// --- markup: Mode A, one descriptor per attribute -------------------------

test('markup setAttribute -> Mode A { target, op:setAttribute, value }', () => {
  const bundle = {
    markup: [{ selector: 'img.hero', attrs: { fetchpriority: 'high' } }],
  };
  const modes = describePatchModes(bundle);
  assert.deepEqual(modes, [
    { mode: 'A', target: 'img.hero', op: 'setAttribute', value: 'high' },
  ]);
});

test('markup null attr -> Mode A op:removeAttribute, value:null', () => {
  const bundle = {
    markup: [{ selector: 'img.lazy', attrs: { loading: null } }],
  };
  const modes = describePatchModes(bundle);
  assert.deepEqual(modes, [
    { mode: 'A', target: 'img.lazy', op: 'removeAttribute', value: null },
  ]);
});

test('markup with multiple attrs -> one descriptor per attribute', () => {
  const bundle = {
    markup: [{ selector: 'img.hero', attrs: { fetchpriority: 'high', loading: 'eager' } }],
  };
  const modes = describePatchModes(bundle);
  assert.equal(modes.length, 2);
  assert.ok(modes.every((m) => m.mode === 'A' && m.target === 'img.hero'));
  const byValue = Object.fromEntries(modes.map((m) => [m.value, m.op]));
  assert.deepEqual(byValue, { high: 'setAttribute', eager: 'setAttribute' });
});

// --- preloads: Mode A adjacent, workbench-only ----------------------------

test('preloads -> Mode A workbenchOnly, op:preload-link-header', () => {
  const bundle = {
    preloads: [{ href: '/hero.jpg', as: 'image', fetchpriority: 'high' }],
  };
  const modes = describePatchModes(bundle);
  assert.equal(modes.length, 1);
  const d = modes[0];
  assert.equal(d.mode, 'A');
  assert.equal(d.workbenchOnly, true);
  assert.equal(d.target, 'document');
  assert.equal(d.op, 'preload-link-header');
  assert.ok(typeof d.value === 'string' && d.value.includes('/hero.jpg'));
});

// --- headers: Mode A adjacent, workbench-only -----------------------------

test('requestHeaders -> Mode A workbenchOnly, op:request-header', () => {
  const bundle = {
    requestHeaders: [{ urlPattern: '*/api/*', set: { 'x-test': '1' } }],
  };
  const modes = describePatchModes(bundle);
  assert.equal(modes.length, 1);
  const d = modes[0];
  assert.equal(d.mode, 'A');
  assert.equal(d.workbenchOnly, true);
  assert.equal(d.op, 'request-header');
  assert.equal(d.target, '*/api/*');
  assert.deepEqual(d.value, { set: { 'x-test': '1' }, append: null, remove: [] });
});

test('responseHeaders -> Mode A workbenchOnly, op:response-header (append+remove)', () => {
  const bundle = {
    responseHeaders: [{ urlPattern: '*', append: { vary: 'x' }, remove: ['cache-control'] }],
  };
  const modes = describePatchModes(bundle);
  assert.equal(modes.length, 1);
  const d = modes[0];
  assert.equal(d.mode, 'A');
  assert.equal(d.workbenchOnly, true);
  assert.equal(d.op, 'response-header');
  assert.equal(d.target, '*');
  assert.deepEqual(d.value, { set: null, append: { vary: 'x' }, remove: ['cache-control'] });
});

// --- block: Mode A adjacent, workbench-only -------------------------------

test('block -> Mode A workbenchOnly, op:block, value:glob', () => {
  const bundle = { block: ['*/osano.js', '*/gtm.js'] };
  const modes = describePatchModes(bundle);
  assert.equal(modes.length, 2);
  assert.ok(modes.every((m) => m.mode === 'A' && m.workbenchOnly === true && m.op === 'block'));
  assert.deepEqual(modes.map((m) => m.value), ['*/osano.js', '*/gtm.js']);
});

// --- rewriteBody classification: attribute-level (A) vs full-response (B) --

test('classifyRewriteRule: short find/replace, no injected block -> A', () => {
  const rule = {
    urlPattern: '*/scripts.js',
    replacements: [{ find: 'loading="lazy"', replace: 'loading="eager"' }],
  };
  assert.equal(classifyRewriteRule(rule).mode, 'A');
});

test('classifyRewriteRule: injected <style> block -> B (response)', () => {
  const rule = {
    urlPattern: '*',
    replacements: [{ find: '</head>', replace: '<style>header{min-height:80px}</style></head>' }],
  };
  const c = classifyRewriteRule(rule);
  assert.equal(c.mode, 'B');
  assert.equal(c.spliceKind, 'response');
});

test('classifyRewriteRule: large HTML chunk -> B (response)', () => {
  const bigHtml = '<div class="promo">' + 'x'.repeat(300) + '</div>';
  const rule = {
    urlPattern: '*',
    replacements: [{ find: '<!--slot-->', replace: bigHtml }],
  };
  assert.equal(classifyRewriteRule(rule).mode, 'B');
});

test('rewriteBody attribute-level -> Mode A { target, op:rewrite-attr, value }', () => {
  const bundle = {
    rewriteBody: [{
      urlPattern: '*/scripts.js',
      replacements: [{ find: 'loading="lazy"', replace: 'loading="eager"' }],
    }],
  };
  const modes = describePatchModes(bundle);
  assert.equal(modes.length, 1);
  const d = modes[0];
  assert.equal(d.mode, 'A');
  assert.equal(d.target, '*/scripts.js');
  assert.equal(d.op, 'rewrite-attr');
  assert.ok(d.value && typeof d.value === 'object');
});

test('rewriteBody full-response -> Mode B { spliceKind:response, target, bytesSummary }', () => {
  const bundle = {
    rewriteBody: [{
      urlPattern: '*',
      replacements: [{ find: '</head>', replace: '<style>header{min-height:80px}</style></head>' }],
    }],
  };
  const modes = describePatchModes(bundle);
  assert.equal(modes.length, 1);
  const d = modes[0];
  assert.equal(d.mode, 'B');
  assert.equal(d.spliceKind, 'response');
  assert.equal(d.target, '*');
  assert.ok(d.bytesSummary);
});

// --- response op (016-04): supplied-bytes Mode B response -----------------

test('response op -> Mode B { spliceKind:response, target, bytesSummary } (016-04)', () => {
  const bundle = {
    response: [{
      urlPattern: 'https://www.example.com/etc.clientlibs/example/clientlibs/clientlib-base.min.css',
      body: '.a{color:red}',
      contentType: 'text/css',
    }],
  };
  const modes = describePatchModes(bundle);
  assert.equal(modes.length, 1);
  const d = modes[0];
  assert.equal(d.mode, 'B', 'Mode B (byte injection)');
  assert.equal(d.spliceKind, 'response');
  assert.equal(d.target, bundle.response[0].urlPattern, 'target is the request urlPattern');
  assert.ok(/rebuilt clientlib bytes/i.test(d.bytesSummary), 'bytesSummary names rebuilt clientlib bytes');
  assert.ok(/~\d+\s*bytes/i.test(d.bytesSummary), 'bytesSummary carries an approximate byte count');
});

test('response op: byte count reflects utf8 body length; base64 body is decoded for the count', () => {
  const utf8 = { response: [{ urlPattern: '*/x.min.css', body: 'abcde' }] };
  const b64 = { response: [{ urlPattern: '*/x.min.css', body: Buffer.from('abcde', 'utf8').toString('base64'), encoding: 'base64' }] };
  const du = describePatchModes(utf8)[0];
  const db = describePatchModes(b64)[0];
  assert.match(du.bytesSummary, /~5\s*bytes/i, 'utf8 body length 5');
  assert.match(db.bytesSummary, /~5\s*bytes/i, 'base64 body decodes to length 5');
});

test('response op: multiple ops -> one Mode B descriptor each', () => {
  const bundle = {
    response: [
      { urlPattern: '*/clientlib-base.min.css', body: '.a{}' },
      { urlPattern: '*/clientlib-base.min.js', body: 'x' },
    ],
  };
  const modes = describePatchModes(bundle);
  assert.equal(modes.length, 2);
  assert.ok(modes.every((m) => m.mode === 'B' && m.spliceKind === 'response'));
});

// --- mixed bundle ----------------------------------------------------------

test('mixed bundle produces a descriptor per op group, order preserved', () => {
  const bundle = {
    block: ['*/ad.js'],
    preloads: [{ href: '/hero.jpg', as: 'image' }],
    markup: [{ selector: 'img.hero', attrs: { fetchpriority: 'high' } }],
    requestHeaders: [{ urlPattern: '*', set: { 'x-a': '1' } }],
    responseHeaders: [{ urlPattern: '*', remove: ['etag'] }],
    rewriteBody: [
      { urlPattern: '*/a.js', replacements: [{ find: 'a="1"', replace: 'a="2"' }] },
      { urlPattern: '*', replacements: [{ find: '</head>', replace: '<script src="/x.js"></script></head>' }] },
    ],
  };
  const modes = describePatchModes(bundle);
  const byMode = modes.reduce((acc, m) => {
    const key = m.mode + (m.spliceKind ? ':' + m.spliceKind : '');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  // block(1)+preload(1)+markup(1)+reqHdr(1)+respHdr(1)+rewrite-attr(1) = 6 Mode A
  assert.equal(byMode.A, 6);
  // one full-response rewrite = Mode B response
  assert.equal(byMode['B:response'], 1);
});

// --- empty / defensive -----------------------------------------------------

test('empty bundle -> empty descriptor array', () => {
  assert.deepEqual(describePatchModes({}), []);
  assert.deepEqual(describePatchModes(null), []);
  assert.deepEqual(describePatchModes(undefined), []);
});

test('no Mode B subtree descriptor is produced by the current bundle', () => {
  // subtree is reserved for 016-05's structural-HTL path; describePatchModes
  // over the current op set must never emit spliceKind:subtree.
  const bundle = {
    markup: [{ selector: 'x', attrs: { a: 'b' } }],
    rewriteBody: [{ urlPattern: '*', replacements: [{ find: '</head>', replace: '<style>a{}</style></head>' }] }],
  };
  const modes = describePatchModes(bundle);
  assert.ok(modes.every((m) => m.spliceKind !== 'subtree'));
});
