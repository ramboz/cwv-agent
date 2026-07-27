#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXECUTION_PROFILES,
  createDefaultContext,
  runDoctor,
} from './doctor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIRS = ['progress', 'results', 'screenshots'];

function parseArgs(argv) {
  const parsed = {
    profile: 'local',
    format: 'text',
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--json') {
      parsed.format = 'json';
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
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

function remediationFor(check) {
  if (check.id === 'install:node-modules' || check.id.startsWith('module:')) {
    return { command: 'npm ci' };
  }
  if (check.id === 'vendor:web-vitals-attribution') {
    return { command: 'npm ci' };
  }
  if (check.id.startsWith('env:GOOGLE_')) {
    return { env: check.id.slice('env:'.length), command: 'copy .env.example .env and fill Google API keys' };
  }
  if (check.id.startsWith('command:')) {
    const command = check.id.slice('command:'.length);
    return { command: `install ${command} and ensure it is on PATH` };
  }
  if (check.id.startsWith('adapter:')) {
    return { command: `adapter not wired yet for ${check.id.slice('adapter:'.length)}` };
  }
  return {};
}

function setupStatusFor(check) {
  if (check.status === 'pass') return 'ready';
  if (check.status === 'info') return 'skipped';
  return check.required ? 'missing' : 'skipped';
}

function setupStepFromCheck(check) {
  return {
    id: check.id,
    label: check.label,
    status: setupStatusFor(check),
    required: check.required,
    detail: check.detail,
    ...(check.status === 'pass' || check.status === 'info' ? {} : remediationFor(check)),
  };
}

function ensureOutputDirs(projectRoot, dryRun) {
  return OUTPUT_DIRS.map((dir) => {
    const target = path.join(projectRoot, dir);
    if (fs.existsSync(target)) {
      return {
        id: `setup-dir:${dir}`,
        label: `${dir}/ output directory`,
        status: fs.statSync(target).isDirectory() ? 'ready' : 'missing',
        required: true,
        detail: fs.statSync(target).isDirectory() ? 'already present' : 'path exists but is not a directory',
        command: fs.statSync(target).isDirectory() ? undefined : `remove or rename ${dir}, then rerun npm run setup`,
      };
    }
    if (dryRun) {
      return {
        id: `setup-dir:${dir}`,
        label: `${dir}/ output directory`,
        status: 'skipped',
        required: false,
        detail: 'dry run; would create directory',
        command: `mkdir -p ${dir}`,
      };
    }
    try {
      fs.mkdirSync(target, { recursive: true });
      return {
        id: `setup-dir:${dir}`,
        label: `${dir}/ output directory`,
        status: 'fixed',
        required: true,
        detail: 'created',
      };
    } catch (error) {
      return {
        id: `setup-dir:${dir}`,
        label: `${dir}/ output directory`,
        status: 'missing',
        required: true,
        detail: error.message,
        command: `mkdir -p ${dir}`,
      };
    }
  });
}

function summarizeSteps(profile, profileStatus, dryRun, steps) {
  const blocking = steps.filter((step) => step.required && step.status === 'missing');
  const notWired = steps.some((step) => step.id.startsWith('adapter:') && step.status === 'missing');
  return {
    schemaVersion: '1.0',
    profile,
    profileStatus,
    dryRun,
    ok: blocking.length === 0,
    status: blocking.length === 0 ? 'ready' : (notWired ? 'not-wired' : 'not-ready'),
    steps,
    summary: {
      ready: steps.filter((step) => step.status === 'ready').length,
      fixed: steps.filter((step) => step.status === 'fixed').length,
      missing: steps.filter((step) => step.status === 'missing').length,
      skipped: steps.filter((step) => step.status === 'skipped').length,
      blocking: blocking.length,
    },
  };
}

function runSetup({
  profile = 'local',
  dryRun = false,
  context = createDefaultContext(DEFAULT_PROJECT_ROOT),
} = {}) {
  const doctor = runDoctor({ profile, context });
  const steps = [
    ...doctor.checks.map(setupStepFromCheck),
    ...ensureOutputDirs(context.projectRoot || DEFAULT_PROJECT_ROOT, dryRun),
  ];
  return summarizeSteps(profile, doctor.profileStatus, dryRun, steps);
}

function formatSetupText(result) {
  const lines = [
    `cwv setup: ${result.profile}`,
    `profile status: ${result.profileStatus}`,
    `mode: ${result.dryRun ? 'dry-run' : 'apply'}`,
    '',
  ];
  for (const step of result.steps) {
    const required = step.required ? 'required' : 'optional';
    const detail = step.detail ? `: ${step.detail}` : '';
    const retry = step.command ? ` (retry: ${step.command})` : '';
    lines.push(`${step.status.toUpperCase()} [${required}] ${step.label}${detail}${retry}`);
  }
  lines.push('');
  lines.push(`Result: ${result.status}`);
  return `${lines.join('\n')}\n`;
}

function formatSetupJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function usage() {
  return `Usage: npm run setup -- [--profile <name>] [--dry-run] [--json]\n\nProfiles: ${Object.keys(EXECUTION_PROFILES).join(', ')}\n`;
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
    const result = runSetup({
      profile: args.profile,
      dryRun: args.dryRun,
    });
    process.stdout.write(args.format === 'json' ? formatSetupJson(result) : formatSetupText(result));
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
  formatSetupJson,
  formatSetupText,
  parseArgs,
  runSetup,
};
