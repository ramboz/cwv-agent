/**
 * Shared Puppeteer launch options for cwv-agent browser-owning tools.
 *
 * The default path is intentionally the plain headless Chromium launch used by
 * the original local profile. `stealth` is an explicit opt-in for authorized
 * measurement on Cloudflare/anti-bot managed-challenge sites.
 */

function buildLaunchOptions(stealth = false) {
  if (!stealth) {
    return {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    };
  }

  return {
    headless: false,
    channel: 'chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };
}

async function applyStealthPage(page) {
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch { /* ignore if locked */ }
    try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch { /* ignore if locked */ }
    window.chrome = window.chrome || { runtime: {} };
  });
}

export {
  buildLaunchOptions,
  applyStealthPage,
};
