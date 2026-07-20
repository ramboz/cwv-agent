import test from 'node:test';
import assert from 'node:assert/strict';
import { KnownDevices } from 'puppeteer';

import {
  PROFILES,
  DEFAULT_PROFILE,
  FORM_FACTOR_TO_PROFILE,
  getProfile,
  resolveViewport,
  resolveMobileEmulation,
  mapFormFactorToProfile,
  applyProfile,
} from '../profiles.js';

// A minimal Puppeteer Page double that records what applyProfile() asked for,
// so we can assert the apply path (device emulation / viewport / network / CPU)
// without launching a browser.
function makeFakePage() {
  const calls = { emulate: [], viewport: [], net: [], cpu: [] };
  return {
    calls,
    async emulate(device) { calls.emulate.push(device); },
    async setViewport(vp) { calls.viewport.push(vp); },
    async emulateNetworkConditions(conditions) { calls.net.push(conditions); },
    async emulateCPUThrottling(rate) { calls.cpu.push(rate); },
  };
}

// A Puppeteer namespace double whose `.KnownDevices` resolves a realistically
// shaped device (real entries carry name + userAgent + a mobile viewport).
const fakePuppeteer = {
  KnownDevices: {
    'iPhone 13': {
      name: 'iPhone 13',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    },
  },
};

// The Lighthouse desktop preset (DESKTOP_EMULATION_METRICS) — see profiles.js.
const DESKTOP_VIEWPORT = { width: 1350, height: 940, deviceScaleFactor: 1 };

// ---------------------------------------------------------------------------
// desktop-slow-1xcpu — slow-desktop cold-load CLS repro profile
//
// Added so desktop CLS that a warm edge cache hides (fast TTFB delivers images
// before first paint → lab CLS 0 vs failing field p75) can be reproduced with
// the sanctioned tooling instead of an ad-hoc Puppeteer harness. Numbers are
// calibrated from the about.ups.com /our-stories desktop-CLS repro
// (600/300 kbps + 500 ms + cold cache reproduced CLS 0.347 where
// desktop-cable-1xcpu read 0.000).
// ---------------------------------------------------------------------------

test('desktop-slow-1xcpu is registered with the repro calibration', () => {
  const p = PROFILES['desktop-slow-1xcpu'];
  assert.ok(p, 'profile exists in the PROFILES table');
  assert.equal(p.download, (600 * 1024) / 8, '600 kbps down → bytes/sec');
  assert.equal(p.upload, (300 * 1024) / 8, '300 kbps up → bytes/sec');
  assert.equal(p.latency, 500);
  assert.equal(p.cpu, 1, 'CPU stays 1× — the false negative is a network/cache artifact');
  assert.equal(p.mobile, false, 'desktop viewport (no mobile device emulation)');
});

test('getProfile resolves desktop-slow-1xcpu', () => {
  assert.equal(getProfile('desktop-slow-1xcpu'), PROFILES['desktop-slow-1xcpu']);
});

// ---------------------------------------------------------------------------
// Viewport fidelity (spec 003-06 / ADR-0007)
//
// Non-mobile profiles render at the Lighthouse desktop viewport (1350×940,
// deviceScaleFactor 1) instead of Puppeteer's 800×600 default, so desktop CLS
// scores reflect real desktop users. BOTH desktop profiles (cable + the slow
// cold-load repro) carry it; mobile gets its viewport from device emulation;
// no-throttle (a debug profile) falls back to the Puppeteer default. CLS
// *score* is viewport-relative (same shift distance scores differently at 600
// vs 940 px), which is why the desktop viewport is pinned and recorded.
// ---------------------------------------------------------------------------

test('desktop-cable-1xcpu carries the Lighthouse desktop viewport (003-06)', () => {
  // Exactly Lighthouse DESKTOP_EMULATION_METRICS — deviceScaleFactor pinned to 1.
  assert.deepEqual(PROFILES['desktop-cable-1xcpu'].viewport, DESKTOP_VIEWPORT);
});

