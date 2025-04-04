
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
    redirectStart,
    redirectEnd,
  } = entry;

  const ttfb = responseStart - (activationStart || 0);
  const redirect = redirectEnd - redirectStart;

  const d = {
    start: formatTime(startTime),
    end: formatTime(responseEnd),
    url: name,
    initiatorType,
    entryType,
    duration: formatTime(duration),
    size: formatSize(transferSize),
  };

  if (redirect > 0) {
    d.redirect = formatTime(redirect);
  }

  if (ttfb > 0) {
    d.ttfb = formatTime(ttfb);
  }

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
    renderBlockingStatus,
    responseEnd,
    redirectStart,
    redirectEnd,
    // connectStart,
    // connectEnd,
    // domainLookupStart,
    // domainLookupEnd,
  } = entry;

  // const tcpHandshake = connectEnd - connectStart;
  // const dnsLookup = domainLookupEnd - domainLookupStart;
  // if (tcpHandshake > 0 || dnsLookup > 0 || renderBlockingStatus !== 'non-blocking') {
  //   if (tcpHandshake > 0) title.push(`TCP handshake: ${formatTimeMS(tcpHandshake)}`);
  //   if (dnsLookup > 0) title.push(`DNS lookup: ${formatTimeMS(dnsLookup)}`);
  //   if (renderBlockingStatus !== 'non-blocking') title.push(`Render blocking: ${renderBlockingStatus}`);
  // }

  const redirect = redirectEnd - redirectStart;
  const size = transferSize || matchingHar?.response?.bodySize || 0;
  const mimeType = matchingHar?.response?.content?.mimeType || '';
  
  const d = {
    start: formatTime(startTime),
    end: formatTime(responseEnd),
    url: name,
    initiatorType,
    entryType,
    duration: formatTime(duration),
    size: formatSize(size),
    mimeType,
    renderBlockingStatus,
  };

  if (redirect > 0) {
    d.redirect = formatTime(redirect);
  }

  return d;
};

const reportLCP = (entry) => {
  const {
    url, startTime, element,
  } = entry;
  const name = 'LCP' // : `LCP Candidate ${index + 1} / ${length}`;

  return {
    start: formatTime(startTime),
    end: formatTime(startTime),
    name,
    url,
    entryType: 'LCP',
    element,
  };
};

const reportCLS = (entry) => {
  const {
    startTime,
    value,
  } = entry;
  const name = 'CLS'; // length === 1 ? 'CLS' : `CLS ${index + 1} / ${length}`;
  const sources = entry.sources.map((source) => {
    const to = source.currentRect;
    const from = source.previousRect;
    return {
      node: source.node || '',
      from: `${from.top} ${from.right} ${from.bottom} ${from.left}`,
      to: `${to.top} ${to.right} ${to.bottom} ${to.left}`,
    };
  });
  return {
    start: formatTime(startTime),
    end: formatTime(startTime),
    name,
    entryType: 'CLS',
    sources,
    value: value.toFixed(5),
  };
};

const reportLongAnimationFrame = (entry) => {
  const {
    startTime,
    duration,
    scripts = [],
  } = entry;

  let url = '';
  let name = '';
  const lastScript = scripts[scripts.length - 1];
  if (lastScript) {
    const { invoker, invokerType, sourceURL } = lastScript;
    try {
      const u = new URL(sourceURL || invoker);
      url = u.toString();
      if (invokerType !== 'classic-script') {
        name = `${invokerType}[${invoker}]`;
      }
    } catch (e) {
      name = `${invokerType}: ${invoker}`;
    }
  }
  
  return {
    start: formatTime(startTime),
    end: formatTime(startTime + duration),
    name,
    url,
    entryType: 'long-animation-frame',
    duration
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
    entryType: 'TBT',
    duration,
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
    end: formatTime(startTime),
    name,
    entryType: 'INP',
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
    end: formatTime(endTime || startTime + (duration || 0)),
    name,
    entryType,
    initiatorType,
  };

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
  cacheResults(siteURL, type, 'merge', merged);
  return merged;
}
