#!/usr/bin/env node

/**
 * Tests for buildMarkupMutationScript — the browser-side mutation applier
 * used by launcher.js. Canonical input shape:
 *   { selector: string, attrs: { key: string|null } }
 *
 * The applier is dispatched via `page.evaluateOnNewDocument`, so we emulate
 * the browser DOM with a tiny fake `document` + `setAttribute` / `removeAttribute`
 * implementation and eval the generated script in a VM-ish sandbox.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { buildMarkupMutationScript } from '../mutate-markup.js';

/** Build a minimal fake DOM + execute the generated script synchronously. */
function runScript(script, nodesBySelector) {
  const calls = [];
  const nodesBySel = nodesBySelector;

  function makeEl(tag) {
    const attrs = {};
    return {
      tagName: tag.toUpperCase(),
      setAttribute(k, v) { attrs[k] = String(v); calls.push({ op: 'set', k, v: String(v) }); },
      removeAttribute(k) { delete attrs[k]; calls.push({ op: 'remove', k }); },
      getAttribute(k) { return k in attrs ? attrs[k] : null; },
      get attrs() { return attrs; },
    };
  }

  // Pre-populate test nodes for each selector.
  const nodesPool = {};
  for (const [sel, tags] of Object.entries(nodesBySel)) {
    nodesPool[sel] = tags.map(makeEl);
  }

  const fakeDoc = {
    readyState: 'complete',
    querySelectorAll(sel) {
      return nodesPool[sel] || [];
    },
    addEventListener() { /* not triggered — readyState=complete */ },
  };

  const ctx = { document: fakeDoc };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);

  return { calls, nodes: nodesPool };
}

test('canonical shape: attrs.key=value calls setAttribute(key,value)', () => {
  const script = buildMarkupMutationScript([
    { selector: 'img.hero', attrs: { fetchpriority: 'high', loading: 'eager' } },
  ]);
  const { calls, nodes } = runScript(script, { 'img.hero': ['img'] });
  assert.deepEqual(
    calls.sort((a, b) => a.k.localeCompare(b.k)),
    [
      { op: 'set', k: 'fetchpriority', v: 'high' },
      { op: 'set', k: 'loading', v: 'eager' },
    ],
  );
  assert.equal(nodes['img.hero'][0].getAttribute('fetchpriority'), 'high');
  assert.equal(nodes['img.hero'][0].getAttribute('loading'), 'eager');
});

test('canonical shape: attrs.key=null calls removeAttribute(key)', () => {
  const script = buildMarkupMutationScript([
    { selector: 'img.lazy', attrs: { loading: null } },
  ]);
  const { calls } = runScript(script, { 'img.lazy': ['img'] });
  assert.deepEqual(calls, [{ op: 'remove', k: 'loading' }]);
});

test('applies to every matching element (querySelectorAll, not One)', () => {
  const script = buildMarkupMutationScript([
    { selector: 'script[defer-me]', attrs: { defer: '' } },
  ]);
  const { calls } = runScript(script, { 'script[defer-me]': ['script', 'script', 'script'] });
  assert.equal(calls.filter((c) => c.op === 'set' && c.k === 'defer').length, 3);
});

test('empty mutation list returns a harmless no-op script', () => {
  const script = buildMarkupMutationScript([]);
  // Just evaluating it in a context without a document must not throw.
  const ctx = {};
  vm.createContext(ctx);
  assert.doesNotThrow(() => vm.runInContext(script, ctx));
});