test('desktop-slow-1xcpu also carries the Lighthouse desktop viewport (003-06)', () => {
  // It is a desktop CLS-repro profile, so it must render at the representative
  // desktop viewport too — otherwise width-dependent shifts are mis-scored.
  assert.deepEqual(PROFILES['desktop-slow-1xcpu'].viewport, DESKTOP_VIEWPORT);
});

test('mobile profile carries no viewport (device emulation supplies it)', () => {
  assert.equal(PROFILES['mobile-slow4g-4xcpu'].viewport, undefined);
});

test('resolveViewport: desktop profiles → the Lighthouse desktop viewport', () => {
  assert.deepEqual(resolveViewport('desktop-cable-1xcpu'), DESKTOP_VIEWPORT);
  assert.deepEqual(resolveViewport('desktop-slow-1xcpu'), DESKTOP_VIEWPORT);
});

test('resolveViewport: mobile → null (device-emulated, not declared here)', () => {
  assert.equal(resolveViewport('mobile-slow4g-4xcpu'), null);
});

test('resolveViewport: no-throttle → null (falls back to Puppeteer 800×600)', () => {
  assert.equal(resolveViewport('no-throttle'), null);
});

test('resolveViewport: omitted name resolves the default profile', () => {
  assert.equal(resolveViewport(), resolveViewport(DEFAULT_PROFILE));
});

// ---------------------------------------------------------------------------
// applyProfile() — the shared apply path (used by the analyzers; launcher.js
// inlines the same logic). Non-mobile profiles with a viewport call setViewport
// (no device emulation); mobile emulates a device (its viewport rides on it).
// ---------------------------------------------------------------------------

test('applyProfile(desktop-slow-1xcpu): viewport + network + 1× CPU, no device emulation', async () => {
  const page = makeFakePage();
  const profile = await applyProfile(page, fakePuppeteer, 'desktop-slow-1xcpu');

  assert.equal(page.calls.emulate.length, 0, 'mobile:false → no page.emulate()');
  assert.deepEqual(page.calls.viewport, [DESKTOP_VIEWPORT], 'renders at the representative desktop viewport');
  assert.equal(page.calls.net.length, 1, 'network conditions applied once');
  assert.equal(page.calls.net[0].offline, false);
  assert.equal(page.calls.net[0].download, (600 * 1024) / 8);
  assert.equal(page.calls.net[0].upload, (300 * 1024) / 8);
  assert.equal(page.calls.net[0].latency, 500);
  assert.deepEqual(page.calls.cpu, [1], 'CPU throttling rate 1');
  assert.equal(profile, PROFILES['desktop-slow-1xcpu'], 'returns the resolved profile');
});

test('applyProfile(desktop-cable-1xcpu): sets the representative viewport, no device emulation', async () => {
  const page = makeFakePage();
  await applyProfile(page, fakePuppeteer, 'desktop-cable-1xcpu');
  assert.equal(page.calls.emulate.length, 0, 'desktop must not device-emulate');
  assert.deepEqual(page.calls.viewport, [DESKTOP_VIEWPORT]);
});

test('applyProfile(mobile-slow4g-4xcpu): mobile profile DOES emulate a device, no explicit setViewport', async () => {
  const page = makeFakePage();
  await applyProfile(page, fakePuppeteer, 'mobile-slow4g-4xcpu');
  assert.equal(page.calls.emulate.length, 1, 'mobile:true → page.emulate(device)');
  assert.equal(page.calls.emulate[0].viewport.width, 390, 'the device mobile viewport rides on emulate()');
  assert.equal(page.calls.emulate[0].viewport.isMobile, true);
  assert.equal(page.calls.viewport.length, 0, 'mobile viewport comes from the device, not setViewport');
  assert.deepEqual(page.calls.cpu, [4]);
});

test('applyProfile(mobile-slow4g-4xcpu, stealth): keeps mobile viewport but swaps to Android Chrome UA', async () => {
  const page = makeFakePage();
  await applyProfile(page, fakePuppeteer, 'mobile-slow4g-4xcpu', { stealth: true });
  assert.equal(page.calls.emulate.length, 1, 'mobile:true → page.emulate(device)');
  assert.equal(page.calls.emulate[0].viewport.width, 390, 'keeps the real mobile viewport');
  assert.match(page.calls.emulate[0].userAgent, /Android/);
  assert.doesNotMatch(page.calls.emulate[0].userAgent, /iPhone/);
});

