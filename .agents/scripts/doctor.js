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

const FUTURE_ADAPTERS = {
  'diagnose-cwv-agent': [
    '.agents/scripts/providers/diagnose-cwv-agent.js',
    '.agents/scripts/adapters/diagnose-cwv-agent.js',
  ],
  'validate-aso': [
    '.agents/scripts/aso-validate.js',
  ],
};

const AEM_CLIENTLIB_DOCKER_IMAGE = 'cwv-aem-clientlib-builder:node20';
const AEM_CLIENTLIB_DOCKERFILE = 'docker/aem-clientlib-builder.Dockerfile';
const AEM_CLIENTLIB_DOCKERFILE_SHA_LABEL = 'org.cwv-agent.aem-clientlib-builder.dockerfile-sha';
const DEFAULT_ASO_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_ASO_IMAGE_TAG = 'aso-shallow-validator:local';
const ASO_HEALTH_PATH = '/v1/health';
const ASO_DIR_ENV_NAMES = ['ASO_SHALLOW_VALIDATOR_DIR', 'ASO_VALIDATOR_DIR'];
const ASO_BASE_URL_ENV_NAMES = ['ASO_SHALLOW_VALIDATOR_BASE_URL', 'ASO_BASE_URL'];
const ASO_IMAGE_ENV_NAMES = ['ASO_SHALLOW_VALIDATOR_IMAGE', 'ASO_IMAGE_TAG'];

