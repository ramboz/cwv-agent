import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const script = fs.readFileSync(path.resolve('.agents/scripts/measure-cwv.js'), 'utf8');

function runMeasureScript({
  supportedTypes = ['layout-shift', 'event', 'long-animation-frame', 'longtask'],
  webVitals = null,
} = {}) {
  const observers = [];
  const listeners = new Map();
  class FakePerformanceObserver {
    static supportedEntryTypes = supportedTypes;

    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      observers.push(this);
    }

    observe(options) {
      this.observed.push(options);
      if (!FakePerformanceObserver.supportedEntryTypes.includes(options.type)) {
        throw new Error(`unsupported: ${options.type}`);
      }
    }

    emit(entries) {
      this.callback({ getEntries: () => entries });
    }
  }

  const window = {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
  };
  const context = {
    window,
    PerformanceObserver: FakePerformanceObserver,
    Map,
    Array,
    Math,
    JSON,
  };
  if (webVitals) context.webVitals = webVitals;
  vm.runInNewContext(script, context);
  return { window, observers, listeners };
}

function sameRealm(value) {
  return JSON.parse(JSON.stringify(value));
}

test('measure-cwv captures LoAF and long-task entries in mainThread snapshot', () => {
  const { window, observers } = runMeasureScript();
  const byType = new Map(observers.flatMap((observer) => (
    observer.observed.map((options) => [options.type, observer])
  )));

  assert.ok(byType.has('long-animation-frame'));
  assert.ok(byType.has('longtask'));

  byType.get('long-animation-frame').emit([{
    startTime: 123.4,
    duration: 92.2,
    renderStart: 150.6,
    styleAndLayoutStart: 160.1,
    blockingDuration: 71.9,
    scripts: [{
      sourceURL: 'https://cdn.example.com/app.js',
      sourceFunctionName: 'hydrate',
      invoker: 'Window.requestAnimationFrame',
      invokerType: 'user-callback',
      duration: 64.4,
      forcedStyleAndLayoutDuration: 12.2,
      pauseDuration: 0,
    }],
  }]);

  byType.get('longtask').emit([{
    startTime: 250.9,
    duration: 105.1,
    attribution: [{
      name: 'script',
      entryType: 'taskattribution',
      containerType: 'iframe',
      containerName: 'chat',
      containerSrc: 'https://chat.example.com/embed.html',
    }],
  }]);

  const snapshot = sameRealm(window.__cwv_snapshot());
  assert.deepEqual(Object.keys(snapshot.mainThread), ['loaf', 'longTasks']);
  assert.deepEqual(snapshot.mainThread.loaf, [{
    startTime: 123,
    duration: 92,
    renderStart: 151,
    styleAndLayoutStart: 160,
    blockingDuration: 72,
    scripts: [{
      sourceURL: 'https://cdn.example.com/app.js',
      sourceFunctionName: 'hydrate',
      invoker: 'Window.requestAnimationFrame',
      invokerType: 'user-callback',
      duration: 64,
      forcedStyleAndLayoutDuration: 12,
      pauseDuration: 0,
    }],
  }]);
  assert.deepEqual(snapshot.mainThread.longTasks, [{
    startTime: 251,
    duration: 105,
    attribution: [{
      name: 'script',
      entryType: 'taskattribution',
      containerType: 'iframe',
      containerName: 'chat',
      containerSrc: 'https://chat.example.com/embed.html',
    }],
  }]);
});

test('measure-cwv normalizes LoAF entries with empty or missing scripts', () => {
  const { window, observers } = runMeasureScript();
  const byType = new Map(observers.flatMap((observer) => (
    observer.observed.map((options) => [options.type, observer])
  )));

  byType.get('long-animation-frame').emit([
    {
      startTime: 10,
      duration: 51,
      renderStart: 20,
      styleAndLayoutStart: 30,
      blockingDuration: 40,
      scripts: [],
    },
    {
      startTime: 100,
      duration: 52,
      renderStart: 110,
      styleAndLayoutStart: 120,
      blockingDuration: 41,
    },
  ]);

  assert.deepEqual(sameRealm(window.__cwv_snapshot().mainThread.loaf), [
    {
      startTime: 10,
      duration: 51,
      renderStart: 20,
      styleAndLayoutStart: 30,
      blockingDuration: 40,
      scripts: [],
    },
    {
      startTime: 100,
      duration: 52,
      renderStart: 110,
      styleAndLayoutStart: 120,
      blockingDuration: 41,
      scripts: [],
    },
  ]);
});