test('applyProfile(mobile): FALLS BACK to a mobile viewport (no throw) when the namespace lacks KnownDevices', async () => {
  // Regression: a default-import puppeteer namespace has `.KnownDevices`
  // undefined, so the old `puppeteer.KnownDevices['iPhone 13']` THREW here for
  // any mobile profile. It must now emulate a mobile-width fallback instead.
  const page = makeFakePage();
  await applyProfile(page, { /* default import → no .KnownDevices */ }, 'mobile-slow4g-4xcpu');
  assert.equal(page.calls.emulate.length, 1, 'still emulates a device descriptor');
  const vp = page.calls.emulate[0].viewport;
  assert.ok(vp.width < 500 && vp.width !== 800, `mobile-width fallback, not 800×600 (got ${vp.width})`);
  assert.equal(vp.isMobile, true);
  assert.equal(page.calls.viewport.length, 0, 'no explicit setViewport for mobile');
});

test('applyProfile(no-throttle): no viewport, network throttling skipped', async () => {
  const page = makeFakePage();
  await applyProfile(page, fakePuppeteer, 'no-throttle');
  assert.equal(page.calls.viewport.length, 0, 'no-throttle has no viewport → Puppeteer 800×600 default');
  assert.equal(page.calls.net.length, 0, 'download:-1 → no network emulation');
  assert.deepEqual(page.calls.cpu, [1]);
});

test('applyProfile returns the resolved profile object', async () => {
  const page = makeFakePage();
  const p = await applyProfile(page, fakePuppeteer, 'desktop-cable-1xcpu');
  assert.equal(p, getProfile('desktop-cable-1xcpu'));
});

// ---------------------------------------------------------------------------
// resolveMobileEmulation() — regression: the KnownDevices lookup silently no-op'd
//
// Puppeteer 22 exposes the device table ONLY as the named export `KnownDevices`
// — the DEFAULT export's `.KnownDevices` / `.devices` are both undefined. The
// old `puppeteer.KnownDevices || puppeteer.devices` lookup therefore resolved to
// undefined and `page.emulate()` was never called, so every mobile-profile run
// fell through to Puppeteer's 800×600 default (no mobile viewport, touch, DPR,
// or mobile UA). resolveMobileEmulation must now ALWAYS yield a real mobile
// viewport for a mobile profile — via a KnownDevices entry, or a hard-coded
// fallback when the device table can't be resolved. CLS score is
// viewport-relative (ADR-0007 / spec 003-06), so this matters for fidelity.
// ---------------------------------------------------------------------------

const MOBILE_PROFILE = PROFILES['mobile-slow4g-4xcpu'];
const DESKTOP_PROFILE = PROFILES['desktop-cable-1xcpu'];
const FAKE_DEVICES = fakePuppeteer.KnownDevices;

test('resolveMobileEmulation: non-mobile profile returns null (caller applies profile.viewport)', () => {
  assert.equal(resolveMobileEmulation(DESKTOP_PROFILE, { knownDevices: FAKE_DEVICES }), null);
  assert.equal(resolveMobileEmulation(DESKTOP_PROFILE, { knownDevices: undefined }), null);
});

test('resolveMobileEmulation: uses the KnownDevices entry (viewport + its iOS UA) when available', () => {
  const e = resolveMobileEmulation(MOBILE_PROFILE, { knownDevices: FAKE_DEVICES });
  assert.equal(e.viewport.width, 390);
  assert.equal(e.viewport.isMobile, true);
  assert.equal(e.viewport.hasTouch, true);
  assert.match(e.userAgent, /iPhone/);
});

