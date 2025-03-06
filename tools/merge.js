
import { readCache, cacheResults } from '../utils.js';


const formatTime = (x) => (x !== 0 ? Math.round(x) : 0);
const formatSize = (x) => (x !== 0 ? (Math.round(x / 1000)) : 0);
const formatTimeMS = (x) => `${formatTime(x)}ms`;

const reportNavigation = (entry) => {
  const {
    name,
    entryType,
    initiatorType,
    startTime,
    duration,
    transferSize,
    responseEnd,
    responseStart,
    activationStart,
    redirectCount,
    redirectStart,
    redirectEnd,
  } = entry;


  const issues = [];
  const ttfb = responseStart - (activationStart || 0);
  if (ttfb) {
    issues.push(`TTFB: ${formatTimeMS(ttfb)}`);
  }

  if (redirectCount > 0) {
    const redirectTime = redirectEnd - redirectStart;
    const s = redirectCount > 1 ? 's' : '';
    issues.push(`${redirectCount} redirect${s} - cost: ${formatTimeMS(redirectTime)}`);
  }

  const d = {
    start: formatTime(startTime),
    end: formatTime(responseEnd),
    url: name,
    type: initiatorType,
    entryType,
    duration: formatTime(duration),
    size: formatSize(transferSize),
    issues,
  };

  return d;
}

const reportResources = (entry, matchingHar) => {
  const {
    name,
    entryType,
    initiatorType,
    startTime,
    duration,
    transferSize,
    connectStart,
    connectEnd,
    domainLookupStart,
    domainLookupEnd,
    renderBlockingStatus,
    responseEnd,
  } = entry;

  const tcpHandshake = connectEnd - connectStart;
  const dnsLookup = domainLookupEnd - domainLookupStart;
  let issues = undefined;
  if (tcpHandshake > 0 || dnsLookup > 0 || renderBlockingStatus !== 'non-blocking') {
    const title = [];
    if (tcpHandshake > 0) title.push(`TCP handshake: ${formatTimeMS(tcpHandshake)}`);
    if (dnsLookup > 0) title.push(`DNS lookup: ${formatTimeMS(dnsLookup)}`);
    if (renderBlockingStatus !== 'non-blocking') title.push(`Render blocking: ${renderBlockingStatus}`);
    issues = title.join(', ');
  }

  let size = transferSize;
  if (size === 0 && matchingHar) {
    size = matchingHar.response.bodySize;
  }

  const d = {
    start: formatTime(startTime),
    end: formatTime(responseEnd),
    url: name,
    type: initiatorType,
    entryType,
    duration: formatTime(duration),
    size: formatSize(size),
    issues,
  };

  return d;
};

const reportLCP = (entry) => {
  const {
    url, startTime, element,
  } = entry;
  const name = 'LCP' // : `LCP Candidate ${index + 1} / ${length}`;

  return {
    start: formatTime(startTime),
    name,
    url,
    type: 'LCP',
    element,
  };
};

const reportCLS = (entry) => {
  const {
    startTime,
  } = entry;
  const name = 'CLS'; // length === 1 ? 'CLS' : `CLS ${index + 1} / ${length}`;
  const sources = entry.sources.map((source) => {
    const to = source.currentRect;
    const from = source.previousRect;
    return {
      node: source.node || '',
      from: `from: ${from.top} ${from.right} ${from.bottom} ${from.left}`,
      to: `to: ${to.top} ${to.right} ${to.bottom} ${to.left}`,
    };
  });
  return {
    start: formatTime(startTime),
    name,
    type: 'CLS',
    sources,
  };
};

const reportLongAnimationFrame = (entry) => {
  const {
    startTime,
    duration,
    target,
    scripts = [],
  } = entry;

  let url = '';
  let name = 'Could not find invoker script';
  const invoker = scripts.length ? scripts[scripts.length - 1].invoker : null;
  if (invoker) {
    try {
      const u = new URL(invoker);
      url = invoker;
      name = '';
    } catch (e) {
      name = scripts[scripts.length - 1].invoker;
    }
  }
  
  return {
    start: formatTime(startTime),
    name,
    url,
    type: 'long-animation-frame',
    duration,
    issues: [`long-animation-frame: ${duration}ms`],
    element: target || '',
  };
};

const reportTBT = (entry) => {
  const {
    startTime, duration,
  } = entry;
  const name = 'TBT'; // length === 1 ? 'TBT' : `TBT ${index + 1} / ${length}`;
  return {
    start: formatTime(startTime),
    name,
    type: 'TBT',
    duration,
    issues: [`TBT: ${duration}ms`],

  };
};

const reportINP = (entry) => {
  const {
    processingStart,
    processingEnd,
    startTime,
    duration,
    name,
    target,
  } = entry;
  const inputDelay = Math.round(processingStart - startTime);
  const processingTime = Math.round(processingEnd - processingStart);
  const presentationDelay = Math.round(startTime + duration - processingEnd);

  return {
    start: formatTime(startTime),
    name,
    type: 'INP',
    duration,
    issues: [`INP: ${inputDelay}ms input delay, ${processingTime}ms processing time, ${presentationDelay}ms presentation delay`],
    element: target || '',
  };
};

const reportGeneric = (entry) => {
  const {
    startTime,
    endTime,
    name,
    initiatorType,
    entryType,
    duration,
  } = entry;

  const d = {
    start: formatTime(startTime),
    name,
    entryType,
  };

  if (initiatorType) {
    d.type = initiatorType;
  }

  if (endTime) {
    d.end = formatTime(endTime);
  }

  if (duration) {
    d.duration = formatTime(duration);
  }

  return d;
}

function getReport(entry, matchingHar) {
  if (entry.entryType === 'navigation') {
    return reportNavigation(entry, matchingHar);
  } else if (entry.entryType === 'resource') {
    return reportResources(entry, matchingHar);
  } else if (entry.entryType === 'largest-contentful-paint') {
    return reportLCP(entry);
  } else if (entry.entryType === 'layout-shift') {
    return reportCLS(entry);
  } else if (entry.entryType === 'long-animation-frame') {
    return reportLongAnimationFrame(entry);
  } else if (entry.entryType === 'longtask') {
    return reportTBT(entry);
  } else if (entry.entryType === 'event') {
    return reportINP(entry);
  }
  return reportGeneric(entry, matchingHar);
}

function getData(har, perf) {
  const data = [];
  perf.forEach((entry, index) => {
    const matchingHar = har.log.entries.find((h) => h.request.url === entry.name);
    const merged = getReport(entry, matchingHar);

    // merged.performance = entry;
    // merged.har = matchingHar;
    
    data.push(merged);
  });

  return data;
}

export default function merge(siteURL, type) {
  const har = readCache(siteURL, type, 'har');
  const perf = readCache(siteURL, type, 'perf');
  const data = getData(har, perf);

  data.sort((a, b) => a.start - b.start);
  data.forEach((d, i) => {
    d.id = i;
  });

  const merged = {
    url: siteURL,
    type: type,
    data: data,
  };
  cacheResults(siteURL, type, 'report', merged);
}
