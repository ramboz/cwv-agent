#!/usr/bin/env node

/**
 * coverage.js — Chrome Coverage API analyzer.
 *
 * Runs a standalone Puppeteer session (independent of launcher.js), collects
 * JS + CSS coverage during initial load, and emits Findings conforming to
 * .agents/references/topics/finding-schema.md (schema v1.0).
 *
 * Heuristics implemented (see .agents/references/topics/coverage.md):
 *   1. Per-script unused JS waste (>=50% unused AND >=30KB, render-blocking or pre-LCP)
 *   2. Per-stylesheet unused CSS waste (>=60% unused AND >=10KB)
 *   3. Aggregate critical-path waste summary (>=100KB unused across render-blocking JS+CSS)
 *   4. Vendor bundle waste signal (name matches vendor|chunk|main|bundle|lib AND >=60% unused)
 *
 * Source tier: "coverage" (lab tier 2, confidence cap 0.85).
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { KnownDevices } from 'puppeteer';

import {
  validateFinding,
  SOURCE_TIERS,
  MIN_IMPACT,
  deriveSeverity,
} from '../finding-schema.js';
import { buildLaunchOptions, applyStealthPage } from '../launch-opts.js';

// Throttling profile table is shared with launcher.js — see ../profiles.js.
import { PROFILES, applyProfile } from '../profiles.js';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------
const JS_UNUSED_PCT_MIN = 50;
const JS_TOTAL_BYTES_MIN = 30 * 1024;
const CSS_UNUSED_PCT_MIN = 60;
const CSS_TOTAL_BYTES_MIN = 10 * 1024;
const AGGREGATE_CRITICAL_PATH_MIN_UNUSED = 100 * 1024;
const VENDOR_UNUSED_PCT_MIN = 60;
const VENDOR_URL_REGEX = /(vendor|chunk|main|bundle|lib)/i;

// Conservative network cost: ~10ms per KB on slow-4G.
const MS_PER_KB = 10;

const COVERAGE_CONFIDENCE = Math.min(0.75, SOURCE_TIERS.coverage.maxConfidence);

// ---------------------------------------------------------------------------
// Pure analysis (tested without a browser)
// ---------------------------------------------------------------------------

/**
 * Compute per-entry coverage rows from raw Puppeteer coverage arrays.
 *
 * @param {Array<{url:string, text?:string, ranges:Array<{start:number,end:number}>}>} jsCoverage
 * @param {Array<{url:string, text?:string, ranges:Array<{start:number,end:number}>}>} cssCoverage
 * @returns {{ js: Array<Row>, css: Array<Row> }}
 */
function computeCoverageRows(jsCoverage, cssCoverage) {
  const js = (jsCoverage || []).map((e) => toRow(e, 'js'));
  const css = (cssCoverage || []).map((e) => toRow(e, 'css'));
  return { js, css };
}

function toRow(entry, kind) {
  const totalBytes = typeof entry.totalBytes === 'number'
    ? entry.totalBytes
    : (entry.text ? Buffer.byteLength(entry.text, 'utf8') : 0);
  let usedBytes = 0;
  const ranges = Array.isArray(entry.ranges) ? entry.ranges : [];
  for (const r of ranges) {
    if (!r || typeof r.start !== 'number' || typeof r.end !== 'number') continue;
    usedBytes += Math.max(0, r.end - r.start);
  }
  if (usedBytes > totalBytes) usedBytes = totalBytes;
  const unusedBytes = Math.max(0, totalBytes - usedBytes);
  const unusedPct = totalBytes > 0 ? (unusedBytes / totalBytes) * 100 : 0;
  return {
    kind,
    url: entry.url || '',
    totalBytes,
    usedBytes,
    unusedBytes,
    unusedPct,
    // Optional signals harvested from resource-timing if the caller stitched them in.
    // Preserve null/undefined vs explicit boolean — the analyzer distinguishes
    // "unknown" from "explicitly not render-blocking" when deciding critical-path.
    renderBlocking: typeof entry.renderBlocking === 'boolean' ? entry.renderBlocking : null,
    startTime: typeof entry.startTime === 'number' ? entry.startTime : null,
    lcpTime: typeof entry.lcpTime === 'number' ? entry.lcpTime : null,
  };
}

/**
 * A JS row is "render-critical" when it's render-blocking or started before LCP.
 * When no timing signals are present, default conservatively to true only if
 * render-blocking is explicitly flagged.
 */
