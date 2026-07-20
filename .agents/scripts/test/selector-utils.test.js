#!/usr/bin/env node

/**
 * Tests for selector-utils.js — shared CSS attribute-selector escaping
 * helper used by every analyzer that builds `[attr="..."]` selectors.
 */

import { cssEscapeAttrValue } from '../selector-utils.js';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}\n`);
}
function test(name, fn) {
  try { fn(); record(name, true); }
  catch (err) { record(name, false, err && err.message); }
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

test('plain URL untouched', () => {
  assertEq(cssEscapeAttrValue('/foo/bar.jpg'), '/foo/bar.jpg');
});

test('URL with query params untouched', () => {
  assertEq(
    cssEscapeAttrValue('https://cdn.example.com/img.jpg?w=200&h=100'),
    'https://cdn.example.com/img.jpg?w=200&h=100',
  );
});

test('double quote is backslash-escaped', () => {
  assertEq(cssEscapeAttrValue('a"b'), 'a\\"b');
});

test('backslash is doubled', () => {
  assertEq(cssEscapeAttrValue('a\\b'), 'a\\\\b');
});

test('backslash before quote: backslash escaped first, then quote', () => {
  // Input `a\"b` → after escaping \ first: `a\\"b` → after escaping ": `a\\\"b`.
  // When used inside `[attr="..."]` this is valid CSS.
  assertEq(cssEscapeAttrValue('a\\"b'), 'a\\\\\\"b');
});

test('null returns empty string', () => {
  assertEq(cssEscapeAttrValue(null), '');
});

test('undefined returns empty string', () => {
  assertEq(cssEscapeAttrValue(undefined), '');
});

test('number coerced to string', () => {
  assertEq(cssEscapeAttrValue(42), '42');
});

test('empty string returns empty string', () => {
  assertEq(cssEscapeAttrValue(''), '');
});

test('selector-embedded value is valid CSS', () => {
  // Simulates runtime use: URL containing `"` must still parse as a valid
  // CSS attribute selector.
  const url = 'https://example.com/x?q="unsafe"';
  const selector = `img[src="${cssEscapeAttrValue(url)}"]`;
  assertEq(selector, 'img[src="https://example.com/x?q=\\"unsafe\\""]');
  // Sanity check: round-trip through a minimal parser.
  // We only assert the quote escapes are present; real CSS parsing is the
  // applier's job.
  const inside = selector.slice(selector.indexOf('"') + 1, selector.lastIndexOf('"'));
  // The inner string should contain escaped quotes, not raw ones.
  // (Counting raw `"` instances: zero since all are escaped.)
  const unescapedQuotes = (inside.match(/(^|[^\\])"/g) || []).length;
  if (unescapedQuotes !== 0) throw new Error(`found ${unescapedQuotes} unescaped quote(s) in selector body`);
});

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  process.stderr.write(`\n${failed.length}/${results.length} failed\n`);
  process.exit(1);
}
process.stdout.write(`\n${results.length}/${results.length} passed\n`);
