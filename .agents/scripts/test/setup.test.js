#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  formatSetupJson,
  formatSetupText,
  parseArgs,
  runSetup,
} from '../setup.js';

function makeContext(root, overrides = {}) {
  const commandCalls = [];
  const context = {
    projectRoot: root,
    env: {},
    nodeVersion: '20.11.1',
    packageJson: {
      scripts: {
        doctor: 'node .agents/scripts/doctor.js',
        measure: 'node .agents/scripts/launcher.js',
        setup: 'node .agents/scripts/setup.js',
        'build:aem-clientlibs': 'node .agents/scripts/aem-clientlib-build.js',
        'build:aem-clientlibs:docker-image': 'node .agents/scripts/aem-clientlib-docker-image.js',
        'build:aem-clientlibs:docker': 'bash scripts/aem-clientlib-build-docker.sh',
        'validate:aso': 'node .agents/scripts/aso-validate.js',
      },
    },
    fileExists() {
      return true;
    },
    pathWritable() {
      return true;
    },
    moduleAvailable() {
      return true;
    },
    commandAvailable(command) {
      commandCalls.push(command);
      return false;
    },
    runCommand() {
      return { status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon', error: null };
    },
    scriptHealth() {
      return { ok: true, detail: 'node --check passed' };
    },
    pathExists() {
      return false;
    },
    readJsonAbsolute() {
      return null;
    },
    adapterExists() {
      return false;
    },
    commandCalls,
  };
  return { ...context, ...overrides };
}

function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwv-setup-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('local setup creates output directories and does not require optional providers', () => withTempRoot((root) => {
  const result = runSetup({ profile: 'local', context: makeContext(root) });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.steps.filter((step) => step.status === 'fixed').length, 3);
  assert.equal(fs.existsSync(path.join(root, 'progress')), true);
  assert.equal(
    result.steps.some((step) => /SPACECAT|RUM|GOOGLE|Docker|ASO/i.test(`${step.id} ${step.label}`)),
    false,
  );
}));

test('dry-run setup reports directory creation as skipped', () => withTempRoot((root) => {
  const result = runSetup({ profile: 'local', dryRun: true, context: makeContext(root) });

  assert.equal(result.ok, true);
  assert.equal(result.steps.filter((step) => step.id.startsWith('setup-dir:') && step.status === 'skipped').length, 3);
  assert.equal(fs.existsSync(path.join(root, 'progress')), false);
}));

test('aem-clientlibs setup surfaces Docker daemon unavailable distinctly from missing CLI', () => withTempRoot((root) => {
  const context = makeContext(root, {
    commandAvailable(command) {
      context.commandCalls.push(command);
      return command === 'docker';
    },
  });
  const result = runSetup({ profile: 'aem-clientlibs', dryRun: true, context });
  const docker = result.steps.find((step) => step.id === 'docker:daemon');

  assert.equal(docker.status, 'skipped');
  assert.match(docker.detail, /daemon unavailable/i);
  assert.match(docker.command, /start Docker Desktop/);
}));

test('aem-clientlibs setup includes Docker image rebuild retry guidance', () => withTempRoot((root) => {
  const context = makeContext(root, {
    commandAvailable(command) {
      context.commandCalls.push(command);
      return command === 'docker';
    },
    runCommand(command, args) {
      assert.equal(command, 'docker');
      if (args[0] === 'info') return { status: 0, stdout: '"24.0.0"\n', stderr: '', error: null };
      if (args[0] === 'image') {
        return {
          status: 1,
          stdout: '',
          stderr: 'Error response from daemon: No such image: cwv-aem-clientlib-builder:node20',
          error: null,
        };
      }
      throw new Error(`unexpected docker args: ${args.join(' ')}`);
    },
    pathExists(absolutePath) {
      return String(absolutePath).includes('aem-clientlib-builder');
    },
  });
  const result = runSetup({ profile: 'aem-clientlibs', dryRun: true, context });
  const image = result.steps.find((step) => step.id === 'docker:image');

  assert.equal(image.status, 'skipped');
  assert.match(image.detail, /image missing/i);
  assert.equal(image.command, 'npm run build:aem-clientlibs:docker-image');
}));

