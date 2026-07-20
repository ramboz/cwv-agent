#!/usr/bin/env node

/**
 * Tests for url-canonical.js — URL canonicalization + selector URL
 * extraction helpers used by rank-candidates.js for resource-level
 * dedup.
 */

import {
  canonicalUrl,
  urlsMatch,
  extractUrlsFromSelector,
  htmlDecode,
} from '../url-canonical.js';

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
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

// ---------------------------------------------------------------------------
// htmlDecode
// ---------------------------------------------------------------------------

test('htmlDecode: &amp; → &', () => {
  assertEq(htmlDecode('a&amp;b'), 'a&b');
});

test('htmlDecode: &#x26; → &', () => {
  assertEq(htmlDecode('a&#x26;b'), 'a&b');
});

test('htmlDecode: decimal numeric ref &#38; → &', () => {
  assertEq(htmlDecode('a&#38;b'), 'a&b');
});

test('htmlDecode: multiple refs in one string', () => {
  assertEq(htmlDecode('x=1&#x26;y=2&amp;z=3'), 'x=1&y=2&z=3');
});

test('htmlDecode: pass-through for strings without entities', () => {
  assertEq(htmlDecode('hello world'), 'hello world');
});

// ---------------------------------------------------------------------------
// canonicalUrl — basic
// ---------------------------------------------------------------------------

test('canonicalUrl: relative resolved against base', () => {
  assertEq(
    canonicalUrl('./image.jpg', 'https://example.com/page/'),
    'https://example.com/page/image.jpg',
  );
});

test('canonicalUrl: absolute URL passes through case-folded', () => {
  assertEq(
    canonicalUrl('HTTPS://EXAMPLE.COM/Page'),
    'https://example.com/Page',
  );
});

test('canonicalUrl: &amp; and &#x26; and & produce same canonical', () => {
  const a = canonicalUrl('https://x.com/a?foo=1&bar=2');
  const b = canonicalUrl('https://x.com/a?foo=1&amp;bar=2');
  const c = canonicalUrl('https://x.com/a?foo=1&#x26;bar=2');
  assertEq(a, b, 'amp vs raw');
  assertEq(a, c, 'x26 vs raw');
});

test('canonicalUrl: query param order insensitive', () => {
  assertEq(
    canonicalUrl('https://x.com/a?b=2&a=1'),
    canonicalUrl('https://x.com/a?a=1&b=2'),
  );
});

test('canonicalUrl: strips default http port 80', () => {
  assertEq(canonicalUrl('http://x.com:80/a'), 'http://x.com/a');
});

test('canonicalUrl: strips default https port 443', () => {
  assertEq(canonicalUrl('https://x.com:443/a'), 'https://x.com/a');
});

test('canonicalUrl: keeps non-default port', () => {
  assertEq(canonicalUrl('http://x.com:8080/a'), 'http://x.com:8080/a');
});

test('canonicalUrl: scheme and host lowercased, path case preserved', () => {
  assertEq(canonicalUrl('HTTPS://X.COM/Path/Name'), 'https://x.com/Path/Name');
});

test('canonicalUrl: drops fragment', () => {
  assertEq(canonicalUrl('https://x.com/a#section-1'), 'https://x.com/a');
});

test('canonicalUrl: bare-origin loses trailing slash', () => {
  assertEq(canonicalUrl('http://x.com/'), 'http://x.com');
});

test('canonicalUrl: non-bare trailing slash preserved', () => {
  assertEq(canonicalUrl('https://x.com/a/'), 'https://x.com/a/');
});

test('canonicalUrl: data: URL returned as-is', () => {
  const d = 'data:image/png;base64,ABCDEF==';
  assertEq(canonicalUrl(d), d);
});

test('canonicalUrl: parse failure falls back to raw (no throw)', () => {
  assertEq(canonicalUrl('::::not a url::::'), '::::not a url::::');
});

test('canonicalUrl: non-string returned as-is', () => {
  assertEq(canonicalUrl(null), null);
  assertEq(canonicalUrl(undefined), undefined);
});

test('canonicalUrl: path percent-decoding', () => {
  assertEq(
    canonicalUrl('https://x.com/hello%20world'),
    'https://x.com/hello%20world',
    'spaces preserved as %20',
  );
  assertEq(
    canonicalUrl('https://x.com/caf%C3%A9'),
    'https://x.com/café',
    'unicode path decoded',
  );
});

