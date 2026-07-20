/**
 * Shared throttling profile table.
 *
 * Calibrated against Lighthouse / PSI "Mobile Slow 4G" so lab results from
 * `launcher.js` (and other analyzers that spin up Puppeteer) correlate with
 * PSI and CrUX mobile p75.
 *
 * Most profiles map to a CrUX form factor (see FORM_FACTOR_TO_PROFILE).
 * `desktop-slow-1xcpu` is the exception — an explicit opt-in (never a
 * form-factor default) for reproducing cold-load desktop CLS that a warm edge
 * cache hides: a fast TTFB can deliver images before first paint, so the lab
 * reads CLS ~0 while field RUM p75 fails. Reach for it when a DESKTOP page's
 * `desktop-cable-1xcpu` run looks suspiciously green against its field p75. It
 * renders at the real desktop viewport (1350×940, slice 003-06 / ADR-0007), so
 * it surfaces *width-dependent* desktop shifts too.
 *
 * Consumers:
 *   - .agents/scripts/launcher.js
 *   - .agents/scripts/analyzers/coverage.js
 *   - .agents/scripts/analyzers/image-analysis.js
 *
 * Units:
 *   - download / upload: bytes per second (Puppeteer `emulateNetworkConditions`).
 *     -1 disables throttling for that direction.
 *   - latency: round-trip ms.
 *   - cpu: slowdown factor for `emulateCPUThrottling`; 1 = no throttling.
 *   - mobile: when true, device emulation supplies the viewport (iPhone 13 from
 *     Puppeteer's KnownDevices, or a hard-coded mobile fallback) via
 *     resolveMobileEmulation — no `viewport` field needed/honored.
 *   - viewport: { width, height, deviceScaleFactor } applied via `page.setViewport()`
 *     for non-mobile profiles. WHY (spec 003-06 / ADR-0007): Puppeteer defaults to
 *     800×600, which is not a real desktop. The desktop profile renders at 1350×940
 *     — exactly Google Lighthouse's desktop `DESKTOP_EMULATION_METRICS`
 *     (deviceScaleFactor 1, mobile false) — so the lab desktop viewport matches the
 *     PSI/Lighthouse desktop standard this profile is already calibrated to. NOTE:
 *     the CLS *score* is viewport-relative — distance fraction = shiftDistance /
 *     max(viewportWidth, viewportHeight), so the same shift *distance* (itself
 *     viewport-independent) scores differently across viewports: a fixed 300 px
 *     shift scores 0.375 at 800×600 vs 0.222 at 1350×940 (denominator 800 → 1350).
 *     deviceScaleFactor is pinned to 1 for parity with Lighthouse; CLS is computed
 *     in CSS pixels so DPR does not change the score. Profiles without a `viewport`
 *     fall back to Puppeteer's 800×600 default.
 */


const PROFILES = {
  'mobile-slow4g-4xcpu': {
    download: 1638400 / 8,
    upload: (750 * 1024) / 8,
    latency: 150,
    cpu: 4,
    mobile: true,
  },
  'desktop-cable-1xcpu': {
    download: 5000 * 1024,
    upload: 1000 * 1024,
    latency: 40,
    cpu: 1,
    mobile: false,
    // Desktop lab viewport (spec 003-06 / ADR-0007) — exactly Lighthouse's
    // desktop DESKTOP_EMULATION_METRICS (1350×940, deviceScaleFactor 1),
    // replacing Puppeteer's 800×600 default so desktop CLS matches the
    // PSI/Lighthouse desktop standard this profile is calibrated to. CLS score
    // is viewport-relative (see header note).
    viewport: { width: 1350, height: 940, deviceScaleFactor: 1 },
  },
  // Cold-load desktop CLS repro — NOT a CrUX preset. A deliberately punishing
  // link (slower than Slow-4G) that widens the gap between first paint and late
  // content, surfacing shifts a warm edge cache hides. CPU stays 1× (the false
  // negative is a network/cache artifact, not CPU-bound). Opt-in only.
  // Calibrated from the about.ups.com /our-stories repro: 600/300 kbps + 500 ms
  // + cold cache reproduced CLS 0.347 where desktop-cable-1xcpu read 0.000.
  'desktop-slow-1xcpu': {
    download: (600 * 1024) / 8,
    upload: (300 * 1024) / 8,
    latency: 500,
    cpu: 1,
    mobile: false,
    // Same representative desktop viewport as desktop-cable-1xcpu (spec 003-06 /
    // ADR-0007) — a desktop CLS-repro profile must also render at a real desktop
    // viewport, or width-dependent shifts are mis-scored at 800×600.
    viewport: { width: 1350, height: 940, deviceScaleFactor: 1 },
  },
  'no-throttle': {
    download: -1,
    upload: -1,
    latency: 0,
    cpu: 1,
    mobile: false,
  },
};

