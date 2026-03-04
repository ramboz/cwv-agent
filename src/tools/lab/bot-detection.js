/**
 * Bot / WAF Challenge Page Detection
 *
 * Detects when a Puppeteer collection was served a bot-challenge page
 * instead of the real site content. Uses multiple heuristic signals from
 * HAR, HTML, font, and performance data to produce a confidence score.
 *
 * Supported providers: Incapsula/Imperva, Cloudflare, Akamai, Sucuri,
 * DataDome, PerimeterX, Shape Security.
 */

// ---------------------------------------------------------------------------
// Known bot-protection URL patterns and response header fingerprints
// ---------------------------------------------------------------------------

const BOT_PROTECTION_URL_PATTERNS = [
  // Incapsula / Imperva
  { pattern: '_Incapsula_Resource', provider: 'Incapsula' },
  { pattern: 'reese84', provider: 'Incapsula' },

  // Cloudflare
  { pattern: 'cdn-cgi/challenge-platform', provider: 'Cloudflare' },
  { pattern: 'challenges.cloudflare.com', provider: 'Cloudflare' },
  { pattern: '/cdn-cgi/bm/cv/result', provider: 'Cloudflare' },

  // Akamai Bot Manager
  { pattern: 'akamaized.net/challenge', provider: 'Akamai' },
  { pattern: '_sec/cp_challenge', provider: 'Akamai' },

  // PerimeterX
  { pattern: 'px-captcha', provider: 'PerimeterX' },
  { pattern: 'px-cdn.net', provider: 'PerimeterX' },

  // DataDome
  { pattern: 'datadome.co/captcha', provider: 'DataDome' },
  { pattern: 'dd.datadome.co', provider: 'DataDome' },

  // Shape Security (F5)
  { pattern: '_imp_apg_r_', provider: 'Shape' },

  // Sucuri
  { pattern: 'sucuri.net/captcha', provider: 'Sucuri' },

  // CAPTCHA services (secondary — indicate a challenge was shown)
  { pattern: 'hcaptcha.com', provider: null },
  { pattern: 'recaptcha/api', provider: null },
  { pattern: 'challenges.google.com', provider: null },
  { pattern: 'turnstile/v0/api', provider: null },
];

const BOT_PROTECTION_RESPONSE_HEADERS = [
  { header: 'x-iinfo', provider: 'Incapsula' },
  { header: 'x-cdn', value: /incapsula/i, provider: 'Incapsula' },
  { header: 'cf-mitigated', provider: 'Cloudflare' },
  { header: 'cf-chl-bypass', provider: 'Cloudflare' },
  { header: 'x-sucuri-id', provider: 'Sucuri' },
  { header: 'x-datadome', provider: 'DataDome' },
  { header: 'x-robots-tag', value: /noindex/i, provider: null },
];

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

/**
 * Detect whether the collected lab data originates from a bot-challenge page.
 *
 * @param {Object} params
 * @param {Object|null} params.har        - HAR data (with har.log.entries)
 * @param {Object|null} params.fullHtml   - Extracted CWV-relevant HTML JSON
 * @param {Object|null} params.fontData   - Font analysis data
 * @param {Object|null} params.perfEntries - Performance observer entries
 * @param {Object|null} params.psi        - PSI response data (optional, for cross-validation)
 * @param {string}      params.pageUrl    - The target URL being analyzed
 * @returns {BotDetectionResult}
 */
export function detectBotProtection({ har, fullHtml, fontData, perfEntries, psi, pageUrl }) {
  const signals = [];
  const providers = new Set();

  // ---- HAR-based signals ----
  if (har?.log?.entries) {
    analyzeHarEntries(har.log.entries, pageUrl, signals, providers);
  }

  // ---- HTML-based signals ----
  analyzeHtmlData(fullHtml, signals);

  // ---- Font-based signals ----
  analyzeFontData(fontData, signals);

  // ---- Cross-validation: PSI vs Lab ----
  if (har?.log?.entries && psi) {
    crossValidatePsiVsLab(psi, har.log.entries, signals);
  }

  // ---- Compute verdict ----
  return computeVerdict(signals, providers);
}

// ---------------------------------------------------------------------------
// HAR analysis
// ---------------------------------------------------------------------------

