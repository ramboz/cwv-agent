export default function evaluate({ perfEntries }) {
  const lcp = perfEntries.find((e) => e.entryType === 'largest-contentful-paint');
  if (!lcp || !lcp.url) {
    return null;
  }
  const lcpIndex = perfEntries.findIndex((e) => e.entryType === 'resource' && e.name === lcp.url);  
  const headerIndex = perfEntries.findIndex((e) => e.entryType === 'resource' && e.name.includes('header.js'));
  const footerIndex = perfEntries.findIndex((e) => e.entryType === 'resource' && e.name.includes('footer.js'));
  if (lcpIndex === -1) {
    return null;
  }
  if (headerIndex > -1 && lcpIndex > headerIndex) {
    return {  
      category: 'lcp',
      message: 'Lazy loaded header.',
      recommendation: 'Ensure the page header is lazy loaded after the LCP.',
      passing: false,
    };
  }
  if (footerIndex > -1 && lcpIndex > footerIndex) {
    return {  
      category: 'lcp',
      message: 'Lazy loaded footer.',
      recommendation: 'Ensure the page footer is lazy loaded after the LCP.',
      passing: false,
    };
  }
  if (headerIndex > -1 && footerIndex > -1 && headerIndex > footerIndex) {
    return {  
      category: 'lcp',
      message: 'Lazy loaded header/footer.',
      recommendation: 'Ensure the page header loads before the page footer.',
      passing: false,
    };
  }
  return null;
}
