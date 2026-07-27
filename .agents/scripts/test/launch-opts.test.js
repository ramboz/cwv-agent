import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLaunchOptions, applyStealthPage } from '../launch-opts.js';

test('buildLaunchOptions: default launch stays plain headless Chromium', () => {
  assert.deepEqual(buildLaunchOptions(false), {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
});

test('buildLaunchOptions: stealth launches headful real Chrome with automation tells scrubbed', () => {
  const opts = buildLaunchOptions(true);

  assert.equal(opts.headless, false);
  assert.equal(opts.channel, 'chrome');
  assert.deepEqual(opts.ignoreDefaultArgs, ['--enable-automation']);
  assert.ok(opts.args.includes('--no-sandbox'));
  assert.ok(opts.args.includes('--disable-setuid-sandbox'));
  assert.ok(opts.args.includes('--disable-blink-features=AutomationControlled'));
});

test('applyStealthPage installs Accept-Language and a new-document runtime scrub', async () => {
  const calls = { headers: [], scripts: [] };
  const page = {
    async setExtraHTTPHeaders(headers) { calls.headers.push(headers); },
    async evaluateOnNewDocument(fn) { calls.scripts.push(fn); },
  };

  await applyStealthPage(page);

  assert.deepEqual(calls.headers, [{ 'Accept-Language': 'en-US,en;q=0.9' }]);
  assert.equal(calls.scripts.length, 1);
  assert.equal(typeof calls.scripts[0], 'function');
  const source = String(calls.scripts[0]);
  assert.match(source, /navigator/);
  assert.match(source, /webdriver/);
  assert.match(source, /window\.chrome/);
});