test('measure-cwv leaves mainThread arrays empty when LoAF is unsupported', () => {
  const { window } = runMeasureScript({ supportedTypes: ['layout-shift', 'event'] });
  assert.deepEqual(sameRealm(window.__cwv_snapshot().mainThread), { loaf: [], longTasks: [] });
});

test('measure-cwv still captures long tasks when LoAF is unsupported', () => {
  const { window, observers } = runMeasureScript({ supportedTypes: ['layout-shift', 'event', 'longtask'] });
  const byType = new Map(observers.flatMap((observer) => (
    observer.observed.map((options) => [options.type, observer])
  )));

  byType.get('longtask').emit([{
    startTime: 500,
    duration: 80,
    attribution: [{
      name: 'script',
      entryType: 'taskattribution',
      containerType: 'window',
      containerName: '',
      containerSrc: '',
    }],
  }]);

  assert.deepEqual(sameRealm(window.__cwv_snapshot().mainThread), {
    loaf: [],
    longTasks: [{
      startTime: 500,
      duration: 80,
      attribution: [{
        name: 'script',
        entryType: 'taskattribution',
        containerType: 'window',
        containerName: null,
        containerSrc: null,
      }],
    }],
  });
});

test('measure-cwv normalizes capped CSP violations on web-vitals missing path', () => {
  const { window, listeners } = runMeasureScript();
  const cspListeners = listeners.get('securitypolicyviolation') || [];
  assert.equal(cspListeners.length, 1);

  cspListeners[0]({
    violatedDirective: 'script-src-elem',
    effectiveDirective: 'script-src-elem',
    blockedURI: 'https://cdn.example.com/blocked.js',
    sourceFile: 'https://www.example.com/',
    lineNumber: 12.3,
    columnNumber: 4.8,
    disposition: 'enforce',
  });
  cspListeners[0]({
    violatedDirective: '',
    effectiveDirective: undefined,
    blockedURI: null,
    sourceFile: '',
    lineNumber: 'not-a-number',
    columnNumber: NaN,
    disposition: 'report',
  });
  for (let i = 0; i < 60; i += 1) {
    cspListeners[0]({
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      blockedURI: `https://cdn.example.com/overflow-${i}.js`,
      sourceFile: 'https://www.example.com/',
      lineNumber: i,
      columnNumber: i,
      disposition: 'enforce',
    });
  }

  const violations = sameRealm(window.__cwv_snapshot().cspViolations);
  assert.equal(violations.length, 50);
  assert.deepEqual(violations.slice(0, 2), [
    {
      violatedDirective: 'script-src-elem',
      effectiveDirective: 'script-src-elem',
      blockedURI: 'https://cdn.example.com/blocked.js',
      sourceFile: 'https://www.example.com/',
      lineNumber: 12,
      columnNumber: 5,
      disposition: 'enforce',
    },
    {
      violatedDirective: null,
      effectiveDirective: null,
      blockedURI: null,
      sourceFile: null,
      lineNumber: null,
      columnNumber: null,
      disposition: 'report',
    },
  ]);
  assert.equal(violations[49].blockedURI, 'https://cdn.example.com/overflow-47.js');
});

test('measure-cwv includes CSP violations when web-vitals is loaded', () => {
  const webVitals = {
    onLCP(callback) { callback({ value: 1234, rating: 'good', attribution: { element: 'H1.hero' } }); },
    onCLS() {},
    onINP() {},
    onFCP() {},
    onTTFB() {},
  };
  const { window, listeners } = runMeasureScript({ webVitals });
  const cspListeners = listeners.get('securitypolicyviolation') || [];
  cspListeners[0]({
    violatedDirective: 'img-src',
    effectiveDirective: 'img-src',
    blockedURI: 'https://img.example.com/hero.webp',
    sourceFile: 'https://www.example.com/',
    lineNumber: 1,
    columnNumber: 2,
    disposition: 'report',
  });

  const snapshot = sameRealm(window.__cwv_snapshot());
  assert.equal(snapshot.lcp.value, 1234);
  assert.deepEqual(snapshot.cspViolations, [{
    violatedDirective: 'img-src',
    effectiveDirective: 'img-src',
    blockedURI: 'https://img.example.com/hero.webp',
    sourceFile: 'https://www.example.com/',
    lineNumber: 1,
    columnNumber: 2,
    disposition: 'report',
  }]);
});
