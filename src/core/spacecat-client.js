import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * A singleton, robust SpaceCat API Client with built-in Adobe IMS/Okta authentication.
 */
export class SpaceCatClient {
  constructor(options = {}) {
    this.baseUrl = 'https://spacecat.experiencecloud.live/api/v1';
    this.accessToken = null;
    this.tokenExpiry = null;
    this.authWrapper = null;
    this.authInProgress = false;
    this.authPromise = null;
    this.isMCPMode = options.isMCPMode || false;
  }

  /**
   * Initializes authentication using mcp-remote-with-okta (singleton pattern).
   * This is called automatically on the first API request.
   */
  async initAuth() {
    if (this.authWrapper) return;
    
    try {
      const AdobeMCPWrapper = require('mcp-remote-with-okta');
      
      this.authWrapper = new AdobeMCPWrapper(null, { 
        silent: this.isMCPMode, 
        isMCPMode: this.isMCPMode
      });
    } catch (error) {
      throw new Error(`Failed to initialize authentication: ${error.message}`);
    }
  }

  /**
   * Gets a valid access token, handling caching, renewal, and concurrent requests.
   */
  async getAccessToken() {
    await this.initAuth();
    
    if (this.authInProgress && this.authPromise) {
      return this.authPromise;
    }
    
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    
    this.authInProgress = true;
    this.authPromise = this._performAuthentication();
    
    try {
      return await this.authPromise;
    } finally {
      this.authInProgress = false;
      this.authPromise = null;
    }
  }

  /**
   * Internal method to perform the actual authentication flow.
   */
  async _performAuthentication() {
    try {
      const accessToken = await this.authWrapper.getValidToken();
      if (!accessToken || typeof accessToken !== 'string') {
        throw new Error('Retrieved token is invalid or not a string.');
      }
      this.accessToken = accessToken;
      // Cache token for 50 minutes (tokens typically last 1 hour)
      this.tokenExpiry = Date.now() + (50 * 60 * 1000);
      return accessToken;
    } catch (error) {
      this.accessToken = null;
      this.tokenExpiry = null;
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  /**
   * Makes an authenticated API request to the SpaceCat service.
   * @param {string} endpoint - The API endpoint to call (e.g., '/sites').
   * @param {object} [options={}] - `fetch` options (method, body, etc.).
   * @returns {Promise<object|string|null>} The parsed JSON response, text, or null.
   */
  async apiRequest(endpoint, options = {}) {
    const accessToken = await this.getAccessToken();

    const url = `${this.baseUrl}${endpoint}`;
    
    const finalOptions = {
      ...options,
      headers: {
        'Authorization': `Bearer ${accessToken}`, // Correctly use the string token
        'Content-Type': 'application/json',
        'x-client-type': 'sites-optimizer-mcp', // Add required header
        ...options.headers,
      },
    };

    try {
      const response = await fetch(url, finalOptions);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`SpaceCat API error: ${response.status} ${response.statusText} - ${errorText} [URL: ${url}]`);
      }

      if (response.status === 204) {
        return null; // Handle No Content responses
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return response.json();
      } else {
        return response.text();
      }
    } catch (error) {
      throw new Error(`SpaceCat API request failed: ${error.message}`);
    }
  }

  /**
   * Normalizes a URL for use with the SpaceCat API.
   * @param {string} url - The URL to normalize.
   * @returns {string} The normalized URL.
   */
  normalizeBaseUrl(url) {
    try {
      const urlObj = new URL(url);
      let hostname = urlObj.hostname;
      if (hostname.startsWith('www.')) {
        hostname = hostname.substring(4);
      }
      return `${urlObj.protocol}//${hostname}${urlObj.pathname === '/' ? '' : urlObj.pathname}`.replace(/\/$/, '');
    } catch (error) {
      let normalized = url.trim().replace(/\/$/, '');
      normalized = normalized.replace('://www.', '://');
      return normalized;
    }
  }