test('canonicalUrl: the pets-site case-shaped relative vs absolute with same format', () => {
  const abs = canonicalUrl(
    'https://pets.example.com/media_1a26a7465e8bcd9751e2447e462206315d58ed488.jpg?width=750&format=webply&optimize=medium',
  );
  const rel = canonicalUrl(
    './media_1a26a7465e8bcd9751e2447e462206315d58ed488.jpg?width=750&#x26;format=webply&#x26;optimize=medium',
    'https://pets.example.com/',
  );
  assertEq(abs, rel, 'relative + entities should canonicalize to the absolute form');
});

test('canonicalUrl: different format= values DO NOT match (documented gotcha)', () => {
  const webply = canonicalUrl(
    'https://pets.example.com/media_1a26.jpg?width=750&format=webply',
  );
  const jpg = canonicalUrl(
    './media_1a26.jpg?width=750&#x26;format=jpg',
    'https://pets.example.com/',
  );
  assert(webply !== jpg, 'webply and jpg are genuinely different resources');
});

// ---------------------------------------------------------------------------
// urlsMatch
// ---------------------------------------------------------------------------

test('urlsMatch: identical strings match', () => {
  assert(urlsMatch('https://x.com/a', 'https://x.com/a'));
});

test('urlsMatch: case+port+query-order equivalent match', () => {
  assert(urlsMatch('HTTPS://X.com:443/a?b=2&a=1', 'https://x.com/a?a=1&b=2'));
});

test('urlsMatch: different paths do not match', () => {
  assert(!urlsMatch('https://x.com/a', 'https://x.com/b'));
});

test('urlsMatch: non-string inputs safe (false)', () => {
  assert(!urlsMatch(null, 'https://x.com/a'));
  assert(!urlsMatch('https://x.com/a', undefined));
});

test('urlsMatch: relative + base matches absolute equivalent', () => {
  assert(urlsMatch('./a.jpg', 'https://x.com/a.jpg', 'https://x.com/'));
});

// ---------------------------------------------------------------------------
// extractUrlsFromSelector
// ---------------------------------------------------------------------------

test('extractUrlsFromSelector: img[src="..."] exact', () => {
  const out = extractUrlsFromSelector('img[src="https://x.com/a.jpg"]');
  assertEq(out.length, 1);
  assertEq(out[0].mode, 'exact');
  assertEq(out[0].url, 'https://x.com/a.jpg');
});

test('extractUrlsFromSelector: img[src=\'...\'] single-quoted exact', () => {
  const out = extractUrlsFromSelector("img[src='https://x.com/a.jpg']");
  assertEq(out.length, 1);
  assertEq(out[0].url, 'https://x.com/a.jpg');
});

test('extractUrlsFromSelector: a[href="..."] exact', () => {
  const out = extractUrlsFromSelector('a[href="/page"]');
  assertEq(out.length, 1);
  assertEq(out[0].mode, 'exact');
  assertEq(out[0].url, '/page');
});

test('extractUrlsFromSelector: prefix operator', () => {
  const out = extractUrlsFromSelector('img[src^="https://cdn."]');
  assertEq(out[0].mode, 'prefix');
  assertEq(out[0].url, 'https://cdn.');
});

test('extractUrlsFromSelector: contains operator', () => {
  const out = extractUrlsFromSelector('img[src*="hero"]');
  assertEq(out[0].mode, 'contains');
  assertEq(out[0].url, 'hero');
});

test('extractUrlsFromSelector: suffix operator', () => {
  const out = extractUrlsFromSelector('img[src$=".jpg"]');
  assertEq(out[0].mode, 'suffix');
  assertEq(out[0].url, '.jpg');
});

test('extractUrlsFromSelector: no URL attr → empty', () => {
  assertEq(extractUrlsFromSelector('div.hero').length, 0);
});

test('extractUrlsFromSelector: non-string → empty', () => {
  assertEq(extractUrlsFromSelector(null).length, 0);
  assertEq(extractUrlsFromSelector(undefined).length, 0);
});

test('extractUrlsFromSelector: the pets-site case-shaped absolute src', () => {
  const sel = "img[src='https://pets.example.com/media_1a26.jpg?width=750&format=webply&optimize=medium']";
  const out = extractUrlsFromSelector(sel);
  assertEq(out.length, 1);
  assertEq(out[0].mode, 'exact');
  assert(out[0].url.startsWith('https://pets.example.com/'));
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
