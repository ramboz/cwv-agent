import psi from 'psi';
import { cacheResults, getCachedResults } from '../utils.js';

function cleanup(psiAudit) {
  // removing all base 64 encoded images from the json
  delete psiAudit.data.lighthouseResult.audits['screenshot-thumbnails'];
  delete psiAudit.data.lighthouseResult.audits['final-screenshot'];
  delete psiAudit.data.lighthouseResult.fullPageScreenshot;
  return psiAudit;
}

function checkMetric(audit, goodThreshold, needsImprovementThreshold, metricName) {
  if (!audit || audit.scoreDisplayMode === 'notApplicable' || audit.scoreDisplayMode === 'informational' || audit.scoreDisplayMode === 'manual') {
    return ''; // Skip if not applicable or informational
  }

  needsImprovementThreshold = needsImprovementThreshold === undefined ? goodThreshold * 2 : needsImprovementThreshold;

  const value = audit.numericValue;
  if (value > needsImprovementThreshold) {
    return `* **${metricName}:** ${audit.displayValue} (Poor)\n`;
  } else if (value > goodThreshold) {
    return `* **${metricName}:** ${audit.displayValue} (Needs Improvement)\n`;
  }
  return ''; // Return empty string for 'Good'
}

// Function to recursively list resources in the chain
function listChainResources(report, node) {
  if (node && node.request && node.request.url) {
    report += `        * ${node.request.url}\n`;
  }
  if (node && node.children) {
    for (const key in node.children) {
      listChainResources(node.children[key]);
    }
  }
}

export function summarize(psiData) {
  if (!psiData?.data?.lighthouseResult?.audits) {
    return 'No valid PageSpeed Insights data available.';
  }

  const audits = psiData.data.lighthouseResult.audits;

  let report = `**Bottlenecks:**\n\n`;
  let length = report.length;
  let hasBottlenecks = false;

  // Helper function for Core Web Vitals and other key metrics (no URL/form factor)

  // Core Web Vitals
  report += checkMetric(audits['largest-contentful-paint'], 2500, 4000, 'Largest Contentful Paint (LCP)');
  report += checkMetric(audits['first-contentful-paint'], 1800, 3000, 'First Contentful Paint (FCP)');
  report += checkMetric(audits['total-blocking-time'], 200, 600, 'Total Blocking Time (TBT)'); // Use TBT, not INP
  report += checkMetric(audits['cumulative-layout-shift'], 0.1, 0.25, 'Cumulative Layout Shift (CLS)');
  report += checkMetric(audits['speed-index'], 3400, 5800, 'Speed Index'); // Add Speed Index
  if (report.length > length) {
    hasBottlenecks = true;
  }

  // Other audits (prioritize those with 'opportunity' details and wastedBytes/wastedMs)
  const prioritizedAudits = [
    'uses-optimized-images',
    'uses-modern-image-formats',
    'uses-text-compression',
    'render-blocking-resources',
    'unminified-css',
    'unminified-javascript',
    'unused-css-rules',
    'unused-javascript',
    'uses-responsive-images',
    'efficient-animated-content',
    'third-party-summary',
    'duplicated-javascript',
    'legacy-javascript',
    'viewport',
    'server-response-time',
    'redirects',
    'uses-rel-preconnect',
    'prioritize-lcp-image',
    'unsized-images'
  ];

  for (const auditId of prioritizedAudits) {
    const audit = audits[auditId];
    if (!audit || audit.scoreDisplayMode === 'notApplicable' || audit.scoreDisplayMode === 'informational'  || audit.scoreDisplayMode === 'manual') {
      continue;
    }

    if (audit.score !== null && audit.score < 1) {
      hasBottlenecks = true;
      if (audit.displayValue) {
        report += `* **${audit.title}:** ${audit.displayValue}`;
      } else if (audit.details?.items?.length > 0) {
        report += `* **${audit.title}:**`;
        for (const item of audit.details.items) {
          report += `\n    * ${item.node.snippet}`;
        }
      }

      if (audit.details && audit.details.overallSavingsMs) {
        report += ` (Potential savings of ${audit.details.overallSavingsMs}ms)`;
      }
      if (audit.details && audit.details.overallSavingsBytes) {
        report += ` (Potential savings of ${Math.round(audit.details.overallSavingsBytes / 1024)} KiB)`;
      }
      report += '\n';
    }
  }


  // LCP Element Details (if available)
  const lcpElementAudit = audits['largest-contentful-paint-element'];
  if (lcpElementAudit && lcpElementAudit.details && lcpElementAudit.details.items && lcpElementAudit.details.items.length > 0) {
    const lcpItem = lcpElementAudit.details.items[0];
    if (lcpItem && lcpItem.items && lcpItem.items[0] && lcpItem.items[0].node) {
      const node = lcpItem.items[0].node;
      hasBottlenecks = true;
      report += `* **LCP Element:**\n`;
      report += `    * Snippet: \`${node.snippet}\`\n`;
      report += `    * Selector: \`${node.selector}\`\n`;

      // Extract image URL if present
      if (node.nodeLabel && node.nodeLabel.includes('url(')) {
        const urlRegex = /url\(['']?(.*?)['']?\)/;
        const match = node.nodeLabel.match(urlRegex);
        if (match && match[1]) {
          report += `    * Image URL: \`${match[1]}\`\n`;
        }
      }

      if (node.boundingRect) {
        report += `    * Size: ${node.boundingRect.width}px x ${node.boundingRect.height}px\n`;
        report += `    * Position: Top: ${node.boundingRect.top}px, Left: ${node.boundingRect.left}px\n`;
      }
    }
  }

  // Critical Request Chains (simplified, focusing on the longest chain and listing resources)
  const criticalChainsAudit = audits['critical-request-chains'];
  if (criticalChainsAudit && criticalChainsAudit.details && criticalChainsAudit.details.longestChain && Object.keys(criticalChainsAudit.details.chains).length > 1) {
    const longestChain = criticalChainsAudit.details.longestChain;
    hasBottlenecks = true;
    report += `* **Longest Critical Request Chain:**\n`;
    report += `    * Duration: ${Math.round(longestChain.duration)}ms\n`;
    report += `    * Transfer Size: ${Math.round(longestChain.transferSize / 1024)} KiB\n`;
    report += `    * Length: ${longestChain.length} requests\n`;
    report += `    * Resources:\n`;

    // Start with the root
    listChainResources(report, criticalChainsAudit.details.chains[Object.keys(criticalChainsAudit.details.chains)[0]]);
  }


  // Add a 'No bottlenecks' message if everything is good
  if (!hasBottlenecks) {
    report += '* No significant bottlenecks found based on provided audits. Overall performance is good.\n';
  }

  return report;
}

export async function collect(pageUrl, deviceType, { skipCache }) {
  if (!skipCache) {
    const cache = getCachedResults(pageUrl, deviceType, 'psi');
    if (cache) {
      return { full: cache, summary: summarize(cache), fromCache: true };
    }
  }

  const psiAudit = cleanup(await psi(pageUrl, {
    key: process.env.GOOGLE_PAGESPEED_INSIGHTS_API_KEY,
    strategy: deviceType
  }));

  cacheResults(pageUrl, deviceType, 'psi', psiAudit);
  const summary = summarize(psiAudit);
  cacheResults(pageUrl, deviceType, 'psi', summary);

  return { full: psiAudit, summary };
}