test('source-s3 setup includes exact missing env retry guidance', () => withTempRoot((root) => {
  const result = runSetup({ profile: 'source-s3', dryRun: true, context: makeContext(root) });
  const accessKey = result.steps.find((step) => step.id === 'env:source-s3-access-key');

  assert.equal(result.ok, false);
  assert.equal(accessKey.status, 'missing');
  assert.equal(accessKey.env, 'SPACECAT_PROD_AWS_ACCESS_KEY_ID');
  assert.match(accessKey.command, /SPACECAT_PROD_AWS_ACCESS_KEY_ID/);
}));

test('formatters expose setup status as text and JSON', () => withTempRoot((root) => {
  const result = runSetup({ profile: 'local', dryRun: true, context: makeContext(root) });
  const json = JSON.parse(formatSetupJson(result));
  const text = formatSetupText(result);

  assert.equal(json.profile, 'local');
  assert.match(text, /cwv setup: local/);
  assert.match(text, /Result: ready/);
}));

test('parseArgs supports setup profile dry-run json flags', () => {
  assert.deepEqual(
    parseArgs(['--profile', 'aem-clientlibs', '--dry-run', '--json']),
    {
      profile: 'aem-clientlibs',
      format: 'json',
      dryRun: true,
      asoBuild: false,
      asoSmoke: false,
      asoStart: false,
      asoStop: false,
      help: false,
    },
  );
});

test('parseArgs supports validate-aso setup action flags', () => {
  assert.deepEqual(
    parseArgs(['--profile', 'validate-aso', '--aso-build', '--aso-smoke', '--aso-start', '--aso-stop']),
    {
      profile: 'validate-aso',
      format: 'text',
      dryRun: false,
      asoBuild: true,
      asoSmoke: true,
      asoStart: true,
      asoStop: true,
      help: false,
    },
  );
});

test('validate-aso setup explicitly runs ASO build, smoke, start, and stop actions', () => withTempRoot((root) => {
  const asoDir = path.join(root, 'aso-shallow-validator');
  const commands = [];
  const context = makeContext(root, {
    env: {
      ASO_SHALLOW_VALIDATOR_DIR: asoDir,
    },
    pathExists(absolutePath) {
      return [
        path.join(asoDir, 'Dockerfile.aso'),
        path.join(asoDir, 'docker-compose.local.yml'),
        path.join(asoDir, 'package.json'),
      ].includes(String(absolutePath));
    },
    readJsonAbsolute(absolutePath) {
      assert.equal(absolutePath, path.join(asoDir, 'package.json'));
      return {
        scripts: {
          'image:build': 'docker build -f Dockerfile.aso .',
          'image:smoke': 'node scripts/smoke-image.js',
        },
      };
    },
    commandAvailable(command) {
      context.commandCalls.push(command);
      return command === 'docker';
    },
    runCommand(command, args, options = {}) {
      commands.push({ command, args, cwd: options.cwd });
      if (command === process.execPath) return { status: 0, stdout: '{"status":"ok"}', stderr: '', error: null };
      if (command === 'docker' && args[0] === 'info') return { status: 0, stdout: '"24.0.0"\n', stderr: '', error: null };
      if (command === 'docker' && args[0] === 'compose' && args[3] === 'ps') {
        return { status: 0, stdout: '{"Service":"aso","State":"running"}\n', stderr: '', error: null };
      }
      return { status: 0, stdout: 'ok\n', stderr: '', error: null };
    },
    adapterExists(profile) {
      return profile === 'validate-aso';
    },
  });

  const result = runSetup({
    profile: 'validate-aso',
    context,
    asoBuild: true,
    asoSmoke: true,
    asoStart: true,
    asoStop: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.steps.find((step) => step.id === 'aso:image-build').status, 'fixed');
  assert.equal(result.steps.find((step) => step.id === 'aso:image-smoke').status, 'fixed');
  assert.equal(result.steps.find((step) => step.id === 'aso:compose-start').status, 'fixed');
  assert.equal(result.steps.find((step) => step.id === 'aso:compose-stop').status, 'fixed');
  assert.deepEqual(commands.filter((item) => item.command === 'npm').map((item) => item.args), [
    ['run', 'image:build'],
    ['run', 'image:smoke'],
  ]);
  assert.deepEqual(commands.find((item) => item.command === 'docker' && item.args.includes('up')).args, [
    'compose',
    '-f',
    path.join(asoDir, 'docker-compose.local.yml'),
    'up',
    '-d',
  ]);
  assert.deepEqual(commands.find((item) => item.command === 'docker' && item.args.includes('down')).args, [
    'compose',
    '-f',
    path.join(asoDir, 'docker-compose.local.yml'),
    'down',
  ]);
}));