function analyzeHarEntries(entries, pageUrl, signals, providers) {
  // 1. Scan URLs for known bot-protection patterns
  for (const entry of entries) {
    const url = entry.request?.url || '';
    for (const { pattern, provider } of BOT_PROTECTION_URL_PATTERNS) {
      if (url.includes(pattern)) {
        signals.push({
          type: 'bot-url',
          weight: provider ? 3 : 2,
          detail: `Request to known bot-protection URL: ${truncate(url)} (${provider || 'CAPTCHA service'})`,
        });
        if (provider) providers.add(provider);
        break; // one match per entry is enough
      }
    }
  }

  // 2. Scan main-document response headers for fingerprints
  const mainDoc = entries.find(e =>
    e.request?.url && pageUrl && normalizeUrl(e.request.url) === normalizeUrl(pageUrl)
  ) || entries.find(e => e.response?.content?.mimeType?.includes('text/html'));

  if (mainDoc?.response?.headers) {
    const headers = mainDoc.response.headers;
    for (const { header, value, provider } of BOT_PROTECTION_RESPONSE_HEADERS) {
      const found = headers.find(h => h.name.toLowerCase() === header.toLowerCase());
      if (found && (!value || value.test(found.value))) {
        signals.push({
          type: 'bot-header',
          weight: 3,
          detail: `Bot-protection response header detected: ${header}: ${found.value}${provider ? ` (${provider})` : ''}`,
        });
        if (provider) providers.add(provider);
      }
    }
  }

  // 3. Main document body is suspiciously small
  if (mainDoc) {
    const size = mainDoc.response?.content?.size
      || mainDoc.response?.bodySize
      || mainDoc.response?._transferSize
      || 0;
    if (size > 0 && size < 2048) {
      signals.push({
        type: 'tiny-document',
        weight: 2,
        detail: `Main document is only ${size} bytes (real pages are typically >5 KB)`,
      });
    }
  }

  // 4. Very few total requests (bot-challenge pages load < ~15 resources)
  if (entries.length < 15) {
    signals.push({
      type: 'few-requests',
      weight: 2,
      detail: `Only ${entries.length} network requests recorded (challenge pages typically load very few resources)`,
    });
  }

  // 5. favicon returned as text/html (WAF signature)
  const favicon = entries.find(e => (e.request?.url || '').includes('favicon'));
  if (favicon) {
    const faviconMime = favicon.response?.content?.mimeType || '';
    if (faviconMime.includes('text/html')) {
      signals.push({
        type: 'favicon-html',
        weight: 2,
        detail: 'favicon.ico returned as text/html instead of image (WAF interception)',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// HTML analysis
// ---------------------------------------------------------------------------

function analyzeHtmlData(fullHtml, signals) {
  if (!fullHtml) return;

  const data = typeof fullHtml === 'string' ? safeParse(fullHtml) : fullHtml;
  if (!data) return;

  const emptySections = [];
  if (Array.isArray(data.lcpCandidates) && data.lcpCandidates.length === 0) {
    emptySections.push('lcpCandidates');
  }
  if (Array.isArray(data.thirdPartyScripts) && data.thirdPartyScripts.length === 0) {
    emptySections.push('thirdPartyScripts');
  }
  if (data.head) {
    const { renderBlockingStyles, preload, preconnect } = data.head;
    if (Array.isArray(renderBlockingStyles) && renderBlockingStyles.length === 0) {
      emptySections.push('renderBlockingStyles');
    }
    if (Array.isArray(preload) && preload.length === 0
      && Array.isArray(preconnect) && preconnect.length === 0) {
      emptySections.push('preload/preconnect');
    }
  }

  if (emptySections.length >= 3) {
    signals.push({
      type: 'empty-html',
      weight: 2,
      detail: `Page has no ${emptySections.join(', ')} — indicates a minimal challenge page, not real content`,
    });
  }
}

// ---------------------------------------------------------------------------
// Font analysis
// ---------------------------------------------------------------------------

function analyzeFontData(fontData, signals) {
  if (!fontData) return;

  const fonts = fontData.fontsInUse || fontData.fonts || [];
  const customFontCount = fontData.totalFontsLoaded ?? fontData.statistics?.totalFontsLoaded ?? fonts.length;

  if (customFontCount === 0) {
    const fontNames = fonts.map(f => f.family || f.name || f).filter(Boolean);
    const onlySystemFonts = fontNames.length === 0 || fontNames.every(n =>
      /^(times|arial|helvetica|serif|sans-serif|monospace|system-ui|cursive|fantasy)/i.test(n)
    );
    if (onlySystemFonts) {
      signals.push({
        type: 'no-custom-fonts',
        weight: 1,
        detail: 'No custom fonts loaded (challenge pages typically use only system fonts)',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// PSI vs Lab cross-validation
// ---------------------------------------------------------------------------

function crossValidatePsiVsLab(psi, labEntries, signals) {
  try {
    const psiData = psi?.data || psi;
    const psiAudits = psiData?.lighthouseResult?.audits;
    if (!psiAudits) return;

    const psiNetworkItems = psiAudits['network-requests']?.details?.items;
    if (!Array.isArray(psiNetworkItems)) return;

    const psiCount = psiNetworkItems.length;
    const labCount = labEntries.length;

    // If PSI saw significantly more requests than Puppeteer, the lab was likely blocked
    if (psiCount > 50 && labCount < 20 && psiCount / labCount > 5) {
      signals.push({
        type: 'psi-lab-divergence',
        weight: 3,
        detail: `PSI recorded ${psiCount} requests but lab only recorded ${labCount} — lab was likely served a challenge page`,
      });
    }
  } catch {
    // PSI data may not always be available or parseable
  }
}

// ---------------------------------------------------------------------------
// Verdict computation
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BotDetectionResult
 * @property {boolean} detected      - True if bot protection was detected
 * @property {'high'|'medium'|'low'|'none'} confidence
 * @property {string[]} signals      - Human-readable signal descriptions
 * @property {string|null} provider  - Identified WAF/bot provider, if any
 * @property {number} score          - Raw weighted score (for debugging)
 */

function computeVerdict(signals, providers) {
  const score = signals.reduce((sum, s) => sum + s.weight, 0);

  // Provider detection
  const providerList = Array.from(providers);
  const provider = providerList.length > 0 ? providerList.join(', ') : null;

  let confidence;
  if (score >= 8) confidence = 'high';
  else if (score >= 5) confidence = 'medium';
  else if (score >= 3) confidence = 'low';
  else confidence = 'none';

  return {
    detected: score >= 5,
    confidence,
    signals: signals.map(s => s.detail),
    provider,
    score,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(str, max = 100) {
  if (!str || str.length <= max) return str || '';
  return str.substring(0, max) + '...';
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
