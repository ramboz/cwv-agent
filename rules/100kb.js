export default function evaluate(summary, crux, psi, har, perfEntries, resources) {
  return {
    category: 'lcp',
    message: '>100kb pre-lcp assets',
    recommendation: 'Fix it!',
    passing: false,
  }
}