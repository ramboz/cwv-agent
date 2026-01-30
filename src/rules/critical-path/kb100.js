import { CRITICAL_PATH_THRESHOLDS } from '../../config/thresholds.js';

const THRESHOLDS = {
  mobile: CRITICAL_PATH_THRESHOLDS.PRE_LCP_ASSET.mobile / 1024, // Convert bytes to KB
  desktop: CRITICAL_PATH_THRESHOLDS.PRE_LCP_ASSET.desktop / 1024,
};

export default function evaluate({ summary, report }) {
  const data = report.dataSortedByEnd;
  const i = data.findLastIndex(r => r.entryType === 'LCP');
  if (i === -1) {
    return null;
  }
  const lcpResource = data[i];
  const { element, start } = lcpResource;
  const beforeLCP = data.slice(0, i);
  const totalSizeBeforeLCP = beforeLCP.reduce((acc, r) => acc + (r.size || 0), 0);
  if (totalSizeBeforeLCP > THRESHOLDS[summary.type]) {
    return {
      category: 'critical-path',
      message: `Critical path has >${THRESHOLDS[summary.type]}kb pre-lcp assets on ${summary.type} ()`,
      recommendation: `A total of ${totalSizeBeforeLCP}kb is loaded before the LCP - defer resources loaded before the LCP to reduce the size of the critical path`,
      element,
      passing: false,
      time: start,
    };
  }
  return null;
}