const DEFAULT_PROFILE = 'mobile-slow4g-4xcpu';

/**
 * CrUX/PSI formFactor enum → lab profile name.
 *
 * CrUX accepts `PHONE` | `DESKTOP` | `TABLET`. We map those to the throttling
 * profile that best matches the device/network conditions the field users face:
 *
 *   - PHONE   → mobile-slow4g-4xcpu  (iPhone 13, slow 4G, 4× CPU — Lighthouse mobile)
 *   - DESKTOP → desktop-cable-1xcpu  (no device emul, cable, 1× CPU — Lighthouse desktop)
 *   - TABLET  → mobile-slow4g-4xcpu  (Helix rolls tablet into mobile; CrUX tablets
 *                                     typically render with mobile CSS, so the
 *                                     mobile profile is the conservative default)
 *
 * DESKTOP maps to the cable profile by design, NOT to desktop-slow-1xcpu: the
 * slow-desktop profile is an explicit opt-in for cold-load CLS repro and would
 * over-constrain a normal desktop diagnosis, so it is never a mapped default.
 *
 * Keeping this mapping in one place means downstream skills (cwv-triage →
 * cwv-analyze → cwv-diagnose → cwv-fix → cwv-validate) can pass a formFactor
 * and everything aligns.
 */
const FORM_FACTOR_TO_PROFILE = {
  PHONE: 'mobile-slow4g-4xcpu',
  DESKTOP: 'desktop-cable-1xcpu',
  TABLET: 'mobile-slow4g-4xcpu',
};

const FORM_FACTORS = Object.keys(FORM_FACTOR_TO_PROFILE);

function mapFormFactorToProfile(formFactor) {
  const key = String(formFactor || 'PHONE').toUpperCase();
  const profile = FORM_FACTOR_TO_PROFILE[key];
  if (!profile) {
    throw new Error(
      `Unknown formFactor "${formFactor}". Valid: ${FORM_FACTORS.join(', ')}`,
    );
  }
  return profile;
}

function getProfile(name) {
  const profile = PROFILES[name || DEFAULT_PROFILE];
  if (!profile) {
    throw new Error(`Unknown profile "${name}". Valid: ${Object.keys(PROFILES).join(', ')}`);
  }
  return profile;
}

/**
 * The viewport that will be applied for a profile, or null when the profile
 * carries none (mobile profiles, whose viewport comes from device emulation;
 * and any profile that falls back to Puppeteer's 800×600 default). Pure — the
 * single place launcher.js / analyzers consult to set + report the viewport.
 * Mobile returns null deliberately: the device viewport is set by
 * `page.emulate()` and read back from the page, not declared here.
 */
function resolveViewport(name) {
  const profile = getProfile(name);
  if (profile.mobile) return null;
  return profile.viewport || null;
}