test('resolveMobileEmulation: FALLS BACK to a real mobile viewport when KnownDevices is undefined (the bug)', () => {
  // Puppeteer 22: the default export's .KnownDevices is undefined. The old code
  // no-op'd here and a mobile run rendered at 800×600. The fix must yield a
  // mobile-width viewport with touch + a mobile UA — never the 800×600 default.
  const e = resolveMobileEmulation(MOBILE_PROFILE, { knownDevices: undefined });
  assert.ok(e, 'a mobile profile must always produce an emulation descriptor');
  assert.ok(e.viewport.width < 500, `expected a mobile width, got ${e.viewport.width}`);
  assert.notEqual(e.viewport.width, 800, 'must NOT be Puppeteer\'s 800×600 default');
  assert.equal(e.viewport.isMobile, true);
  assert.equal(e.viewport.hasTouch, true);
  assert.ok(e.viewport.deviceScaleFactor > 1, 'mobile DPR (retina)');
  assert.match(e.userAgent, /Mobile/i, 'fallback UA must be a mobile UA');
});

test('resolveMobileEmulation: falls back when a device entry is present but carries no viewport', () => {
  // Defensive: a truthy device with a missing `.viewport` must not yield an
  // undefined viewport (which would re-introduce the 800×600 fall-through).
  const e = resolveMobileEmulation(MOBILE_PROFILE, { knownDevices: { 'iPhone 13': { name: 'iPhone 13' } } });
  assert.ok(e.viewport && e.viewport.width < 500);
  assert.equal(e.viewport.isMobile, true);
});

test('resolveMobileEmulation: --stealth pairs an Android-Chrome UA with the mobile viewport (device present)', () => {
  const e = resolveMobileEmulation(MOBILE_PROFILE, { knownDevices: FAKE_DEVICES, stealth: true });
  assert.match(e.userAgent, /Android/, 'stealth UA must be Android-Chrome, not the device iOS UA');
  assert.doesNotMatch(e.userAgent, /iPhone/);
  assert.equal(e.viewport.width, 390, 'keeps the mobile viewport/touch');
  assert.equal(e.viewport.isMobile, true);
});

test('resolveMobileEmulation: --stealth still gets a mobile viewport via the fallback when KnownDevices is undefined', () => {
  // The stealth path also relied on `iPhone.viewport`, so it broke identically
  // when the device table was unavailable — verify it now falls back too.
  const e = resolveMobileEmulation(MOBILE_PROFILE, { knownDevices: undefined, stealth: true });
  assert.match(e.userAgent, /Android/);
  assert.ok(e.viewport.width < 500);
  assert.notEqual(e.viewport.width, 800);
  assert.equal(e.viewport.isMobile, true);
  assert.equal(e.viewport.hasTouch, true);
});

test('resolveMobileEmulation: the REAL Puppeteer KnownDevices named import yields a mobile viewport (integration)', () => {
  // Ties the unit to reality: proves the named import — not the default export's
  // undefined `.KnownDevices` — is the correct resolution path on the installed
  // Puppeteer, without launching a browser.
  assert.ok(KnownDevices && KnownDevices['iPhone 13'], 'named import must resolve the device table');
  const e = resolveMobileEmulation(MOBILE_PROFILE, { knownDevices: KnownDevices });
  assert.ok(e.viewport.width < 500, `expected a mobile width, got ${e.viewport.width}`);
  assert.notEqual(e.viewport.width, 800);
  assert.equal(e.viewport.isMobile, true);
  assert.match(e.userAgent, /iPhone|Mobile/i);
});

// ---------------------------------------------------------------------------
// Form-factor mapping invariant — desktop-slow-1xcpu is an explicit opt-in,
// never the DESKTOP default (CrUX-DESKTOP keeps desktop-cable-1xcpu).
// ---------------------------------------------------------------------------

test('DESKTOP still maps to the cable profile, not the slow-desktop opt-in', () => {
  assert.equal(mapFormFactorToProfile('DESKTOP'), 'desktop-cable-1xcpu');
  assert.notEqual(mapFormFactorToProfile('DESKTOP'), 'desktop-slow-1xcpu');
});

test('desktop-slow-1xcpu is opt-in only — not any form-factor default', () => {
  assert.ok(
    !Object.values(FORM_FACTOR_TO_PROFILE).includes('desktop-slow-1xcpu'),
    'no formFactor should map to the slow-desktop repro profile',
  );
});
