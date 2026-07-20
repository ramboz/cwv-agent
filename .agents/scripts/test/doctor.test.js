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

test('optional source-s3 profile checks AWS env plus aws and unzip commands', () => {
  const context = makeContext({
    env: {
      SPACECAT_PROD_AWS_ACCESS_KEY_ID: 'test-access-key',
      SPACECAT_PROD_AWS_SECRET_ACCESS_KEY: 'test-secret-key',
    },
    commandAvailable(command) {
      context.commandCalls.push(command);
      return command === 'unzip';
    },
  });
  const result = runDoctor({ profile: 'source-s3', context });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'not-ready');
  assert.equal(findCheck(result, 'env:source-s3-access-key').status, 'pass');
  assert.equal(findCheck(result, 'env:source-s3-secret-key').status, 'pass');
  assert.equal(findCheck(result, 'command:aws').status, 'fail');
  assert.equal(findCheck(result, 'command:unzip').status, 'pass');
  assert.equal(findCheck(result, 'command:mysticat').status, 'fail');
  assert.equal(findCheck(result, 'manual:source-s3-site-resolution').status, 'unknown');
  assert.deepEqual(context.commandCalls, ['aws', 'unzip', 'mysticat']);
});

test('aem-clientlibs profile checks builder wrapper and Docker fallback readiness', () => {
  const context = makeContext({
    pathExists(absolutePath) {
      return String(absolutePath).includes('aem-clientlib-builder');
    },
    commandAvailable(command) {
      context.commandCalls.push(command);
      return command === 'docker';
    },
    runCommand(command, args) {
      assert.equal(command, 'docker');
      if (args[0] === 'info') {
        assert.deepEqual(args, ['info', '--format', '{{json .ServerVersion}}']);
        return { status: 0, stdout: '"24.0.0"\n', stderr: '', error: null };
      }
      if (args[0] === 'image') {
        assert.deepEqual(args, [
          'image',
          'inspect',
          'cwv-aem-clientlib-builder:node20',
          '--format',
          '{{.Id}}\t{{.Created}}\t{{index .Config.Labels "org.cwv-agent.aem-clientlib-builder.dockerfile-sha"}}',
        ]);
        return { status: 0, stdout: 'sha256:abcdef\t2026-06-21T12:00:00.000000000Z\tcurrent-sha\n', stderr: '', error: null };
      }
      throw new Error(`unexpected docker args: ${args.join(' ')}`);
    },
    fileSha256(relativePath) {
      assert.equal(relativePath, 'docker/aem-clientlib-builder.Dockerfile');
      return 'current-sha';
    },
  });
  const result = runDoctor({ profile: 'aem-clientlibs', context });

  assert.equal(result.ok, true);
  assert.equal(result.profileStatus, 'supported');
  assert.equal(findCheck(result, 'package-script:build:aem-clientlibs').status, 'pass');
  assert.equal(findCheck(result, 'path:aem-clientlib-builder').status, 'pass');
  assert.equal(findCheck(result, 'docker:daemon').status, 'pass');
  assert.equal(findCheck(result, 'docker:image').status, 'pass');
});

test('aem-clientlibs profile distinguishes Docker CLI from unavailable daemon', () => {
  const context = makeContext({
    pathExists(absolutePath) {
      return String(absolutePath).includes('aem-clientlib-builder');
    },
    commandAvailable(command) {
      context.commandCalls.push(command);
      return command === 'docker';
    },
    runCommand() {
      return { status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon', error: null };
    },
  });
  const result = runDoctor({ profile: 'aem-clientlibs', context });

  assert.equal(result.ok, true, 'Docker fallback readiness is optional for native builder setup');
  assert.equal(findCheck(result, 'docker:daemon').status, 'fail');
  assert.equal(findCheck(result, 'docker:daemon').required, false);
  assert.match(findCheck(result, 'docker:daemon').detail, /daemon unavailable/i);
});

test('aem-clientlibs profile reports missing Docker image as optional fallback work', () => {
  const context = makeContext({
    pathExists(absolutePath) {
      return String(absolutePath).includes('aem-clientlib-builder');
    },
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
  });
  const result = runDoctor({ profile: 'aem-clientlibs', context });
  const image = findCheck(result, 'docker:image');

  assert.equal(result.ok, true, 'Docker fallback image is optional for native builder setup');
  assert.equal(image.status, 'fail');
  assert.equal(image.required, false);
  assert.match(image.detail, /image missing/i);
  assert.match(image.detail, /build:aem-clientlibs:docker-image/);
});

test('aem-clientlibs profile reports stale Docker image relative to Dockerfile', () => {
  const context = makeContext({
    pathExists(absolutePath) {
      return String(absolutePath).includes('aem-clientlib-builder');
    },
    commandAvailable(command) {
      context.commandCalls.push(command);
      return command === 'docker';
    },
    runCommand(command, args) {
      assert.equal(command, 'docker');
      if (args[0] === 'info') return { status: 0, stdout: '"24.0.0"\n', stderr: '', error: null };
      if (args[0] === 'image') {
        return { status: 0, stdout: 'sha256:abcdef\t2026-06-19T12:00:00.000000000Z\told-sha\n', stderr: '', error: null };
      }
      throw new Error(`unexpected docker args: ${args.join(' ')}`);
    },
    fileSha256(relativePath) {
      assert.equal(relativePath, 'docker/aem-clientlib-builder.Dockerfile');
      return 'current-sha';
    },
  });
  const result = runDoctor({ profile: 'aem-clientlibs', context });
  const image = findCheck(result, 'docker:image');

  assert.equal(result.ok, true, 'stale fallback image does not block host builder readiness');
  assert.equal(image.status, 'fail');
  assert.equal(image.required, false);
  assert.match(image.detail, /image stale/i);
  assert.match(image.detail, /docker\/aem-clientlib-builder\.Dockerfile/);
});

test('source-s3 accepts source-fetch AWS credential aliases and still reports site resolution unknown', () => {
  const context = makeContext({
    env: {
      AWS_ACCESS_KEY_ID: 'test-access-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
    },
    commandAvailable(command) {
      context.commandCalls.push(command);
      return command === 'aws' || command === 'unzip' || command === 'mysticat';
    },
  });
  const result = runDoctor({ profile: 'source-s3', context });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'not-ready');
  assert.equal(findCheck(result, 'env:source-s3-access-key').status, 'pass');
  assert.match(findCheck(result, 'env:source-s3-access-key').detail, /AWS_ACCESS_KEY_ID/);
  assert.equal(findCheck(result, 'env:source-s3-secret-key').status, 'pass');
  assert.match(findCheck(result, 'env:source-s3-secret-key').detail, /AWS_SECRET_ACCESS_KEY/);
  assert.equal(findCheck(result, 'command:mysticat').status, 'pass');
  assert.equal(findCheck(result, 'manual:source-s3-site-resolution').status, 'unknown');
});