// ---------------------------------------------------------------------------
// Mobile device emulation
//
// Puppeteer 22 exposes the device table ONLY as the named export `KnownDevices`
// — the default export's `.KnownDevices` / `.devices` are BOTH `undefined`. A
// `puppeteer.KnownDevices`-on-the-default-export lookup therefore resolves to
// undefined, so callers must pass the named import (or a namespace whose
// `.KnownDevices` resolves). resolveMobileEmulation also FALLS BACK to a
// hard-coded mobile viewport when the table is unavailable, so a mobile profile
// never silently renders at Puppeteer's 800×600 default (no mobile viewport,
// touch, DPR, or UA) — which matters because CLS *score* is viewport-relative
// (ADR-0007 / spec 003-06) and LCP element selection differs at ~390px vs 800px.
// ---------------------------------------------------------------------------

// iPhone 14/15 logical viewport — the fallback when the KnownDevices table is
// unavailable, so a mobile profile never silently renders at 800×600.
const FALLBACK_MOBILE_VIEWPORT = Object.freeze({
  width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
});
// A mobile iOS-Safari UA for the fallback (non-stealth). When a KnownDevices
// entry resolves we use its own UA instead.
const FALLBACK_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
// --stealth pairs the mobile viewport with an Android-Chrome UA so the UA
// matches the Chromium runtime/TLS — emulate()'s default iOS-Safari UA on a
// Chromium runtime is exactly the mismatch Cloudflare's managed challenge flags
// (see references/topics/anti-bot-measurement.md).
const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';

/**
 * Resolve the device-emulation descriptor for a profile, or null for a
 * non-mobile profile (the caller applies `profile.viewport` instead). Pure —
 * the device table is passed in, so it's testable without a live browser.
 *
 * @param {object} profile               a PROFILES entry
 * @param {object} [opts]
 * @param {object} [opts.knownDevices]    Puppeteer's KnownDevices table (or undefined)
 * @param {boolean} [opts.stealth=false]  pair the viewport with an Android-Chrome UA
 * @returns {{ userAgent: string, viewport: object } | null}
 */
function resolveMobileEmulation(profile, { knownDevices, stealth = false } = {}) {
  if (!profile || !profile.mobile) return null;
  const iPhone = knownDevices
    && (knownDevices['iPhone 13'] || knownDevices['iPhone 12'] || knownDevices['iPhone X']);
  const viewport = (iPhone && iPhone.viewport) ? iPhone.viewport : FALLBACK_MOBILE_VIEWPORT;
  const userAgent = stealth
    ? ANDROID_CHROME_UA
    : ((iPhone && iPhone.userAgent) ? iPhone.userAgent : FALLBACK_MOBILE_UA);
  return { userAgent, viewport };
}

/**
 * Apply a profile to a Puppeteer Page: device emulation + network + CPU.
 * Caller provides the Puppeteer namespace so this module stays decoupled from
 * the exact puppeteer resolution path; its `.KnownDevices` feeds
 * resolveMobileEmulation (undefined is fine — it falls back to a mobile viewport
 * rather than the old `puppeteer.KnownDevices['iPhone 13']`, which THREW).
 */
async function applyProfile(page, puppeteer, profileName, { stealth = false } = {}) {
  const profile = getProfile(profileName);
  const emulation = resolveMobileEmulation(profile, {
    knownDevices: puppeteer && puppeteer.KnownDevices,
    stealth,
  });
  if (emulation) {
    // Mobile: the device viewport (or fallback) rides on emulate().
    await page.emulate(emulation);
  } else if (profile.viewport) {
    // Representative desktop viewport (spec 003-06); mobile is handled above.
    await page.setViewport(profile.viewport);
  }
  if (profile.download !== -1) {
    await page.emulateNetworkConditions({
      offline: false,
      download: profile.download,
      upload: profile.upload,
      latency: profile.latency,
    });
  }
  await page.emulateCPUThrottling(profile.cpu || 1);
  return profile;
}

export {
  PROFILES,
  DEFAULT_PROFILE,
  FORM_FACTORS,
  FORM_FACTOR_TO_PROFILE,
  getProfile,
  resolveViewport,
  resolveMobileEmulation,
  mapFormFactorToProfile,
  applyProfile,
};
