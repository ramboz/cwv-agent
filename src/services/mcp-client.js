import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { estimateTokenSize } from '../utils.js';

class MCPClient {
  constructor(baseUrl = process.env.MCP_SERVER_URL || 'http://localhost:3333') {
    this.baseUrl = baseUrl;
    this.client = null;
    this.transport = null;
  }

  async connect() {
    if (this.client) return;
    
    this.client = new Client({
      name: "cwv-mcp-client",
      version: "1.0.0"
    });
    
    this.transport = new StreamableHTTPClientTransport(
      new URL(`${this.baseUrl}/mcp`)
    );
    
    await this.client.connect(this.transport);
  }

  async _callTool(toolName, params) {
    await this.connect();
    
    const result = await this.client.callTool({
      name: toolName,
      arguments: params
    });
    
    // Extract the JSON result from the content
    if (result.content && result.content.length > 0) {
      for (const item of result.content) {
        if (item.type === 'json') {
          return item.json;
        }
      }
    }
    
    throw new Error(`No JSON result found in response from ${toolName}`);
  }

  async health() {
    try {
      await this.connect();
      return { status: 'ok' };
    } catch (error) {
      console.error('Health check failed:', error);
      return { status: 'error', error: error.message };
    }
  }

  async getCrux(pageUrl, deviceType, options = {}) {
    const result = await this._callTool('crux', { pageUrl, deviceType, options });
    const { full, summary, fromCache } = result;
    
    if (full.error && full.error.code === 404) {
      console.warn('ℹ️  No CrUX data for that page.');
    } else if (full.error) {
      console.error('❌ Failed to collect CrUX data.', full.error.message);
    } else if (fromCache) {
      console.log('✓ Loaded CrUX data from cache. Estimated token size: ~', estimateTokenSize(full));
    } else {
      console.log('✅ Processed CrUX data. Estimated token size: ~', estimateTokenSize(full));
    }
    
    return { full, summary };
  }

  async getPsi(pageUrl, deviceType, options = {}) {
    const result = await this._callTool('psi', { pageUrl, deviceType, options });
    const { full, summary, fromCache } = result;
    
    if (fromCache) {
      console.log('✓ Loaded PSI data from cache. Estimated token size: ~', estimateTokenSize(full));
    } else {
      console.log('✅ Processed PSI data. Estimated token size: ~', estimateTokenSize(full));
    }
    
    return { full, summary };
  }

  async getHar(pageUrl, deviceType, options = {}) {
    const result = await this._callTool('har', { pageUrl, deviceType, options });
    const { har, harSummary, perfEntries, perfEntriesSummary, fullHtml, jsApi, fromCache } = result;
    
    if (fromCache) {
      console.log('✓ Loaded HAR data from cache. Estimated token size: ~', estimateTokenSize(har));
      console.log('✓ Loaded Performance Entries data from cache. Estimated token size: ~', estimateTokenSize(perfEntries));
      console.log('✓ Loaded full rendered HTML markup from cache. Estimated token size: ~', estimateTokenSize(fullHtml));
      console.log('✓ Loaded JS API data from cache. Estimated token size: ~', estimateTokenSize(jsApi));
    } else {
      console.log('✅ Processed HAR data. Estimated token size: ~', estimateTokenSize(har));
      console.log('✅ Processed Performance Entries data. Estimated token size: ~', estimateTokenSize(perfEntries));
      console.log('✅ Processed full rendered HTML markup. Estimated token size: ~', estimateTokenSize(fullHtml));
      console.log('✅ Processed JS API data. Estimated token size: ~', estimateTokenSize(jsApi));
    }
    
    return { har, harSummary, perfEntries, perfEntriesSummary, fullHtml, jsApi };
  }

  async getCode(pageUrl, deviceType, requests, options = {}) {
    const result = await this._callTool('code', { pageUrl, deviceType, requests, options });
    const { codeFiles, stats } = result;
    
    if (stats.fromCache === stats.total) {
      console.log('✓ Loaded code from cache. Estimated token size: ~', estimateTokenSize(codeFiles));
    } else if (stats.fromCache > 0) {
      console.log(`✓ Partially loaded code from cache (${stats.fromCache}/${stats.total}). Estimated token size: ~`, estimateTokenSize(codeFiles));
    } else if (stats.failed > 0) {
      console.error('❌ Failed to collect all project code. Estimated token size: ~', estimateTokenSize(codeFiles));
    } else {
      console.log('✅ Processed project code. Estimated token size: ~', estimateTokenSize(codeFiles));
    }
    
    return { codeFiles, stats };
  }

  async applyRules(pageUrl, deviceType, options = {}, data) {
    return this._callTool('rules', { pageUrl, deviceType, options, data });
  }

  async detectAEMVersion(headers, fullHtml) {
    const result = await this._callTool('aem', { headers, fullHtml });
    console.log('AEM Version:', result.version);
    return result.version;
  }

  async mergeReports(pageUrl, deviceType) {
    return this._callTool('merge', { pageUrl, deviceType });
  }

  async collectAllArtifacts(pageUrl, deviceType, options = {}) {
    return this._callTool('collect-all', { pageUrl, deviceType, options });
  }
}

export default MCPClient; 