function isRenderCriticalJs(row) {
  if (row.renderBlocking === true) return true;
  if (row.startTime != null && row.lcpTime != null && row.startTime <= row.lcpTime) return true;
  return false;
}

/**
 * Build Findings from coverage rows.
 *
 * @param {{js:Array, css:Array}} rows
 * @param {object} ctx — { url, skill, nowIso, assumeRenderCritical? }
 *   assumeRenderCritical: if true, any row without explicit flags is treated as
 *   render-critical (useful when timing metadata isn't plumbed through).
 * @returns {Array<Finding>}
 */
function buildFindings(rows, ctx) {
  const {
    url,
    skill = 'cwv-diagnose',
    nowIso = new Date().toISOString(),
    assumeRenderCritical = true,
  } = ctx;
  const findings = [];
  let idx = 0;

  const mkId = (prefix, metric) => `${prefix}-${metric.toLowerCase()}-${++idx}`;

  // 1 + 4: per-script JS waste.
  const criticalJsRows = [];
  for (const r of rows.js) {
    const critical = assumeRenderCritical ? (r.renderBlocking !== false) && isMaybeCritical(r, assumeRenderCritical)
      : isRenderCriticalJs(r);
    if (critical) criticalJsRows.push(r);

    if (r.unusedPct < JS_UNUSED_PCT_MIN) continue;
    if (r.totalBytes < JS_TOTAL_BYTES_MIN) continue;
    if (!critical) continue;

    const isVendor = VENDOR_URL_REGEX.test(r.url) && r.unusedPct >= VENDOR_UNUSED_PCT_MIN;
    const valueMs = Math.round((r.unusedBytes / 1024) * MS_PER_KB);
    const impactReduction = { metric: 'LCP', valueMs };
    const belowFloor = valueMs < MIN_IMPACT.LCP.delta;

    const finding = {
      schemaVersion: '1.0',
      id: mkId('coverage', 'LCP'),
      timestamp: nowIso,
      url,
      skill,
      source: 'coverage',
      metric: ['LCP', 'TBT', 'INP'],
      type: 'waste',
      severity: deriveSeverity(impactReduction),
      rootCause: false,
      cause: `${pctStr(r.unusedPct)} of ${kbStr(r.totalBytes)} in ${shortUrl(r.url)} is unused during initial load (${kbStr(r.unusedBytes)} wasted).`,
      evidence: [
        {
          kind: 'coverage-row',
          data: {
            url: r.url,
            totalBytes: r.totalBytes,
            unusedBytes: r.unusedBytes,
            unusedPct: Number(r.unusedPct.toFixed(2)),
          },
        },
      ],
      recommendation: isVendor
        ? `Code-split this vendor/bundle file — ${pctStr(r.unusedPct)} of it is unused on initial load. Split by route or lazy-import the unused surface. Consider tree-shaking and dropping polyfills that modern browsers don't need.`
        : `Remove or defer unused JavaScript in ${shortUrl(r.url)}. Options: (a) lazy-load this script (\`defer\`, dynamic import, or move below-the-fold); (b) split it and only ship what's needed for initial render.`,
      confidence: COVERAGE_CONFIDENCE,
      impactReduction,
      status: belowFloor ? 'rejected' : 'draft',
    };
    findings.push(finding);
  }

  // 2: per-stylesheet CSS waste.
  const criticalCssRows = [];
  for (const r of rows.css) {
    const critical = assumeRenderCritical ? true : (r.renderBlocking === true);
    if (critical) criticalCssRows.push(r);

    if (r.unusedPct < CSS_UNUSED_PCT_MIN) continue;
    if (r.totalBytes < CSS_TOTAL_BYTES_MIN) continue;

    const valueMs = Math.round((r.unusedBytes / 1024) * MS_PER_KB);
    const impactReduction = { metric: 'LCP', valueMs };
    const belowFloor = valueMs < MIN_IMPACT.LCP.delta;

    const finding = {
      schemaVersion: '1.0',
      id: mkId('coverage', 'LCP'),
      timestamp: nowIso,
      url,
      skill,
      source: 'coverage',
      metric: ['LCP', 'FCP'],
      type: 'waste',
      severity: deriveSeverity(impactReduction),
      rootCause: false,
      cause: `${pctStr(r.unusedPct)} of ${kbStr(r.totalBytes)} in stylesheet ${shortUrl(r.url)} is unused on initial render (${kbStr(r.unusedBytes)} wasted).`,
      evidence: [
        {
          kind: 'coverage-row',
          data: {
            url: r.url,
            totalBytes: r.totalBytes,
            unusedBytes: r.unusedBytes,
            unusedPct: Number(r.unusedPct.toFixed(2)),
          },
        },
      ],
      recommendation: `Inline the critical CSS subset needed for above-the-fold and load the rest asynchronously (\`media="print"\` + onload swap, or split by route). Extract unused selectors using PurgeCSS/UnCSS if the stylesheet is hand-authored.`,
      confidence: COVERAGE_CONFIDENCE,
      impactReduction,
      status: belowFloor ? 'rejected' : 'draft',
    };
    findings.push(finding);
  }

  // 3: aggregate critical-path waste summary.
  const aggregateRows = [...criticalJsRows, ...criticalCssRows];
  const aggregateUnused = aggregateRows.reduce((acc, r) => acc + r.unusedBytes, 0);
  if (aggregateUnused >= AGGREGATE_CRITICAL_PATH_MIN_UNUSED) {
    const valueMs = Math.round((aggregateUnused / 1024) * MS_PER_KB);
    const impactReduction = { metric: 'LCP', valueMs };
    const belowFloor = valueMs < MIN_IMPACT.LCP.delta;
    findings.push({
      schemaVersion: '1.0',
      id: mkId('coverage-agg', 'LCP'),
      timestamp: nowIso,
      url,
      skill,
      source: 'coverage',
      metric: ['LCP', 'FCP', 'TBT'],
      type: 'waste',
      severity: deriveSeverity(impactReduction),
      rootCause: true,
      cause: `Aggregate critical-path waste: ${kbStr(aggregateUnused)} of unused bytes across ${aggregateRows.length} render-critical JS+CSS resources.`,
      evidence: aggregateRows.map((r) => ({
        kind: 'coverage-row',
        data: {
          url: r.url,
          totalBytes: r.totalBytes,
          unusedBytes: r.unusedBytes,
          unusedPct: Number(r.unusedPct.toFixed(2)),
        },
      })),
      recommendation: `Reduce unused JS+CSS on the critical path by ~${kbStr(aggregateUnused)}. Prioritize the largest offenders: ${aggregateRows
        .slice()
        .sort((a, b) => b.unusedBytes - a.unusedBytes)
        .slice(0, 3)
        .map((r) => shortUrl(r.url))
        .join(', ')}. Use code-splitting, lazy-loading, and critical-CSS extraction.`,
      confidence: COVERAGE_CONFIDENCE,
      impactReduction,
      status: belowFloor ? 'rejected' : 'draft',
    });
  }

  return findings;
}

