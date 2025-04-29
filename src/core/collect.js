import MCPClient from '../services/mcp-client.js';
import { collect as collectCrux } from '../tools/crux.js';
import { collect as collectHar } from '../tools/har.js';
import { collect as collectPsi } from '../tools/psi.js';
import { collect as collectCode } from '../tools/code.js';
import { estimateTokenSize } from '../utils.js';

const mcpClient = new MCPClient();

export async function getCrux(pageUrl, deviceType, options) {
  return mcpClient.getCrux(pageUrl, deviceType, options);
}

export async function getPsi(pageUrl, deviceType, options) {
  return mcpClient.getPsi(pageUrl, deviceType, options);
}

export async function getHar(pageUrl, deviceType, options) {
  return mcpClient.getHar(pageUrl, deviceType, options);
}

export async function getCode(pageUrl, deviceType, requests, options) {
  return mcpClient.getCode(pageUrl, deviceType, requests, options);
}

export default async function collectArtifacts(pageUrl, deviceType, options) {
  // Check if we should use the all-in-one endpoint for better performance
  if (options.useOptimizedCollection !== false) {
    try {
      return await mcpClient.collectAllArtifacts(pageUrl, deviceType, options);
    } catch (error) {
      console.warn('Failed to use optimized collection, falling back to individual calls:', error.message);
      // Fall through to individual calls if the all-in-one fails
    }
  }

  // Traditional approach with individual calls
  const { full: crux, summary: cruxSummary } = await getCrux(pageUrl, deviceType, options);
  const { full: psi, summary: psiSummary } = await getPsi(pageUrl, deviceType, options);
  const { har, harSummary, perfEntries, perfEntriesSummary, fullHtml, jsApi } = await getHar(pageUrl, deviceType, options);
  const requests = har.log.entries.map((e) => e.request.url);
  const { codeFiles: resources } = await getCode(pageUrl, deviceType, requests, options);

  return {
    har,
    harSummary,
    psi,
    psiSummary,
    resources,
    crux,
    cruxSummary,
    perfEntries,
    perfEntriesSummary,
    fullHtml,
    jsApi,
  };
}
