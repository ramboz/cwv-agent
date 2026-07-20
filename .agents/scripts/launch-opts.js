/**
 * Shared Puppeteer launch options for cwv-agent browser-owning tools.
 *
 * The default path is intentionally the plain headless Chromium launch used by
 * the original local profile. `stealth` is an explicit opt-in for authorized
 * measurement on Cloudflare/anti-bot managed-challenge sites.
 *
 * `CWV_CHROME_ARGS` (space-separated) appends extra Chromium flags in every
 * mode — the portability seam for sandboxed/CI environments that need e.g.
 * `--proxy-server=…` to reach the network. It never replaces the defaults.
 */

function extraChromeArgs(env = process.env) {
  return String(env.CWV_CHROME_ARGS || '').split(/\s+/).filter(Boolean);
}

function buildLaunchOptions(stealth = false) {
  if (!stealth) {
    return {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...extraChromeArgs()],
    };
  }

  return {
    headless: false,
    channel: 'chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      ...extraChromeArgs(),
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
