#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkFreshness, readProvenance } from './playbook-provenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const requireFromHere = createRequire(import.meta.url);

const LOCAL_SCRIPT_FILES = [
  '.agents/scripts/launcher.js',
  '.agents/scripts/oracle.js',
  '.agents/scripts/finding-schema.js',
  '.agents/scripts/measure-cwv.js',
  '.agents/scripts/collect-resources.js',
];

const OUTPUT_DIRS = ['progress', 'results', 'screenshots'];

const CHROME_COMMANDS = [
  'google-chrome',
  'google-chrome-stable',
  'chrome',
  'chromium',
  'chromium-browser',
];

const CHROME_APP_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];

const EXECUTION_PROFILES = {
  local: {
    status: 'supported',
    description: 'Local measurement, diagnosis, patching, validation, and artifact output.',
  },
  'field-google': {
    status: 'supported',
    description: 'CrUX and PageSpeed Insights field triage.',
  },
  'stealth-headful': {
    status: 'supported',
    description: 'Headful Chrome measurement for bot-protected pages.',
  },
};

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseDotEnv(text) {
  const env = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function readDotEnv(projectRoot) {
  const file = path.join(projectRoot, '.env');
  try {
    return parseDotEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function commandAvailableSync(command, env = process.env) {
  const pathValue = env.PATH || env.Path || env.path || '';
  if (!pathValue) return false;
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return false;
}

function createDefaultContext(projectRoot = DEFAULT_PROJECT_ROOT) {
  const packageJson = readJsonFile(path.join(projectRoot, 'package.json')) || {};
  const env = { ...readDotEnv(projectRoot), ...process.env };
  return {
    projectRoot,
    env,
    nodeVersion: process.versions.node,
    packageJson,
    fileExists(relativePath) {
      return fs.existsSync(path.join(projectRoot, relativePath));
    },
    pathWritable(relativePath) {
      const target = path.join(projectRoot, relativePath);
      try {
        if (fs.existsSync(target)) {
          if (!fs.statSync(target).isDirectory()) return false;
          fs.accessSync(target, fs.constants.W_OK);
          return true;
        }
        const candidate = path.dirname(target);
        fs.accessSync(candidate, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    moduleAvailable(name) {
      try {
        requireFromHere.resolve(name, { paths: [projectRoot] });
        return true;
      } catch {
        return false;
      }
    },
    commandAvailable(command) {
      return commandAvailableSync(command, env);
    },
    runCommand(command, args = [], options = {}) {
      const result = spawnSync(command, args, {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: options.timeoutMs || 5000,
        cwd: options.cwd || projectRoot,
        env: options.env ? { ...env, ...options.env } : env,
      });
      return {
        status: result.status,
        signal: result.signal,
        error: result.error ? result.error.message : null,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
      };
    },
    scriptHealth(relativePath) {
      const script = path.join(projectRoot, relativePath);
      if (!fs.existsSync(script)) return { ok: false, detail: 'missing' };
      const result = spawnSync(process.execPath, ['--check', script], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      if (result.error) {
        return { ok: false, detail: result.error.message };
      }
      if (result.status !== 0) {
        const output = `${result.stderr || ''}${result.stdout || ''}`.trim().split(/\r?\n/)[0];
        return { ok: false, detail: output || `node --check exited ${result.status}` };
      }
      return { ok: true, detail: 'node --check passed' };
    },
    pathExists(absolutePath) {
      return fs.existsSync(absolutePath);
    },
    readJsonAbsolute(absolutePath) {
      return readJsonFile(absolutePath);
    },
    fileMtimeMs(relativePath) {
      try {
        return fs.statSync(path.join(projectRoot, relativePath)).mtimeMs;
      } catch {
        return null;
      }
    },
    fileSha256(relativePath) {
      try {
        return crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(projectRoot, relativePath)))
          .digest('hex');
      } catch {
        return null;
      }
    },
    adapterExists(profile) {
      return (FUTURE_ADAPTERS[profile] || []).some((relativePath) => (
        fs.existsSync(path.join(projectRoot, relativePath))
      ));
    },
  };
}

function check(id, label, ok, detail, { required = true, status } = {}) {
  return {
    id,
    label,
    status: status || (ok ? 'pass' : 'fail'),
    required,
    detail: detail || '',
  };
}

function info(id, label, detail) {
  return check(id, label, true, detail, { required: false, status: 'info' });
}

function unknown(id, label, detail) {
  return check(id, label, false, detail, { required: true, status: 'unknown' });
}

function envCheck(name, ctx) {
  const value = ctx.env && ctx.env[name];
  return check(
    `env:${name}`,
    `${name} is set`,
    Boolean(value),
    value ? 'available' : 'missing',
  );
}

function commandCheck(command, label, ctx) {
  const available = ctx.commandAvailable(command);
  return check(
    `command:${command}`,
    label || `${command} command is available`,
    available,
    available ? 'found on PATH' : 'not found on PATH',
  );
}

function packageScriptCheck(scriptName, ctx) {
  const scripts = (ctx.packageJson && ctx.packageJson.scripts) || {};
  return check(
    `package-script:${scriptName}`,
    `package.json exposes npm run ${scriptName}`,
    Boolean(scripts[scriptName]),
    scripts[scriptName] || `missing; add npm script "${scriptName}"`,
  );
}

function optionalCheck(item) {
  return { ...item, required: false };
}

function chromeCheck(ctx) {
  const command = CHROME_COMMANDS.find((candidate) => ctx.commandAvailable(candidate));
  const appPath = command ? null : CHROME_APP_PATHS.find((candidate) => (
    typeof ctx.pathExists === 'function' && ctx.pathExists(candidate)
  ));
  const found = command || appPath;
  return check(
    'chrome:headful',
    'Google Chrome/Chromium for headful measurement',
    Boolean(found),
    found
      ? `found ${found}`
      : `not found; tried PATH commands ${CHROME_COMMANDS.join(', ')} and common macOS app paths`,
  );
}

const PLAYBOOKS_REL_DIR = '.agents/references/playbooks';

function playbookFreshnessCheck(ctx) {
  // The vendored playbooks are a repo-committed artifact colocated with the
  // scripts, NOT part of the writable output/config root — so resolve them
  // relative to this script (DEFAULT_PROJECT_ROOT), not ctx.projectRoot (which
  // is a throwaway temp dir under setup.js's directory-creation tests). An
  // explicit ctx.playbooksDir override is honored for test fixtures.
  const dir = (ctx && ctx.playbooksDir)
    || path.join(DEFAULT_PROJECT_ROOT, PLAYBOOKS_REL_DIR);
  const res = checkFreshness(dir);
  // Advisory (required:false): a stale/missing marker is SURFACED but must NOT
  // block a run via the 014 preflight gate. The workbench OWNS and deliberately
  // diverges from mystique (ADR-0015 §1), and field-only triage never reaches the
  // playbook-consuming fix step — so "detectable, not silent" (AC-1), not blocking.
  if (!res.present) {
    return check(
      'playbooks:freshness',
      'CWV playbook provenance marker',
      false,
      `missing ${PLAYBOOKS_REL_DIR}/PROVENANCE.json; run node .agents/scripts/playbook-sync.js to record it (gates 015-03/04/05 depend on the vendored set)`,
      { required: false },
    );
  }
  if (res.stale) {
    return check(
      'playbooks:freshness',
      'CWV playbook provenance marker',
      false,
      `stale ${PLAYBOOKS_REL_DIR}: recorded checksum ${String(res.recordedChecksum).slice(0, 12)} != current ${String(res.computedChecksum).slice(0, 12)}; run node .agents/scripts/playbook-sync.js --check then re-sync`,
      { required: false },
    );
  }
  const prov = readProvenance(dir);
  return check(
    'playbooks:freshness',
    'CWV playbook provenance marker',
    true,
    `fresh: ${prov.playbookCount} playbooks, checksum ${String(res.computedChecksum).slice(0, 12)} (source ${prov.source || 'unknown'}${prov.sourceRef ? `@${prov.sourceRef}` : ''})`,
    { required: false },
  );
}

function buildLocalChecks(ctx) {
  const major = Number(String(ctx.nodeVersion || '').split('.')[0]);
  const packageScripts = (ctx.packageJson && ctx.packageJson.scripts) || {};
  const packageLockExists = ctx.fileExists('package-lock.json');
  const nodeModulesExists = ctx.fileExists('node_modules');
  const modules = {
    puppeteer: ctx.moduleAvailable('puppeteer'),
    'web-vitals': ctx.moduleAvailable('web-vitals'),
    dotenv: ctx.moduleAvailable('dotenv'),
  };
  const vendorExists = ctx.fileExists('.agents/scripts/vendor/web-vitals.attribution.iife.js');
  const outputChecks = OUTPUT_DIRS.map((dir) => ({
    dir,
    writable: ctx.pathWritable(dir),
  }));
  const scriptChecks = LOCAL_SCRIPT_FILES.map((file) => {
    const exists = ctx.fileExists(file);
    const health = exists && typeof ctx.scriptHealth === 'function'
      ? ctx.scriptHealth(file)
      : { ok: exists, detail: exists ? 'found' : 'missing' };
    return { file, exists, health };
  });
  return [
    check(
      'node:version',
      'Node.js >=20',
      Number.isFinite(major) && major >= 20,
      ctx.nodeVersion ? `current ${ctx.nodeVersion}` : 'unable to read process version',
    ),
    check(
      'install:package-lock',
      'package-lock.json exists',
      packageLockExists,
      packageLockExists ? 'found' : 'missing',
    ),
    check(
      'install:node-modules',
      'npm install state',
      nodeModulesExists,
      nodeModulesExists ? 'node_modules present' : 'node_modules missing; run npm ci',
    ),
    check(
      'module:puppeteer',
      'Puppeteer package availability',
      modules.puppeteer,
      modules.puppeteer ? 'resolvable' : 'missing; run npm ci',
    ),
    check(
      'module:web-vitals',
      'web-vitals package availability',
      modules['web-vitals'],
      modules['web-vitals'] ? 'resolvable' : 'missing; run npm ci',
    ),
    check(
      'module:dotenv',
      'dotenv package availability',
      modules.dotenv,
      modules.dotenv ? 'resolvable' : 'missing; run npm ci',
    ),
    check(
      'vendor:web-vitals-attribution',
      'web-vitals attribution vendor file',
      vendorExists,
      vendorExists
        ? 'found'
        : 'missing; run npm ci to trigger postinstall',
    ),
    ...outputChecks.map(({ dir, writable }) => check(
      `writable:${dir}`,
      `${dir}/ output path writable`,
      writable,
      writable ? 'writable or creatable' : 'not writable',
    )),
    ...scriptChecks.flatMap(({ file, exists, health }) => [
      check(
        `script:${file}`,
        `${file} exists`,
        exists,
        exists ? 'found' : 'missing',
      ),
      check(
        `script-health:${file}`,
        `${file} syntax check`,
        exists && health.ok,
        exists ? health.detail : 'missing',
      ),
    ]),
    check(
      'package-script:doctor',
      'package.json exposes npm run doctor',
      Boolean(packageScripts.doctor),
      packageScripts.doctor || 'missing',
    ),
    check(
      'package-script:measure',
      'package.json exposes npm run measure',
      Boolean(packageScripts.measure),
      packageScripts.measure || 'missing',
    ),
    packageScriptCheck('setup', ctx),
    playbookFreshnessCheck(ctx),
  ];
}

function buildProfileOnlyChecks(profile, ctx) {
  switch (profile) {
    case 'local':
      return [];
    case 'field-google':
      return [
        envCheck('GOOGLE_CRUX_API_KEY', ctx),
        envCheck('GOOGLE_PAGESPEED_INSIGHTS_API_KEY', ctx),
      ];
    case 'stealth-headful':
      return [
        chromeCheck(ctx),
        info(
          'manual:stealth-opt-in',
          'operator opt-in',
          'headful stealth measurement is explicit opt-in only',
        ),
      ];
    default:
      throw new Error(`Unknown profile "${profile}". Valid: ${Object.keys(EXECUTION_PROFILES).join(', ')}`);
  }
}

function summarize(profile, checks) {
  const blocking = checks.filter((item) => (
    item.required && ['fail', 'not-wired', 'unknown'].includes(item.status)
  ));
  const hasNotWired = blocking.some((item) => item.status === 'not-wired');
  return {
    schemaVersion: '1.0',
    profile,
    profileStatus: EXECUTION_PROFILES[profile].status,
    ok: blocking.length === 0,
    status: blocking.length === 0 ? 'ready' : (hasNotWired ? 'not-wired' : 'not-ready'),
    checks,
    summary: {
      pass: checks.filter((item) => item.status === 'pass').length,
      fail: checks.filter((item) => item.status === 'fail').length,
      notWired: checks.filter((item) => item.status === 'not-wired').length,
      unknown: checks.filter((item) => item.status === 'unknown').length,
      info: checks.filter((item) => item.status === 'info').length,
      blocking: blocking.length,
    },
  };
}

function runDoctor({ profile = 'local', context = createDefaultContext() } = {}) {
  if (!EXECUTION_PROFILES[profile]) {
    throw new Error(`Unknown profile "${profile}". Valid: ${Object.keys(EXECUTION_PROFILES).join(', ')}`);
  }
  const checks = [
    ...buildLocalChecks(context),
    ...buildProfileOnlyChecks(profile, context),
  ];
  return summarize(profile, checks);
}

function statusWord(status) {
  switch (status) {
    case 'pass': return 'PASS';
    case 'fail': return 'FAIL';
    case 'not-wired': return 'NOT WIRED';
    case 'unknown': return 'UNKNOWN';
    case 'info': return 'INFO';
    default: return status.toUpperCase();
  }
}

function formatDoctorText(result) {
  const lines = [
    `cwv doctor: ${result.profile}`,
    `profile status: ${result.profileStatus}`,
    '',
  ];
  for (const item of result.checks) {
    const required = item.required ? 'required' : 'info';
    const detail = item.detail ? `: ${item.detail}` : '';
    lines.push(`${statusWord(item.status)} [${required}] ${item.label}${detail}`);
  }
  lines.push('');
  lines.push(`Result: ${result.status}`);
  return `${lines.join('\n')}\n`;
}

function formatDoctorJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function usage() {
  return `Usage: npm run doctor -- [--profile <name>] [--json]\n\nProfiles: ${Object.keys(EXECUTION_PROFILES).join(', ')}\n`;
}

function parseArgs(argv) {
  const parsed = { profile: 'local', format: 'text', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--json') {
      parsed.format = 'json';
    } else if (arg === '--format') {
      const value = argv[i + 1];
      if (!value) return { ...parsed, error: '--format requires text or json' };
      if (!['text', 'json'].includes(value)) return { ...parsed, error: `unknown format "${value}"` };
      parsed.format = value;
      i += 1;
    } else if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (!['text', 'json'].includes(value)) return { ...parsed, error: `unknown format "${value}"` };
      parsed.format = value;
    } else if (arg === '--profile') {
      const value = argv[i + 1];
      if (!value) return { ...parsed, error: '--profile requires a profile name' };
      parsed.profile = value;
      i += 1;
    } else if (arg.startsWith('--profile=')) {
      parsed.profile = arg.slice('--profile='.length);
    } else {
      return { ...parsed, error: `unknown argument "${arg}"` };
    }
  }
  return parsed;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (args.error) {
    process.stderr.write(`${args.error}\n${usage()}`);
    return 2;
  }
  try {
    const result = runDoctor({ profile: args.profile });
    process.stdout.write(args.format === 'json' ? formatDoctorJson(result) : formatDoctorText(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export {
  EXECUTION_PROFILES,
  createDefaultContext,
  parseArgs,
  parseDotEnv,
  playbookFreshnessCheck,
  runDoctor,
  formatDoctorText,
  formatDoctorJson,
};
