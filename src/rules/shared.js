export function getSequence(report) {
  const data = report.dataSortedByEnd;
  const i = data.findLastIndex(r => r.entryType === 'LCP');
  const sequence = data.slice(0, i);
  return {
    sequence,
    lcp: data[i],
  };
}