  /**
   * Gets a site by its base URL.
   * @param {string} baseUrl - The base URL of the site.
   * @returns {Promise<object>} The site object.
   */
  async getSiteByBaseUrl(baseUrl) {
    const normalizedUrl = this.normalizeBaseUrl(baseUrl);
    const base64Url = Buffer.from(normalizedUrl).toString('base64');
    const endpoint = `/sites/by-base-url/${base64Url}`;
    
    try {
      const site = await this.apiRequest(endpoint);
      return site;
    } catch (error) {
      if (error.message.includes('404')) {
        throw new Error(`Site not found for URL: ${normalizedUrl}. The site may need to be registered in SpaceCat first.`);
      }
      throw new Error(`Failed to get site for ${normalizedUrl}: ${error.message}`);
    }
  }

  /**
   * Gets all opportunities for a given site.
   * @param {string} siteId - The ID of the site.
   * @returns {Promise<Array<object>>} A list of opportunities.
   */
  async getSiteOpportunities(siteId) {
    const response = await this.apiRequest(`/sites/${siteId}/opportunities`);
    return response || [];
  }

  /**
   * Ensures a 'cwv' type opportunity exists for the site, creating it if necessary.
   * @param {string} siteId - The ID of the site.
   * @returns {Promise<object>} The CWV opportunity object.
   */
  async ensureCWVOpportunity(siteId) {
    const opportunities = await this.getSiteOpportunities(siteId);
    let cwvOpportunity = opportunities.find(opp => opp.type === 'cwv');
    
    if (!cwvOpportunity) {
      cwvOpportunity = await this.apiRequest(`/sites/${siteId}/opportunities`, {
        method: 'POST',
        body: JSON.stringify({
          runbook: 'https://adobe.sharepoint.com/:w:/r/sites/aemsites-engineering/Shared%20Documents/3%20-%20Experience%20Success/SpaceCat/Runbooks/Experience_Success_Studio_CWV_Manual_Fixes_Runbook.docx?d=we2ed571373d4417a92c38ab68eb8e26f&csf=1&web=1&e=UmwuT1',
          origin: 'ESS_OPS',
          siteId: siteId,
          status: 'NEW',
          type: 'cwv',
          data: {
            dataSources: ['RUM', 'Site']
          },
          title: 'CWV Optimization Opportunity',
        })
      });
    }
    
    return cwvOpportunity;
  }

  /**
   * Checks for existing suggestions for a given opportunity.
   * @param {string} siteId - The site ID.
   * @param {string} opportunityId - The opportunity ID.
   * @returns {Promise<{exists: boolean, count: number, suggestions: Array<object>}>}
   */
  async checkExistingSuggestions(siteId, opportunityId) {
    const response = await this.apiRequest(`/sites/${siteId}/opportunities/${opportunityId}/suggestions`);
    const suggestions = response.data || [];
    return {
      exists: suggestions.length > 0,
      count: suggestions.length,
      suggestions: suggestions
    };
  }

  /**
   * Uploads suggestions for an opportunity. This will replace all existing suggestions.
   * @param {string} siteId - The site ID.
   * @param {string} opportunityId - The opportunity ID.
   * @param {Array<object>} suggestions - The suggestions to upload.
   * @returns {Promise<object>} The result from the API.
   */
  async updateSuggestions(siteId, opportunityId, suggestions) {
    return this.apiRequest(`/sites/${siteId}/opportunities/${opportunityId}/suggestions`, {
      method: 'POST', // The endpoint seems to handle create/update via POST
      body: JSON.stringify(suggestions)
    });
  }

  /**
   * Cleans up any resources used by the client, like authentication timers.
   */
  cleanup() {
    if (this.authWrapper && this.authWrapper.cleanup) {
      this.authWrapper.cleanup();
      console.log('SpaceCatClient: Auth wrapper cleaned up.');
    }
  }
} 