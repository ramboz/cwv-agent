#!/usr/bin/env node

/**
 * cwv-agent cache utility
 *
 * Zero-dependency on-disk cache for the orchestrator (cwv-analyze) and any
 * other caller that wants to skip expensive operations when inputs are
 * unchanged. Individual analyzers remain cache-unaware.
 *
 * Storage layout:
 *   .agents/.cache/<namespace>/<sha1-of-key>.json
 *
 * Each entry: { createdAt, ttlSec, keyJson, result }
 *
 * See: .agents/references/topics/caching.md
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default TTLs per namespace, in seconds.
 *
 * Rationale:
 *   - launcher / coverage / image-analysis are lab measurements at fixed
 *     throttling — re-running within an hour mostly re-measures noise.
 *   - html-parse tracks page markup which changes more often than assets.
 *   - crux is daily field data; rum bundles update hourly but aggregate
 *     movement is small.
 *   - waterfall-shift is pure analysis over already-cached launcher output,
 *     so callers should generally not cache it (omitted here by design).
 */
const DEFAULT_TTLS = Object.freeze({
  launcher: 3600,          // 1 hour
  coverage: 3600,          // 1 hour
  'image-analysis': 3600,  // 1 hour
  'html-parse': 900,       // 15 minutes
  crux: 86400,             // 24 hours
  rum: 21600,              // 6 hours
});

const MAX_ENTRIES_PER_NS = 100;
const EVICT_BATCH = 20;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Repo-rooted default cache location (.agents/.cache). */
function defaultCacheRoot() {
  // This file lives at <repo>/.agents/scripts/cache.js.
  return path.resolve(__dirname, '..', '.cache');
}

/**
 * Resolve the active cache root. Explicit opts win, then env var, then default.
 * @param {{ cacheRoot?: string }} [opts]
 * @returns {string}
 */
function resolveCacheRoot(opts) {
  if (opts && opts.cacheRoot) return path.resolve(opts.cacheRoot);
  if (process.env.CWV_CACHE_ROOT) return path.resolve(process.env.CWV_CACHE_ROOT);
  return defaultCacheRoot();
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON stringify — sorts object keys recursively so
 * { a: 1, b: 2 } and { b: 2, a: 1 } produce identical output.
 * Handles nested objects/arrays. Does not attempt to handle cycles.
 * @param {*} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(v));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * Compute the sha1-hex cache key for an arbitrary JSON-serializable identity.
 * @param {*} obj
 * @returns {string}
 */
function cacheKey(obj) {
  const s = stableStringify(obj);
  return crypto.createHash('sha1').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// On-disk helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function entryPath(root, namespace, keyHash) {
  return path.join(root, namespace, keyHash + '.json');
}

async function readEntry(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.createdAt !== 'number' || typeof parsed.ttlSec !== 'number') {
      return null;
    }
    return parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    // Corrupted JSON / unreadable — treat as miss and delete below.
    return { __corrupted: true };
  }
}

async function safeUnlink(file) {
  try { await fs.unlink(file); } catch { /* ignore */ }
}

async function writeEntry(file, entry) {
  await ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(tmp, JSON.stringify(entry));
  await fs.rename(tmp, file);
}

/**
 * Evict oldest entries (by mtime) from a namespace dir when it exceeds
 * MAX_ENTRIES_PER_NS. Removes EVICT_BATCH entries per trigger.
 * @param {string} nsDir
 */
