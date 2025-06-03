import { callMCP } from '../client.js';

/**
 * Get the latest audit for a given site and audit type.
 * 
 * @param {string} siteId - UUID of the site.
 * @param {string} auditType - Audit type (e.g., 'cwv', 'lhs-desktop', etc.).
 * @param {object} [extraHeaders] - Optional additional headers (e.g., org ID, authorization).
 * @returns {Promise<object>} - The latest audit result.
 */
export async function getLatestAuditByTypeAndSite(siteId, auditType, extraHeaders = {}) {
  if (!siteId || !auditType) {
    throw new Error('Both siteId and auditType are required.');
  }

  const uri = `spacecat-data://audits/latest/${auditType}/${siteId}`;

  const result = await callMCP('resources/read', extraHeaders, { uri });

  return result;
}

/**
 * TESTING
 */
async function main() {
  try {
    const siteId = '***';
    const headers = { 
        'x-gw-ims-org-id': '***@AdobeOrg',
    };

    const site = await getLatestAuditByTypeAndSite(siteId, "cwv", headers);
    console.log('Site ID:', site.siteId);
    console.log('Full Site Resource:', site);
  } catch (err) {
    console.error('Error fetching site ID:', err);
    console.error(err.stack);
  }
}

main();