function isMaybeCritical(r, assumeRenderCritical) {
  if (r.renderBlocking === true) return true;
  if (r.renderBlocking === false) return false;
  if (r.startTime != null && r.lcpTime != null) return r.startTime <= r.lcpTime;
  return assumeRenderCritical === true;
}

function shortUrl(u) {
  try {
    const parsed = new URL(u);
    const tail = parsed.pathname.split('/').filter(Boolean).pop() || parsed.pathname || '/';
    return `${parsed.hostname}/${tail}`;
  } catch {
    return u || '(unknown)';
  }
}

function kbStr(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function pctStr(pct) {
  return `${pct.toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// Live browser collection
// ---------------------------------------------------------------------------
async function collect({ url, profile: profileName, opts }) {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown profile "${profileName}"`);

  const stealth = opts && opts.stealth === true;
  const browser = await puppeteer.launch(buildLaunchOptions(stealth));

  let jsCov = [];
  let cssCov = [];

  try {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    if (stealth) await applyStealthPage(page);
    await applyProfile(page, { KnownDevices }, profileName, { stealth });

    await Promise.all([
      page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false }),
      page.coverage.startCSSCoverage({ resetOnNavigation: false }),
    ]);

    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});

    // Force LCP finalization.
    await page.evaluate(() => {
      try {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      } catch { /* noop */ }
    });
    await new Promise((r) => setTimeout(r, 500));

    [jsCov, cssCov] = await Promise.all([
      page.coverage.stopJSCoverage(),
      page.coverage.stopCSSCoverage(),
    ]);

    await context.close();
  } finally {
    try { await browser.close(); } catch { /* noop */ }
  }

  return { jsCoverage: jsCov, cssCoverage: cssCov };
}