async function evictIfNeeded(nsDir) {
  let names;
  try {
    names = await fs.readdir(nsDir);
  } catch {
    return;
  }
  const jsonNames = names.filter((n) => n.endsWith('.json'));
  if (jsonNames.length <= MAX_ENTRIES_PER_NS) return;

  const stats = [];
  for (const n of jsonNames) {
    const p = path.join(nsDir, n);
    try {
      const st = await fs.stat(p);
      stats.push({ path: p, mtime: st.mtimeMs });
    } catch { /* ignore */ }
  }
  stats.sort((a, b) => a.mtime - b.mtime);
  const toDelete = stats.slice(0, EVICT_BATCH);
  for (const s of toDelete) {
    await safeUnlink(s.path);
  }
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Run `producer` with caching. On cache hit, returns the stored result
 * without invoking the producer. On miss, invokes producer and persists the
 * result keyed by sha1(stableStringify(key)) inside `namespace`.
 *
 * @template T
 * @param {object} opts
 * @param {string} opts.namespace
 * @param {*} opts.key             JSON-serializable identity
 * @param {number} [opts.ttlSec]   TTL override; defaults to DEFAULT_TTLS[namespace] or 3600
 * @param {() => Promise<T>} opts.producer
 * @param {boolean} [opts.force]   Bypass cache read; still writes result
 * @param {string} [opts.cacheRoot]
 * @returns {Promise<{ result: T, cache: { hit: boolean, ageSec?: number, key: string } }>}
 */
async function runWithCache(opts) {
  if (!opts || typeof opts !== 'object') throw new TypeError('runWithCache: opts required');
  const { namespace, key, producer, force } = opts;
  if (!namespace || typeof namespace !== 'string') throw new TypeError('namespace required');
  if (typeof producer !== 'function') throw new TypeError('producer must be a function');
  if (key === undefined) throw new TypeError('key required');

  const ttlSec = typeof opts.ttlSec === 'number' ? opts.ttlSec : (DEFAULT_TTLS[namespace] || 3600);
  const root = resolveCacheRoot(opts);
  const keyHash = cacheKey(key);
  const file = entryPath(root, namespace, keyHash);

  if (!force) {
    const entry = await readEntry(file);
    if (entry && entry.__corrupted) {
      await safeUnlink(file);
    } else if (entry) {
      const ageSec = Math.floor((Date.now() - entry.createdAt) / 1000);
      if (ageSec <= entry.ttlSec) {
        return { result: entry.result, cache: { hit: true, ageSec, key: keyHash } };
      }
      // Expired — evict.
      await safeUnlink(file);
    }
  }

  // Miss — run producer. Errors propagate; nothing is written on throw.
  const result = await producer();

  const entry = {
    createdAt: Date.now(),
    ttlSec,
    keyJson: stableStringify(key),
    result,
  };
  try {
    await writeEntry(file, entry);
    await evictIfNeeded(path.dirname(file));
  } catch (err) {
    // Disk full / permission / EROFS — warn but still return the result.
    process.stderr.write(`[cache] warn: failed to persist ${namespace}/${keyHash}: ${err && err.message}\n`);
  }

  return { result, cache: { hit: false, key: keyHash } };
}

/**
 * Delete all cached entries, optionally scoped to a single namespace.
 * @param {{ namespace?: string, cacheRoot?: string }} [opts]
 * @returns {Promise<{ deleted: number }>}
 */
async function clearCache(opts) {
  opts = opts || {};
  const root = resolveCacheRoot(opts);
  let deleted = 0;
  async function rmTree(dir) {
    let names;
    try { names = await fs.readdir(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      let st;
      try { st = await fs.stat(p); } catch { continue; }
      if (st.isDirectory()) {
        await rmTree(p);
        try { await fs.rmdir(p); } catch { /* ignore */ }
      } else {
        await safeUnlink(p);
        deleted++;
      }
    }
  }
  if (opts.namespace) {
    await rmTree(path.join(root, opts.namespace));
    try { await fs.rmdir(path.join(root, opts.namespace)); } catch { /* ignore */ }
  } else {
    await rmTree(root);
  }
  return { deleted };
}

// ---------------------------------------------------------------------------
// Introspection (used by CLI)
// ---------------------------------------------------------------------------

async function listNamespaces(root) {
  let names;
  try { names = await fs.readdir(root); } catch { return []; }
  const out = [];
  for (const n of names) {
    const p = path.join(root, n);
    let st;
    try { st = await fs.stat(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    let entries;
    try { entries = await fs.readdir(p); } catch { continue; }
    const files = entries.filter((e) => e.endsWith('.json'));
    let bytes = 0;
    for (const f of files) {
      try {
        const s = await fs.stat(path.join(p, f));
        bytes += s.size;
      } catch { /* ignore */ }
    }
    out.push({ namespace: n, count: files.length, bytes });
  }
  return out;
}

async function inspectEntry(root, namespace, keyPrefix) {
  const dir = path.join(root, namespace);
  let names;
  try { names = await fs.readdir(dir); } catch { return null; }
  const match = names.find((n) => n.startsWith(keyPrefix) && n.endsWith('.json'));
  if (!match) return null;
  const file = path.join(dir, match);
  const entry = await readEntry(file);
  if (!entry || entry.__corrupted) return null;
  const st = await fs.stat(file);
  const ageSec = Math.floor((Date.now() - entry.createdAt) / 1000);
  return {
    file,
    key: match.replace(/\.json$/, ''),
    createdAt: new Date(entry.createdAt).toISOString(),
    ttlSec: entry.ttlSec,
    ageSec,
    expired: ageSec > entry.ttlSec,
    keyJson: entry.keyJson,
    sizeBytes: st.size,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `
cwv-agent cache utility

Usage: node .agents/scripts/cache.js <command> [args]

Commands:
  list                        Print entry count + total size per namespace
  clear [namespace] --yes     Delete all entries (or one namespace)
  inspect <ns> <key-prefix>   Print metadata for a matching entry
  --help, -h                  Show this help

Env:
  CWV_CACHE_ROOT              Override cache root (default: .agents/.cache)
`;

function humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

async function cliMain(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  const root = resolveCacheRoot();

  if (cmd === 'list') {
    const nss = await listNamespaces(root);
    if (nss.length === 0) {
      process.stdout.write(`Cache root: ${root}\n(empty)\n`);
      return 0;
    }
    process.stdout.write(`Cache root: ${root}\n`);
    let totalCount = 0, totalBytes = 0;
    for (const ns of nss) {
      process.stdout.write(`  ${ns.namespace.padEnd(20)} ${String(ns.count).padStart(4)} entries  ${humanBytes(ns.bytes)}\n`);
      totalCount += ns.count;
      totalBytes += ns.bytes;
    }
    process.stdout.write(`  ${'TOTAL'.padEnd(20)} ${String(totalCount).padStart(4)} entries  ${humanBytes(totalBytes)}\n`);
    return 0;
  }

  if (cmd === 'clear') {
    const hasYes = rest.includes('--yes');
    const ns = rest.find((a) => !a.startsWith('--'));
    if (!hasYes) {
      process.stderr.write('Refusing to clear without --yes.\n');
      return 2;
    }
    const { deleted } = await clearCache({ namespace: ns });
    process.stdout.write(`Deleted ${deleted} entries${ns ? ' from ' + ns : ''}.\n`);
    return 0;
  }

  if (cmd === 'inspect') {
    const [ns, prefix] = rest;
    if (!ns || !prefix) {
      process.stderr.write('Usage: cache.js inspect <namespace> <key-prefix>\n');
      return 2;
    }
    const meta = await inspectEntry(root, ns, prefix);
    if (!meta) {
      process.stderr.write(`No entry found in ${ns} matching prefix "${prefix}".\n`);
      return 1;
    }
    process.stdout.write(JSON.stringify(meta, null, 2) + '\n');
    return 0;
  }

  process.stderr.write(`Unknown command: ${cmd}\n${HELP}`);
  return 2;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  runWithCache,
  cacheKey,
  clearCache,
  DEFAULT_TTLS,
  // Advanced / testing helpers:
  stableStringify,
  resolveCacheRoot,
  listNamespaces,
  inspectEntry,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cliMain(process.argv.slice(2)).then(
    (code) => process.exit(code || 0),
    (err) => {
      process.stderr.write(`cache.js error: ${err && err.stack || err}\n`);
      process.exit(1);
    },
  );
}
