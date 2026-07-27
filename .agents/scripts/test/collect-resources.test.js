import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const script = fs.readFileSync(path.resolve('.agents/scripts/collect-resources.js'), 'utf8');

function sameRealm(value) {
  return JSON.parse(JSON.stringify(value));
}

function runResourceScript({ resources = [], navigation = [], lcpEntries = [] } = {}) {
  const observers = [];
  class FakePerformanceObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      observers.push(this);
    }

    observe(options) {
      this.observed.push(options);
    }

    emit(entries) {
      this.callback({ getEntries: () => entries });
    }
  }

  const context = {
    window: {},
    location: { href: 'https://www.example.com/page.html' },
    URL,
    PerformanceObserver: FakePerformanceObserver,
    performance: {
      getEntriesByType: (type) => {
        if (type === 'resource') return resources;
        if (type === 'navigation') return navigation;
        return [];
      },
    },
  };
  vm.runInNewContext(script, context);

  for (const observer of observers) {
    const type = observer.observed[0] && observer.observed[0].type;
    if (type === 'largest-contentful-paint' && lcpEntries.length) observer.emit(lcpEntries);
  }

  return sameRealm(context.window.__resources_snapshot());
}

function resource(overrides = {}) {
  return {
    name: overrides.name || 'https://www.example.com/app.js',
    initiatorType: overrides.initiatorType || 'script',
    transferSize: overrides.transferSize ?? 12345,
    encodedBodySize: overrides.encodedBodySize ?? 10000,
    decodedBodySize: overrides.decodedBodySize ?? 20000,
    duration: overrides.duration ?? 300,
    renderBlockingStatus: overrides.renderBlockingStatus || 'non-blocking',
    fetchPriority: overrides.fetchPriority || 'High',
    priority: overrides.priority || null,
    startTime: overrides.startTime ?? 100,
    requestStart: overrides.requestStart ?? 120,
    responseStart: overrides.responseStart ?? 260,
    responseEnd: overrides.responseEnd ?? 400,
    nextHopProtocol: overrides.nextHopProtocol || 'h2',
    serverTiming: overrides.serverTiming,
  };
}

test('collect-resources maps serverTiming and ttfb on resource entries', () => {
  const snapshot = runResourceScript({
    resources: [
      resource({
        name: 'https://www.example.com/styles.css',
        initiatorType: 'link',
        requestStart: 50,
        responseStart: 175.8,
        serverTiming: [
          { name: 'cdn-cache', duration: 12.4, description: 'HIT' },
          { name: 'edge', duration: 3 },
        ],
      }),
    ],
  });

  assert.equal(snapshot.total, 1);
  assert.deepEqual(snapshot.all[0].serverTiming, [
    { name: 'cdn-cache', duration: 12, description: 'HIT' },
    { name: 'edge', duration: 3, description: null },
  ]);
  assert.equal(snapshot.all[0].ttfb, 126);
});

test('collect-resources derives http1 and cdnCacheMiss buckets', () => {
  const http1 = resource({
    name: 'https://www.example.com/blocking.css',
    initiatorType: 'link',
    renderBlockingStatus: 'blocking',
    nextHopProtocol: 'http/1.1',
    startTime: 100,
  });
  const miss = resource({
    name: 'https://www.example.com/api.json',
    initiatorType: 'fetch',
    nextHopProtocol: 'h2',
    serverTiming: [{ name: 'cdn-cache', duration: 20, description: 'MISS from edge' }],
    startTime: 200,
  });
  const stale = resource({
    name: 'https://www.example.com/stale.json',
    initiatorType: 'fetch',
    nextHopProtocol: 'h3',
    serverTiming: [{ name: 'cache-status', duration: 1, description: 'stale; fwd=uri-miss' }],
    startTime: 300,
  });
  const hit = resource({
    name: 'https://www.example.com/hit.json',
    initiatorType: 'fetch',
    serverTiming: [{ name: 'cdn-cache', duration: 1, description: 'HIT' }],
    startTime: 400,
  });

  const snapshot = runResourceScript({ resources: [http1, miss, stale, hit] });

  assert.deepEqual(snapshot.http1.map((r) => r.url), ['https://www.example.com/blocking.css']);
  assert.deepEqual(snapshot.cdnCacheMiss.map((r) => r.url), [
    'https://www.example.com/api.json',
    'https://www.example.com/stale.json',
  ]);
});

test('collect-resources includes navigation timing for document cache misses', () => {
  const nav = resource({
    name: 'https://www.example.com/page.html',
    initiatorType: 'navigation',
    requestStart: 10,
    responseStart: 910,
    startTime: 0,
    nextHopProtocol: 'h2',
    serverTiming: [{ name: 'cdn-cache', duration: 0, description: 'MISS from edge' }],
  });
  nav.entryType = 'navigation';

  const snapshot = runResourceScript({ navigation: [nav] });

  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.all[0].type, 'navigation');
  assert.equal(snapshot.all[0].ttfb, 900);
  assert.deepEqual(snapshot.cdnCacheMiss.map((r) => r.url), ['https://www.example.com/page.html']);
});

test('collect-resources handles missing serverTiming and unavailable request timing', () => {
  const snapshot = runResourceScript({
    resources: [
      resource({
        name: 'https://cdn.example.net/third-party.js',
        requestStart: 0,
        responseStart: 0,
        serverTiming: undefined,
        nextHopProtocol: '',
      }),
    ],
  });

  assert.equal(snapshot.all[0].serverTiming, null);
  assert.equal(snapshot.all[0].ttfb, null);
  assert.deepEqual(snapshot.cdnCacheMiss, []);
});
