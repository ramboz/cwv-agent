#!/usr/bin/env node

/**
 * Sanity tests for cache.js.
 *
 * Uses a temp cache root via opts.cacheRoot / CWV_CACHE_ROOT. Prints PASS/FAIL
 * per case. Exits 0 on success, 1 on any failure.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runWithCache,
  cacheKey,
  clearCache,
} from '../cache.js';

// ---------------------------------------------------------------------------
// Temp cache root
// ---------------------------------------------------------------------------

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cwv-cache-test-'));

function cleanup() {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}\n`);
}

async function test(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (err) {
    record(name, false, err && err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

(async () => {
  await test('stable key: {a,b} === {b,a}', () => {
    assert(cacheKey({ a: 1, b: 2 }) === cacheKey({ b: 2, a: 1 }), 'keys should match');
    // Nested
    assert(
      cacheKey({ x: { p: 1, q: 2 }, y: [1, 2] }) ===
      cacheKey({ y: [1, 2], x: { q: 2, p: 1 } }),
      'nested keys should match',
    );
    // Different values produce different keys
    assert(cacheKey({ a: 1 }) !== cacheKey({ a: 2 }), 'different values should differ');
  });

  await test('miss then hit returns same result', async () => {
    let calls = 0;
    const producer = async () => { calls++; return { n: 42, at: Date.now() }; };
    const key = { url: 'https://example.com/', profile: 'mobile' };
    const a = await runWithCache({
      namespace: 'launcher', key, ttlSec: 60, producer, cacheRoot: TMP_ROOT,
    });
    assert(a.cache.hit === false, 'first call must be a miss');
    assert(calls === 1, 'producer must run exactly once');
    const b = await runWithCache({
      namespace: 'launcher', key, ttlSec: 60, producer, cacheRoot: TMP_ROOT,
    });
    assert(b.cache.hit === true, 'second call must be a hit');
    assert(calls === 1, 'producer must not run again');
    assert(JSON.stringify(a.result) === JSON.stringify(b.result), 'results must be identical');
    assert(typeof b.cache.ageSec === 'number', 'hit must report ageSec');
  });

  await test('expired entry triggers re-run', async () => {
    let calls = 0;
    const producer = async () => { calls++; return { v: calls }; };
    const key = { tag: 'expire-test' };
    const a = await runWithCache({
      namespace: 'html-parse', key, ttlSec: 1, producer, cacheRoot: TMP_ROOT,
    });
    assert(a.cache.hit === false);
    // Force expiry by rewriting createdAt to a value in the past.
    const ck = cacheKey;
    const keyHash = ck(key);
    const file = path.join(TMP_ROOT, 'html-parse', keyHash + '.json');
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.createdAt = Date.now() - (10 * 1000); // 10s ago, ttl=1 → expired
    fs.writeFileSync(file, JSON.stringify(entry));
    const b = await runWithCache({
      namespace: 'html-parse', key, ttlSec: 1, producer, cacheRoot: TMP_ROOT,
    });
    assert(b.cache.hit === false, 'expired entry must miss');
    assert(calls === 2, 'producer must run again');
  });

  await test('different keys → different entries', async () => {
    let calls = 0;
    const producer = async () => { calls++; return { c: calls }; };
    const a = await runWithCache({
      namespace: 'coverage', key: { url: 'a' }, ttlSec: 60, producer, cacheRoot: TMP_ROOT,
    });
    const b = await runWithCache({
      namespace: 'coverage', key: { url: 'b' }, ttlSec: 60, producer, cacheRoot: TMP_ROOT,
    });
    assert(a.cache.hit === false && b.cache.hit === false, 'both must miss');
    assert(a.cache.key !== b.cache.key, 'keys must differ');
    assert(calls === 2, 'producer must run twice');
  });

  await test('producer throw propagates; no cache write', async () => {
    const key = { tag: 'throw-test' };
    const ck = cacheKey;
    const keyHash = ck(key);
    const file = path.join(TMP_ROOT, 'crux', keyHash + '.json');
    let threw = false;
    try {
      await runWithCache({
        namespace: 'crux', key, ttlSec: 60,
        producer: async () => { throw new Error('boom'); },
        cacheRoot: TMP_ROOT,
      });
    } catch (err) {
      threw = /boom/.test(err.message);
    }
    assert(threw, 'error must propagate');
    assert(!fs.existsSync(file), 'no cache file must be written on throw');
  });

  await test('force: bypasses cache read', async () => {
    let calls = 0;
    const producer = async () => { calls++; return { c: calls }; };
    const key = { tag: 'force-test' };
    await runWithCache({ namespace: 'rum', key, producer, cacheRoot: TMP_ROOT });
    await runWithCache({ namespace: 'rum', key, producer, cacheRoot: TMP_ROOT }); // hit
    const r = await runWithCache({ namespace: 'rum', key, producer, force: true, cacheRoot: TMP_ROOT });
    assert(r.cache.hit === false, 'force must skip read');
    assert(calls === 2, 'producer should run twice total (first + forced)');
  });

  await test('eviction: >100 entries → oldest 20 deleted', async () => {
    const nsDir = path.join(TMP_ROOT, 'evict-test');
    fs.mkdirSync(nsDir, { recursive: true });
    // Create 101 dummy entries with staggered mtimes so eviction order is deterministic.
    const now = Date.now();
    for (let i = 0; i < 101; i++) {
      const p = path.join(nsDir, String(i).padStart(40, '0') + '.json');
      fs.writeFileSync(p, JSON.stringify({ createdAt: now, ttlSec: 3600, keyJson: 'x', result: { i } }));
      const mt = new Date(now - (101 - i) * 1000);
      fs.utimesSync(p, mt, mt);
    }
    assert(fs.readdirSync(nsDir).length === 101, 'setup: 101 files');
    // Now write one more entry via runWithCache, which triggers evictIfNeeded.
    // Use a distinct key so we don't collide with the dummies.
    await runWithCache({
      namespace: 'evict-test',
      key: { trigger: 'eviction' },
      ttlSec: 60,
      producer: async () => ({ ok: true }),
      cacheRoot: TMP_ROOT,
    });
    const remaining = fs.readdirSync(nsDir).filter((n) => n.endsWith('.json'));
    // 101 dummies + 1 new = 102, minus 20 evicted = 82.
    assert(remaining.length === 82, `expected 82 entries after eviction, got ${remaining.length}`);
    // The oldest dummies (lowest index) should be the ones gone.
    assert(
      !remaining.includes(String(0).padStart(40, '0') + '.json'),
      'oldest dummy should be evicted',
    );
  });

  await test('corrupted entry: treated as miss and removed', async () => {
    const key = { tag: 'corrupt-test' };
    const ck = cacheKey;
    const keyHash = ck(key);
    const dir = path.join(TMP_ROOT, 'launcher');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, keyHash + '.json');
    fs.writeFileSync(file, '{not valid json');
    let calls = 0;
    const r = await runWithCache({
      namespace: 'launcher', key, ttlSec: 60,
      producer: async () => { calls++; return { v: 1 }; },
      cacheRoot: TMP_ROOT,
    });
    assert(r.cache.hit === false, 'corrupted must miss');
    assert(calls === 1, 'producer must run');
    // File should now contain a valid new entry.
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    assert(parsed && parsed.result && parsed.result.v === 1, 'new entry must be written');
  });

  await test('clearCache removes entries', async () => {
    await runWithCache({
      namespace: 'clear-test', key: { a: 1 }, ttlSec: 60,
      producer: async () => ({ v: 1 }), cacheRoot: TMP_ROOT,
    });
    const res = await clearCache({ namespace: 'clear-test', cacheRoot: TMP_ROOT });
    assert(res.deleted >= 1, `expected >=1 deleted, got ${res.deleted}`);
    assert(!fs.existsSync(path.join(TMP_ROOT, 'clear-test')), 'namespace dir should be gone');
  });

  // ---------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((err) => {
  process.stderr.write(`test runner crashed: ${err && err.stack || err}\n`);
  process.exit(1);
});
