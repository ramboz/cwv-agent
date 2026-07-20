#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDefaultContext,
  formatDoctorJson,
  formatDoctorText,
  parseArgs,
  parseDotEnv,
  runDoctor,
} from '../doctor.js';

function makeContext(overrides = {}) {
  const commandCalls = [];
  const context = {
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
        test: 'node --test',
      },
    },
    fileExists(relativePath) {
      return !String(relativePath).includes('missing');
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

function findCheck(result, id) {
  return result.checks.find((item) => item.id === id);
}

test('local profile passes when only local requirements are present', () => {
  const result = runDoctor({ profile: 'local', context: makeContext() });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.profileStatus, 'supported');
  assert.equal(findCheck(result, 'node:version').status, 'pass');
  assert.equal(findCheck(result, 'module:puppeteer').status, 'pass');
  assert.equal(
    result.checks.some((item) => /SPACECAT|RUM|GOOGLE/.test(item.id)),
    false,
    'local profile must not require optional integration env vars',
  );
});

test('local profile fails when a required local dependency is missing', () => {
  const context = makeContext({
    moduleAvailable(name) {
      return name !== 'puppeteer';
    },
  });
  const result = runDoctor({ profile: 'local', context });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'not-ready');
  assert.equal(findCheck(result, 'module:puppeteer').status, 'fail');
  assert.match(findCheck(result, 'module:puppeteer').detail, /npm ci/);
});

test('optional field-google profile reports missing env vars without writes', () => {
  const result = runDoctor({ profile: 'field-google', context: makeContext() });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'not-ready');
  assert.equal(findCheck(result, 'env:GOOGLE_CRUX_API_KEY').status, 'fail');
  assert.equal(findCheck(result, 'env:GOOGLE_PAGESPEED_INSIGHTS_API_KEY').status, 'fail');
});

test('stealth-headful accepts common Chrome probes beyond google-chrome', () => {
  const context = makeContext({
    commandAvailable(command) {
      context.commandCalls.push(command);
      return command === 'chromium';
    },
  });
  const result = runDoctor({ profile: 'stealth-headful', context });

  assert.equal(findCheck(result, 'chrome:headful').status, 'pass');
  assert.match(findCheck(result, 'chrome:headful').detail, /chromium/);
  assert.ok(context.commandCalls.includes('google-chrome'), 'probes the Linux Chrome command first');
  assert.ok(context.commandCalls.includes('chromium'), 'falls through to Chromium variants');
});

test('default pathWritable rejects a file occupying an output directory path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwv-doctor-'));
  try {
    fs.writeFileSync(path.join(root, 'progress'), 'not a directory');
    const context = createDefaultContext(root);
    assert.equal(context.pathWritable('progress'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local profile fails when a core script syntax check fails', () => {
  const context = makeContext({
    scriptHealth(relativePath) {
      if (relativePath === '.agents/scripts/launcher.js') {
        return { ok: false, detail: 'SyntaxError: unexpected token' };
      }
      return { ok: true, detail: 'node --check passed' };
    },
  });
  const result = runDoctor({ profile: 'local', context });

  assert.equal(result.ok, false);
  assert.equal(findCheck(result, 'script-health:.agents/scripts/launcher.js').status, 'fail');
  assert.match(findCheck(result, 'script-health:.agents/scripts/launcher.js').detail, /SyntaxError/);
});

test('json and text formatters expose machine and human readable output', () => {
  const result = runDoctor({ profile: 'local', context: makeContext() });
  const json = JSON.parse(formatDoctorJson(result));
  const text = formatDoctorText(result);

  assert.equal(json.profile, 'local');
  assert.equal(json.status, 'ready');
  assert.match(text, /cwv doctor: local/);
  assert.match(text, /Result: ready/);
});

test('parseArgs supports npm run doctor -- --profile local --json', () => {
  assert.deepEqual(
    parseArgs(['--profile', 'local', '--json']),
    { profile: 'local', format: 'json', help: false },
  );
  assert.deepEqual(
    parseArgs(['--profile=field-aem-rum', '--format=json']),
    { profile: 'field-aem-rum', format: 'json', help: false },
  );
});

test('parseDotEnv reads simple KEY=value pairs and ignores comments', () => {
  assert.deepEqual(parseDotEnv(`
    # comment
    RUM_DOMAIN_KEY=abc123
    EMPTY=
    QUOTED="hello world"
  `), {
    RUM_DOMAIN_KEY: 'abc123',
    EMPTY: '',
    QUOTED: 'hello world',
  });
});