test('publish-spacecat does not report ready when auth/API readiness is unknown', () => {
  const context = makeContext({
    commandAvailable(command) {
      context.commandCalls.push(command);
      return command === 'mysticat' || command === 'curl';
    },
  });
  const result = runDoctor({ profile: 'publish-spacecat', context });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'not-ready');
  assert.equal(findCheck(result, 'command:mysticat').status, 'pass');
  assert.equal(findCheck(result, 'command:curl').status, 'pass');
  assert.equal(findCheck(result, 'command:jq').status, 'fail');
  assert.equal(findCheck(result, 'manual:publish-spacecat-auth').status, 'unknown');
  assert.equal(findCheck(result, 'manual:publish-spacecat-auth').required, true);
});

test('adobe-full dedupes shared provider checks by id', () => {
  const context = makeContext({
    commandAvailable(command) {
      context.commandCalls.push(command);
      return ['aws', 'unzip', 'mysticat', 'curl', 'jq'].includes(command);
    },
  });
  const result = runDoctor({ profile: 'adobe-full', context });
  const ids = result.checks.map((item) => item.id);

  assert.equal(result.ok, false, 'future/manual provider checks still block adobe-full');
  assert.equal(result.profileStatus, 'partial');
  assert.equal(ids.filter((id) => id === 'command:mysticat').length, 1);
  assert.equal(findCheck(result, 'command:curl').status, 'pass');
  assert.equal(findCheck(result, 'command:jq').status, 'pass');
});

test('future diagnose-cwv-agent profile is honest and does not probe local cwv-agent', () => {
  const context = makeContext();
  const result = runDoctor({ profile: 'diagnose-cwv-agent', context });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'not-wired');
  assert.equal(findCheck(result, 'adapter:diagnose-cwv-agent').status, 'not-wired');
  assert.deepEqual(context.commandCalls, [], 'future provider must not try to run or find cwv-agent');
  assert.match(findCheck(result, 'future:diagnose-cwv-agent').detail, /not invoked/);
});

test('validate-aso profile checks local ASO checkout, compose, smoke scripts, and health', () => {
  const asoDir = '/tmp/aso-shallow-validator';
  const context = makeContext({
    env: {
      ASO_SHALLOW_VALIDATOR_DIR: asoDir,
      ASO_SHALLOW_VALIDATOR_BASE_URL: 'http://127.0.0.1:8787',
      ASO_SHALLOW_VALIDATOR_IMAGE: 'aso-shallow-validator:test',
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
      if (command === process.execPath) {
        return { status: 0, stdout: '{"status":"ok"}', stderr: '', error: null };
      }
      assert.equal(command, 'docker');
      if (args[0] === 'info') return { status: 0, stdout: '"24.0.0"\n', stderr: '', error: null };
      if (args[0] === 'compose') {
        assert.deepEqual(args, [
          'compose',
          '-f',
          path.join(asoDir, 'docker-compose.local.yml'),
          'ps',
          '--format',
          'json',
        ]);
        assert.equal(options.cwd, asoDir);
        return { status: 0, stdout: '{"Service":"aso","State":"running"}\n', stderr: '', error: null };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
    adapterExists(profile) {
      return profile === 'validate-aso';
    },
  });
  const result = runDoctor({ profile: 'validate-aso', context });

  assert.equal(result.ok, true);
  assert.equal(result.profileStatus, 'partial');
  assert.equal(findCheck(result, 'path:aso-shallow-validator').status, 'pass');
  assert.equal(findCheck(result, 'package-script:aso:image:build').status, 'pass');
  assert.equal(findCheck(result, 'package-script:aso:image:smoke').status, 'pass');
  assert.equal(findCheck(result, 'aso:compose-state').status, 'pass');
  assert.equal(findCheck(result, 'aso:health').status, 'pass');
  assert.equal(findCheck(result, 'adapter:validate-aso').status, 'pass');
  assert.match(findCheck(result, 'aso:image-tag').detail, /aso-shallow-validator:test/);
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
