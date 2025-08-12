export function getSequence(report) {
  const data = report.dataSortedByEnd;
  const i = data.findLastIndex(r => r.entryType === 'LCP');
  const sequence = data.slice(0, i);
  return {
    sequence,
    lcp: data[i],
  };
}

export function getInitiator(har, url) {
  const entries = har && har.log && Array.isArray(har.log.entries) ? har.log.entries : [];
  const entry = entries.find(e => e.request && e.request.url === url);
  return entry?._initiator_line
    ? `${entry._initiator} (L${entry._initiator_line})`
    : entry?._initiator
      ? entry._initiator
      : undefined;
}
