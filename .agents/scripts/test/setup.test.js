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
    result.steps.some((step) => /GOOGLE|Docker/i.test(`${step.id} ${step.label}`)),
    false,
  );
}));

test('dry-run setup reports directory creation as skipped', () => withTempRoot((root) => {
  const result = runSetup({ profile: 'local', dryRun: true, context: makeContext(root) });

  assert.equal(result.ok, true);
  assert.equal(result.steps.filter((step) => step.id.startsWith('setup-dir:') && step.status === 'skipped').length, 3);
  assert.equal(fs.existsSync(path.join(root, 'progress')), false);
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
    parseArgs(['--profile', 'field-google', '--dry-run', '--json']),
    {
      profile: 'field-google',
      format: 'json',
      dryRun: true,
      help: false,
    },
  );
});