/**
 * Public entry: collect coverage and emit findings.
 */
async function collectAndAnalyze({ url, profile = 'mobile-slow4g-4xcpu', opts = {} } = {}) {
  if (!url) throw new Error('url is required');
  const { jsCoverage, cssCoverage } = await collect({ url, profile, opts });
  const rows = computeCoverageRows(jsCoverage, cssCoverage);
  const findings = buildFindings(rows, {
    url,
    skill: opts.skill || 'cwv-diagnose',
    nowIso: new Date().toISOString(),
    assumeRenderCritical: opts.assumeRenderCritical !== false,
  });
  const summary = summarize(rows, findings);
  return { findings, summary, raw: { jsCoverage, cssCoverage } };
}

function summarize(rows, findings) {
  const sum = (arr, key) => arr.reduce((a, r) => a + (r[key] || 0), 0);
  return {
    js: {
      files: rows.js.length,
      totalBytes: sum(rows.js, 'totalBytes'),
      unusedBytes: sum(rows.js, 'unusedBytes'),
    },
    css: {
      files: rows.css.length,
      totalBytes: sum(rows.css, 'totalBytes'),
      unusedBytes: sum(rows.css, 'unusedBytes'),
    },
    findings: {
      total: findings.length,
      draft: findings.filter((f) => f.status === 'draft').length,
      rejected: findings.filter((f) => f.status === 'rejected').length,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = `
cwv-agent coverage analyzer

Usage: node .agents/scripts/analyzers/coverage.js --url <URL> [flags]

Flags:
  --url <url>         Target page URL (required)
  --profile <name>    Throttling profile (default: mobile-slow4g-4xcpu)
                      Options: mobile-slow4g-4xcpu | desktop-cable-1xcpu |
                      desktop-slow-1xcpu | no-throttle
  --stealth           Launch headful real Chrome with automation tells scrubbed
                      for Cloudflare / anti-bot managed challenges.
  --output <path>     Write JSON output to file (default: stdout)
  --help              Print this help and exit 0
`;

function parseArgs(argv) {
  const args = { url: null, profile: 'mobile-slow4g-4xcpu', output: null, stealth: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--help': case '-h': args.help = true; break;
      case '--url': args.url = next(); break;
      case '--profile': args.profile = next(); break;
      case '--output': args.output = next(); break;
      case '--stealth': args.stealth = true; break;
      default:
        if (a && a.startsWith('--')) {
          process.stderr.write(`Unknown flag: ${a}\n`);
          process.exit(2);
        }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); process.exit(0); }
  if (!args.url) { process.stderr.write('Error: --url is required.\n' + HELP); process.exit(2); }
  if (!PROFILES[args.profile]) { process.stderr.write(`Error: unknown profile "${args.profile}".\n` + HELP); process.exit(2); }

  try {
    const result = await collectAndAnalyze({ url: args.url, profile: args.profile, opts: { stealth: args.stealth } });
    const envelope = {
      schemaVersion: '1.0',
      skill: 'cwv-diagnose',
      url: args.url,
      timestamp: new Date().toISOString(),
      summary: result.summary,
      findings: result.findings,
    };
    // Validate every finding defensively before emitting.
    for (const f of result.findings) {
      const v = validateFinding(f);
      if (!v.valid) {
        process.stderr.write(`WARN: finding ${f.id} failed validation: ${v.errors.join('; ')}\n`);
      }
    }
    const json = JSON.stringify(envelope, null, 2);
    if (args.output) {
      fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
      fs.writeFileSync(args.output, json);
    } else {
      process.stdout.write(json + '\n');
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err && err.message || String(err), phase: 'coverage' }) + '\n');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  PROFILES,
  parseArgs,
  collectAndAnalyze,
  computeCoverageRows,
  buildFindings,
  // Exposed constants for tests and downstream composition.
  JS_UNUSED_PCT_MIN,
  JS_TOTAL_BYTES_MIN,
  CSS_UNUSED_PCT_MIN,
  CSS_TOTAL_BYTES_MIN,
  AGGREGATE_CRITICAL_PATH_MIN_UNUSED,
  VENDOR_UNUSED_PCT_MIN,
  MS_PER_KB,
};