const EXECUTION_PROFILES = {
  local: {
    status: 'supported',
    description: 'Local measurement, diagnosis, patching, validation, and artifact output.',
  },
  'aem-clientlibs': {
    status: 'supported',
    description: 'AEM CS source-built validation with aem-clientlib-builder and optional Docker fallback.',
  },
  'field-google': {
    status: 'supported',
    description: 'CrUX and PageSpeed Insights field triage.',
  },
  'field-aem-rum': {
    status: 'supported',
    description: 'AEM RUM Bundler field triage.',
  },
  'source-s3': {
    status: 'supported',
    description: 'SpaceCat importer S3 source retrieval.',
  },
  'publish-spacecat': {
    status: 'supported',
    description: 'SpaceCat suggestion/fix persistence through mysticat/sites-optimizer.',
  },
  'diagnose-cwv-agent': {
    status: 'future',
    description: 'Future hosted ASO/SpaceCat diagnosis delegation.',
  },
  'validate-aso': {
    status: 'partial',
    description: 'Local aso-shallow-validator setup plus explicit validation job adapter.',
  },
  'adobe-full': {
    status: 'partial',
    description: 'Future composed Adobe/SpaceCat provider profile.',
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

function envAnyCheck(id, label, names, ctx) {
  const found = names.find((name) => ctx.env && ctx.env[name]);
  return check(
    `env:${id}`,
    label,
    Boolean(found),
    found ? `available via ${found}` : `missing; set one of ${names.join(', ')}`,
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

function builderDirCheck(ctx) {
  const candidates = [
    ctx.env && ctx.env.AEM_CLIENTLIB_BUILDER_DIR,
    path.join(process.env.HOME || '', 'Projects/misc/aem-clientlib-builder'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => (
    ctx.pathExists && ctx.pathExists(path.join(candidate, 'src/lib/pomParser.js'))
      && ctx.pathExists(path.join(candidate, 'src/lib/commands/clientlib.js'))
  ));
  return check(
    'path:aem-clientlib-builder',
    'aem-clientlib-builder checkout',
    Boolean(found),
    found
      ? `found ${found}`
      : 'missing; set AEM_CLIENTLIB_BUILDER_DIR or clone adobe-rnd/aem-clientlib-builder',
  );
}

function dockerCheck(ctx, labels = {}) {
  const cliLabel = labels.cli || 'Docker CLI for AEM clientlib fallback';
  const daemonLabel = labels.daemon || 'Docker daemon for AEM clientlib fallback';
  if (!ctx.commandAvailable('docker')) {
    return check(
      'docker:cli',
      cliLabel,
      false,
      'Docker CLI not found on PATH',
    );
  }
  if (typeof ctx.runCommand !== 'function') {
    return check(
      'docker:daemon',
      daemonLabel,
      false,
      'Docker CLI found, but daemon was not probed',
    );
  }
  const result = ctx.runCommand('docker', ['info', '--format', '{{json .ServerVersion}}'], { timeoutMs: 3000 });
  if (result.status === 0) {
    const version = String(result.stdout || '').trim().replace(/^"|"$/g, '');
    return check(
      'docker:daemon',
      daemonLabel,
      true,
      version ? `Docker daemon reachable (${version})` : 'Docker daemon reachable',
    );
  }
  const output = `${result.stderr || ''}${result.stdout || ''}${result.error || ''}`.trim();
  return check(
    'docker:daemon',
    daemonLabel,
    false,
    output
      ? `Docker CLI found but daemon unavailable: ${output.split(/\r?\n/)[0]}; start Docker Desktop or the configured daemon`
      : 'Docker CLI found but daemon unavailable; start Docker Desktop or the configured daemon',
  );
}

function firstOutputLine(result) {
  return `${result.stderr || ''}${result.stdout || ''}${result.error || ''}`.trim().split(/\r?\n/)[0] || '';
}

function parseDockerDateMs(value) {
  const normalized = String(value || '').trim().replace(/(\.\d{3})\d+(Z|[+-]\d\d:\d\d)$/, '$1$2');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTime(ms) {
  return new Date(ms).toISOString();
}

function dockerImageCheck(ctx) {
  const image = (ctx.env && ctx.env.AEM_CLIENTLIB_BUILD_IMAGE) || AEM_CLIENTLIB_DOCKER_IMAGE;
  if (!ctx.commandAvailable('docker')) {
    return info(
      'docker:image',
      'AEM clientlib Docker fallback image',
      `not checked; Docker CLI not found; run npm run build:aem-clientlibs:docker-image after installing Docker`,
    );
  }
  if (typeof ctx.runCommand !== 'function') {
    return info(
      'docker:image',
      'AEM clientlib Docker fallback image',
      'not checked; Docker command runner unavailable',
    );
  }

  const result = ctx.runCommand(
    'docker',
    [
      'image',
      'inspect',
      image,
      '--format',
      `{{.Id}}\t{{.Created}}\t{{index .Config.Labels "${AEM_CLIENTLIB_DOCKERFILE_SHA_LABEL}"}}`,
    ],
    { timeoutMs: 3000 },
  );
  if (result.status !== 0) {
    const output = firstOutputLine(result);
    if (/no such image|not found|no such object|pull access denied/i.test(output)) {
      return check(
        'docker:image',
        'AEM clientlib Docker fallback image',
        false,
        output
          ? `image missing or unreadable (${image}): ${output}; run npm run build:aem-clientlibs:docker-image`
          : `image missing or unreadable (${image}); run npm run build:aem-clientlibs:docker-image`,
      );
    }
    if (/cannot connect|daemon unavailable|docker desktop|docker\.sock|permission denied|operation not permitted/i.test(output)) {
      return info(
        'docker:image',
        'AEM clientlib Docker fallback image',
        `not checked; Docker daemon unavailable: ${output || 'start Docker Desktop or the configured daemon'}`,
      );
    }
    return check(
      'docker:image',
      'AEM clientlib Docker fallback image',
      false,
      output
        ? `image unreadable (${image}): ${output}; run npm run build:aem-clientlibs:docker-image`
        : `image unreadable (${image}); run npm run build:aem-clientlibs:docker-image`,
    );
  }

  const [id, created, rawDockerfileSha] = String(result.stdout || '').trim().split('\t');
  const imageDockerfileSha = rawDockerfileSha && rawDockerfileSha !== '<no value>'
    ? rawDockerfileSha
    : null;
  const currentDockerfileSha = typeof ctx.fileSha256 === 'function'
    ? ctx.fileSha256(AEM_CLIENTLIB_DOCKERFILE)
    : null;
  if (currentDockerfileSha) {
    if (!imageDockerfileSha) {
      return check(
        'docker:image',
        'AEM clientlib Docker fallback image',
        false,
        `image stale (${image}); missing ${AEM_CLIENTLIB_DOCKERFILE_SHA_LABEL} label; run npm run build:aem-clientlibs:docker-image`,
      );
    }
    if (imageDockerfileSha !== currentDockerfileSha) {
      return check(
        'docker:image',
        'AEM clientlib Docker fallback image',
        false,
        `image stale (${image}); ${AEM_CLIENTLIB_DOCKERFILE} hash ${currentDockerfileSha.slice(0, 12)} does not match image label ${imageDockerfileSha.slice(0, 12)}; run npm run build:aem-clientlibs:docker-image`,
      );
    }
    return check(
      'docker:image',
      'AEM clientlib Docker fallback image',
      true,
      `current for ${AEM_CLIENTLIB_DOCKERFILE} (${String(id).slice(0, 20)})`,
    );
  }

  const imageCreatedMs = parseDockerDateMs(created);
  const dockerfileMtimeMs = typeof ctx.fileMtimeMs === 'function'
    ? ctx.fileMtimeMs(AEM_CLIENTLIB_DOCKERFILE)
    : null;
  if (imageCreatedMs && dockerfileMtimeMs && dockerfileMtimeMs > imageCreatedMs + 1000) {
    return check(
      'docker:image',
      'AEM clientlib Docker fallback image',
      false,
      `image stale (${image}); ${AEM_CLIENTLIB_DOCKERFILE} changed ${formatTime(dockerfileMtimeMs)} after image was created ${formatTime(imageCreatedMs)}; run npm run build:aem-clientlibs:docker-image`,
    );
  }

  const freshness = imageCreatedMs && dockerfileMtimeMs
    ? `current for ${AEM_CLIENTLIB_DOCKERFILE}`
    : `found ${image}; freshness not checked`;
  return check(
    'docker:image',
    'AEM clientlib Docker fallback image',
    true,
    id ? `${freshness} (${String(id).slice(0, 20)})` : freshness,
  );
}

function firstEnvValue(ctx, names) {
  const name = names.find((candidate) => ctx.env && ctx.env[candidate]);
  return name ? ctx.env[name] : null;
}

function resolveMaybeRelative(candidate, projectRoot) {
  if (!candidate) return null;
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(projectRoot || DEFAULT_PROJECT_ROOT, candidate);
}

function asoHealthUrl(baseUrl) {
  return `${String(baseUrl || DEFAULT_ASO_BASE_URL).replace(/\/+$/, '')}${ASO_HEALTH_PATH}`;
}

function asoCheckoutLooksValid(ctx, checkoutDir) {
  return Boolean(
    checkoutDir
    && ctx.pathExists(path.join(checkoutDir, 'Dockerfile.aso'))
    && ctx.pathExists(path.join(checkoutDir, 'docker-compose.local.yml'))
    && ctx.pathExists(path.join(checkoutDir, 'package.json')),
  );
}

function resolveAsoConfig(ctx) {
  const projectRoot = ctx.projectRoot || DEFAULT_PROJECT_ROOT;
  const home = (ctx.env && ctx.env.HOME) || process.env.HOME || '';
  const defaultDir = home ? path.join(home, 'Projects/misc/aso-shallow-validator') : null;
  const envCandidates = ASO_DIR_ENV_NAMES
    .map((name) => ({ name, dir: resolveMaybeRelative(ctx.env && ctx.env[name], projectRoot) }))
    .filter((item) => item.dir);
  const candidates = [
    ...envCandidates,
    ...(defaultDir ? [{ name: 'default', dir: defaultDir }] : []),
  ].filter((item, index, all) => (
    all.findIndex((candidate) => candidate.dir === item.dir) === index
  ));
  const found = candidates.find((candidate) => asoCheckoutLooksValid(ctx, candidate.dir));
  const checkoutDir = found ? found.dir : (candidates[0] && candidates[0].dir);
  const baseUrl = firstEnvValue(ctx, ASO_BASE_URL_ENV_NAMES) || DEFAULT_ASO_BASE_URL;
  const imageTag = firstEnvValue(ctx, ASO_IMAGE_ENV_NAMES) || DEFAULT_ASO_IMAGE_TAG;
  return {
    checkoutDir,
    checkoutFound: Boolean(found),
    checkoutSource: found ? found.name : null,
    candidates,
    baseUrl,
    healthUrl: asoHealthUrl(baseUrl),
    imageTag,
    composeFile: checkoutDir ? path.join(checkoutDir, 'docker-compose.local.yml') : null,
    dockerfile: checkoutDir ? path.join(checkoutDir, 'Dockerfile.aso') : null,
    packageJson: checkoutDir ? path.join(checkoutDir, 'package.json') : null,
  };
}

function asoCheckoutCheck(ctx) {
  const config = resolveAsoConfig(ctx);
  const tried = config.candidates.map((candidate) => `${candidate.name}:${candidate.dir}`).join(', ');
  return check(
    'path:aso-shallow-validator',
    'aso-shallow-validator checkout',
    config.checkoutFound,
    config.checkoutFound
      ? `found ${config.checkoutDir}`
      : `missing; set ASO_SHALLOW_VALIDATOR_DIR or clone aso-shallow-validator${tried ? ` (tried ${tried})` : ''}`,
  );
}

function asoFileCheck(ctx, fileName, label) {
  const config = resolveAsoConfig(ctx);
  const target = config.checkoutDir ? path.join(config.checkoutDir, fileName) : null;
  const exists = Boolean(target && ctx.pathExists(target));
  return check(
    `aso-file:${fileName}`,
    label,
    exists,
    exists ? 'found' : `${fileName} missing from ${config.checkoutDir || 'ASO checkout'}`,
  );
}

function readAsoPackageJson(ctx) {
  const config = resolveAsoConfig(ctx);
  if (!config.packageJson) return null;
  if (typeof ctx.readJsonAbsolute === 'function') {
    return ctx.readJsonAbsolute(config.packageJson);
  }
  return readJsonFile(config.packageJson);
}

function asoPackageScriptCheck(scriptName, ctx) {
  const packageJson = readAsoPackageJson(ctx);
  const scripts = (packageJson && packageJson.scripts) || {};
  return check(
    `package-script:aso:${scriptName}`,
    `ASO package.json exposes npm run ${scriptName}`,
    Boolean(scripts[scriptName]),
    scripts[scriptName] || `missing; ASO repo must own npm run ${scriptName}`,
  );
}

function asoImageTagInfo(ctx) {
  const config = resolveAsoConfig(ctx);
  return info(
    'aso:image-tag',
    'ASO Docker image tag',
    `${config.imageTag} (override with ASO_SHALLOW_VALIDATOR_IMAGE)`,
  );
}

function asoBaseUrlInfo(ctx) {
  const config = resolveAsoConfig(ctx);
  return info(
    'aso:base-url',
    'ASO base URL',
    `${config.baseUrl} (health ${config.healthUrl})`,
  );
}

function asoComposeStateCheck(ctx) {
  const config = resolveAsoConfig(ctx);
  if (!config.composeFile || !ctx.pathExists(config.composeFile)) {
    return info(
      'aso:compose-state',
      'ASO Docker Compose state',
      'not checked; docker-compose.local.yml missing',
    );
  }
  if (!ctx.commandAvailable('docker')) {
    return info(
      'aso:compose-state',
      'ASO Docker Compose state',
      'not checked; Docker CLI not found',
    );
  }
  if (typeof ctx.runCommand !== 'function') {
    return info(
      'aso:compose-state',
      'ASO Docker Compose state',
      'not checked; command runner unavailable',
    );
  }
  const result = ctx.runCommand(
    'docker',
    ['compose', '-f', config.composeFile, 'ps', '--format', 'json'],
    { cwd: config.checkoutDir, timeoutMs: 5000 },
  );
  if (result.status === 0) {
    const output = String(result.stdout || '').trim();
    const running = /\brunning\b/i.test(output);
    return check(
      'aso:compose-state',
      'ASO Docker Compose state',
      running,
      running ? 'service running under docker compose' : (output || 'compose project exists; no running service reported'),
      { required: false, status: running ? 'pass' : 'info' },
    );
  }
  const output = firstOutputLine(result);
  return info(
    'aso:compose-state',
    'ASO Docker Compose state',
    output ? `not checked; docker compose ps failed: ${output}` : 'not checked; docker compose ps failed',
  );
}

function asoHealthCheck(ctx) {
  const config = resolveAsoConfig(ctx);
  if (typeof ctx.runCommand !== 'function') {
    return check(
      'aso:health',
      'ASO health endpoint',
      false,
      `health check failed at ${config.healthUrl}: command runner unavailable`,
    );
  }
  const script = `
const url = process.argv[1];
const mod = require(url.startsWith('https:') ? 'node:https' : 'node:http');
const req = mod.get(url, { timeout: 1500 }, (res) => {
  res.resume();
  res.on('end', () => process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1));
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', (error) => {
  console.error(error.message);
  process.exit(2);
});
`;
  const result = ctx.runCommand(process.execPath, ['-e', script, config.healthUrl], { timeoutMs: 3000 });
  if (result.status === 0) {
    return check(
      'aso:health',
      'ASO health endpoint',
      true,
      `healthy at ${config.healthUrl}`,
    );
  }
  const output = firstOutputLine(result);
  return check(
    'aso:health',
    'ASO health endpoint',
    false,
    output ? `health check failed at ${config.healthUrl}: ${output}` : `health check failed at ${config.healthUrl}`,
  );
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

function dedupeChecks(checks) {
  const seen = new Set();
  return checks.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function adapterCheck(profile, ctx, description) {
  const wired = ctx.adapterExists(profile);
  return check(
    `adapter:${profile}`,
    description,
    wired,
    wired ? 'adapter file found' : 'not wired in this repo yet',
    { status: wired ? 'pass' : 'not-wired' },
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
    case 'aem-clientlibs':
      return [
        packageScriptCheck('build:aem-clientlibs', ctx),
        packageScriptCheck('build:aem-clientlibs:docker-image', ctx),
        packageScriptCheck('build:aem-clientlibs:docker', ctx),
        check(
          'script:.agents/scripts/aem-clientlib-build.js',
          '.agents/scripts/aem-clientlib-build.js exists',
          ctx.fileExists('.agents/scripts/aem-clientlib-build.js'),
          ctx.fileExists('.agents/scripts/aem-clientlib-build.js') ? 'found' : 'missing',
        ),
        check(
          'script:scripts/aem-clientlib-build-docker.sh',
          'scripts/aem-clientlib-build-docker.sh exists',
          ctx.fileExists('scripts/aem-clientlib-build-docker.sh'),
          ctx.fileExists('scripts/aem-clientlib-build-docker.sh') ? 'found' : 'missing',
        ),
        check(
          'dockerfile:aem-clientlib-builder',
          'Dockerfile for AEM clientlib builder fallback',
          ctx.fileExists('docker/aem-clientlib-builder.Dockerfile'),
          ctx.fileExists('docker/aem-clientlib-builder.Dockerfile') ? 'found' : 'missing',
        ),
        builderDirCheck(ctx),
        optionalCheck(dockerCheck(ctx)),
        optionalCheck(dockerImageCheck(ctx)),
      ];
    case 'field-google':
      return [
        envCheck('GOOGLE_CRUX_API_KEY', ctx),
        envCheck('GOOGLE_PAGESPEED_INSIGHTS_API_KEY', ctx),
      ];
    case 'field-aem-rum':
      return [
        envCheck('RUM_DOMAIN_KEY', ctx),
      ];
    case 'source-s3':
      return [
        envAnyCheck(
          'source-s3-access-key',
          'AWS access key for source-s3',
          ['SPACECAT_PROD_AWS_ACCESS_KEY_ID', 'SPACECAT_AWS_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID'],
          ctx,
        ),
        envAnyCheck(
          'source-s3-secret-key',
          'AWS secret key for source-s3',
          ['SPACECAT_PROD_AWS_SECRET_ACCESS_KEY', 'SPACECAT_AWS_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY'],
          ctx,
        ),
        commandCheck('aws', 'aws CLI is available', ctx),
        commandCheck('unzip', 'unzip command is available', ctx),
        commandCheck('mysticat', 'mysticat command is available for query-sites', ctx),
        unknown(
          'manual:source-s3-site-resolution',
          'query-sites site id resolution',
          'not verified by this zero-write doctor; resolve the URL to a SpaceCat site id before source-s3',
        ),
        check(
          'script:.agents/scripts/source-fetch.js',
          '.agents/scripts/source-fetch.js exists',
          ctx.fileExists('.agents/scripts/source-fetch.js'),
          ctx.fileExists('.agents/scripts/source-fetch.js') ? 'found' : 'missing',
        ),
      ];
    case 'publish-spacecat':
      return [
        commandCheck('mysticat', 'mysticat command is available', ctx),
        commandCheck('curl', 'curl command is available for api-service calls', ctx),
        commandCheck('jq', 'jq command is available for api-service JSON handling', ctx),
        unknown(
          'manual:publish-spacecat-auth',
          'sites-optimizer login and SpaceCat api-service access',
          'not verified by this zero-write doctor; run mysticat login/queries before publishing',
        ),
      ];
    case 'diagnose-cwv-agent':
      return [
        adapterCheck(
          'diagnose-cwv-agent',
          ctx,
          'diagnose-cwv-agent provider adapter',
        ),
        info(
          'future:diagnose-cwv-agent',
          'local cwv-agent POC',
          'not invoked; the local POC is superseded for workbench diagnosis orchestration',
        ),
      ];
    case 'validate-aso':
      return [
        packageScriptCheck('validate:aso', ctx),
        asoCheckoutCheck(ctx),
        asoFileCheck(ctx, 'Dockerfile.aso', 'ASO-owned Dockerfile.aso'),
        asoFileCheck(ctx, 'docker-compose.local.yml', 'ASO-owned docker-compose.local.yml'),
        asoPackageScriptCheck('image:build', ctx),
        asoPackageScriptCheck('image:smoke', ctx),
        dockerCheck(ctx, {
          cli: 'Docker CLI for ASO local service',
          daemon: 'Docker daemon for ASO local service',
        }),
        asoImageTagInfo(ctx),
        asoBaseUrlInfo(ctx),
        asoComposeStateCheck(ctx),
        asoHealthCheck(ctx),
        adapterCheck(
          'validate-aso',
          ctx,
          'validate-aso validation job adapter',
        ),
      ];
    case 'adobe-full':
      return dedupeChecks([
        ...buildProfileOnlyChecks('field-google', ctx),
        ...buildProfileOnlyChecks('field-aem-rum', ctx),
        ...buildProfileOnlyChecks('source-s3', ctx),
        ...buildProfileOnlyChecks('publish-spacecat', ctx),
        ...buildProfileOnlyChecks('diagnose-cwv-agent', ctx),
        ...buildProfileOnlyChecks('validate-aso', ctx),
      ]);
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
  resolveAsoConfig,
  runDoctor,
  formatDoctorText,
  formatDoctorJson,
};
