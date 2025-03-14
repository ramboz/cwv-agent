export function getSequence(report) {
  const { data } = report;
  const lcpResource = data.findLast(r => r.type === 'LCP');
  const sequence = report.data.slice(0, lcpResource.id);
  return sequence;
}
