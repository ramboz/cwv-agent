import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const script = fs.readFileSync(path.resolve('.agents/scripts/collect-fonts.js'), 'utf8');

function sameRealm(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeFontFace(overrides = {}) {
  return {
    family: overrides.family || 'Brand Sans',
    style: overrides.style || 'normal',
    weight: overrides.weight || '400',
    stretch: overrides.stretch || 'normal',
    display: overrides.display,
    unicodeRange: overrides.unicodeRange || 'U+000-5FF',
    featureSettings: overrides.featureSettings || 'normal',
    ascentOverride: overrides.ascentOverride,
    descentOverride: overrides.descentOverride,
    lineGapOverride: overrides.lineGapOverride,
    sizeAdjust: overrides.sizeAdjust,
    status: overrides.status || 'loaded',
  };
}

function runCollector({
  faces = [],
  ready = Promise.resolve(),
  hasFonts = true,
  selectors = {},
} = {}) {
  const querySelector = (selector) => (selectors[selector] ? { selector } : null);
  const document = {
    querySelector,
    body: selectors.body ? { selector: 'body' } : null,
  };
  if (hasFonts) {
    document.fonts = {
      ready,
      [Symbol.iterator]: function* iterator() {
        yield* faces;
      },
    };
  }

  const context = {
    window: {},
    document,
    Promise,
    setTimeout,
    clearTimeout,
    Array,
    Object,
    String,
    Number,
    RegExp,
    getComputedStyle: (el) => ({
      fontFamily: selectors[el.selector] || '',
    }),
  };
  vm.runInNewContext(script, context);
  return context.window.__fonts_snapshot();
}

test('collect-fonts normalizes descriptors and counts swap-risk faces', async () => {
  const snapshot = sameRealm(await runCollector({
    faces: [
      makeFontFace({
        family: '"Brand Sans"',
        display: 'swap',
        ascentOverride: '92%',
        descentOverride: '24%',
        lineGapOverride: '0%',
        sizeAdjust: '101%',
      }),
      makeFontFace({
        family: 'Utility Icons',
        display: 'optional',
        status: 'unloaded',
      }),
      makeFontFace({
        family: 'Auto Face',
        display: '',
      }),
    ],
    selectors: {
      body: 'Brand Sans, Arial, sans-serif',
      h1: 'Brand Sans, Arial, sans-serif',
      p: 'Georgia, serif',
    },
  }));

  assert.equal(snapshot.count, 3);
  assert.equal(snapshot.loaded, 2);
  assert.equal(snapshot.swapRisk, 2);
  assert.deepEqual(snapshot.faces[0], {
    family: 'Brand Sans',
    style: 'normal',
    weight: '400',
    stretch: 'normal',
    display: 'swap',
    unicodeRange: 'U+000-5FF',
    featureSettings: 'normal',
    ascentOverride: '92%',
    descentOverride: '24%',
    lineGapOverride: '0%',
    sizeAdjust: '101%',
    status: 'loaded',
  });
  assert.equal(snapshot.faces[1].display, 'optional');
  assert.equal(snapshot.faces[2].display, null);
  assert.equal(snapshot.usedFonts.h1, 'Brand Sans, Arial, sans-serif');
  assert.equal(snapshot.usedFonts.body, 'Brand Sans, Arial, sans-serif');
  assert.equal(snapshot.usedFonts.p, 'Georgia, serif');
  assert.equal(snapshot.usedFonts.h2, null);
});

test('collect-fonts returns usedFonts when FontFaceSet is unsupported', async () => {
  const snapshot = sameRealm(await runCollector({
    hasFonts: false,
    selectors: {
      body: 'system-ui, sans-serif',
      button: 'system-ui, sans-serif',
    },
  }));

  assert.equal(snapshot.count, 0);
  assert.equal(snapshot.loaded, 0);
  assert.equal(snapshot.swapRisk, 0);
  assert.deepEqual(snapshot.faces, []);
  assert.equal(snapshot.usedFonts.body, 'system-ui, sans-serif');
  assert.equal(snapshot.usedFonts.button, 'system-ui, sans-serif');
});

test('collect-fonts caps document.fonts.ready wait', async () => {
  const started = Date.now();
  const snapshot = sameRealm(await runCollector({
    ready: new Promise(() => {}),
    faces: [makeFontFace({ display: 'auto' })],
    selectors: { h1: 'Brand Sans, Arial, sans-serif' },
  }));
  const elapsed = Date.now() - started;

  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.swapRisk, 1);
  assert.ok(elapsed < 1500, `snapshot waited ${elapsed}ms`);
});
