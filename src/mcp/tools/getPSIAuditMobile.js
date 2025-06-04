import { callMCP } from '../client.js'; // adjust path if different

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

  if (!result?.contents || result.contents.length === 0) {
    throw new Error(`No site found for baseURL: ${baseURL}`);
  }

  const siteData = JSON.parse(result.contents[0].text);
  return siteData;
}

async function run(siteId, imsOrgId) {
  try {
    const headers = { 
        'x-gw-ims-org-id': imsOrgId,
    };

    return await getLatestAuditByTypeAndSite(siteId, "lhs-mobile", headers);
  } catch (err) {
    console.error('Error fetching mobile audit:', err);
    console.error(err.stack);
    throw err; // rethrow to handle in main
  }
}

//run('****', '***');