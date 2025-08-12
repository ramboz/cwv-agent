/**
 * @fileoverview This file contains the implementation of the granular, on-demand
 * MCP (Model-Context-Protocol) tools for the CWV-Agent. These tools are designed
 * to be called by the Cursor agent to dynamically collect performance data and
 * context, allowing for a more intelligent and efficient diagnostic process.
 */

import { collect as collectPsi } from '../tools/psi.js';
import { collect as collectLabData } from '../tools/lab/index.js';
import { detectAEMVersion } from '../tools/aem.js';
import { initializeSystem } from '../prompts/index.js';
import { createTask, getTaskStatus, getTaskResult } from './task-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const urlAndOptionalDeviceType = {
  url: z.string().describe('The URL of the site to check against.'),
  deviceType: z.enum(['mobile', 'desktop']).default('mobile').describe('Device type (mobile or desktop)'),
};

const urlAndOptionalDeviceAndCacheType = {
  ...urlAndOptionalDeviceType,
  skipCache: z.boolean().default(false).describe('Whether to skip the cache and force a new data collection.'),
};

export const dataTools = {
  get_psi: {
    name: 'get_psi',
    description: 'Collects PageSpeed Insights (PSI) data for a given URL.',
    inputSchema: urlAndOptionalDeviceAndCacheType,
    execute: async ({ url, deviceType = 'mobile', skipCache = false }) => {
      const { full, summary } = await collectPsi(url, deviceType, { skipCache });
      return { full, summary };
    },
  },

  get_har: {
    name: 'get_har',
    description: 'Collects HAR data for a given URL.',
    inputSchema: urlAndOptionalDeviceAndCacheType,
    execute: async ({ url, deviceType = 'mobile', skipCache = false }) => {
      const { har, harSummary } = await collectLabData(url, deviceType, { skipCache });
      return { har, harSummary };
    },
  },

  get_code_coverage: {
    name: 'get_code_coverage',
    description: 'Collects JavaScript and CSS coverage data for a given URL.',
    inputSchema: urlAndOptionalDeviceAndCacheType,
    execute: async ({ url, deviceType = 'mobile', skipCache = false }) => {
      const { coverageData, coverageDataSummary } = await collectLabData(url, deviceType, { skipCache });
      return { coverageData, coverageDataSummary };
    },
  },

  get_rendered_html: {
    name: 'get_rendered_html',
    description: 'Collects the final rendered HTML of a page.',
    inputSchema: urlAndOptionalDeviceAndCacheType,
    execute: async ({ url, deviceType = 'mobile', skipCache = false }) => {
      const { fullHtml } = await collectLabData(url, deviceType, { skipCache });
      return { fullHtml };
    },
  },

  detect_cms: {
    name: 'detect_cms',
    description: 'Detects the CMS or technology stack of a site.',
    inputSchema: {
      url: z.string().describe('The URL of the site to detect the CMS of.'),
    },
    execute: async ({ url }) => {
      const { har, fullHtml } = await collectLabData(url, 'mobile', { skipCache: false });

      // Find the first HTML document in the HAR log. This is more reliable than assuming the first entry.
      const mainDocumentEntry = har.log.entries.find(
        (entry) => entry.response.content.mimeType && entry.response.content.mimeType.includes('text/html'),
      );

      let requestHeaders = [];
      if (mainDocumentEntry) {
        requestHeaders = mainDocumentEntry.request.headers;
      } else if (har.log.entries.length > 0) {
        // Fallback to the first entry's headers if no HTML entry is found
        requestHeaders = har.log.entries[0].request.headers;
        console.warn(`detectCms: Could not find main HTML document entry in HAR for ${url}. Falling back to first entry.`);
      } else {
        console.warn(`detectCms: No HAR entries found for ${url}. Proceeding with empty headers.`);
      }

      const cms = detectAEMVersion(requestHeaders, fullHtml);

      return { cms };
    },
  },

  get_prompt_context: {
    name: 'get_prompt_context',
    description: 'Retrieves the specific prompt context for a given CMS type.',
    inputSchema: {
      cmsType: z.string().describe('The type of CMS (e.g., "aemcs", "ams", "eds")'),
    },
    execute: async ({ cmsType }) => {
      const context = initializeSystem(cmsType);
      return { context };
    },
  },

  start_psi_collection: {
    name: 'start_psi_collection',
    description: 'Starts a long-running collection of PageSpeed Insights (PSI) data. Returns a taskId.',
    inputSchema: {
      url: z.string().describe('The URL of the site to check against.'),
      deviceType: z.enum(['mobile', 'desktop']).default('mobile').describe('Device type (mobile or desktop)'),
      skipCache: z.boolean().default(false).describe('Whether to skip the cache and force a new data collection.'),
    },
    execute: async ({ url, deviceType, skipCache }) => {
      // The worker function is what will be executed in the background.
      const worker = () => collectPsi(url, deviceType, { skipCache });
      const taskId = createTask(worker);
      return { taskId };
    },
  },

  get_psi_status: {
    name: 'get_psi_status',
    description: 'Checks the status of a PSI data collection task (PENDING, RUNNING, COMPLETE, FAILED).',
    inputSchema: {
      taskId: z.string().describe('The ID of the task to check.'),
    },
    execute: async ({ taskId }) => {
      return getTaskStatus(taskId);
    },
  },

  get_psi_result: {
    name: 'get_psi_result',
    description: 'Retrieves the result of a completed PSI data collection task. The task is cleared from memory after retrieval.',
    inputSchema: {
      taskId: z.string().describe('The ID of the task to retrieve.'),
    },
    execute: async ({ taskId }) => {
      const result = getTaskResult(taskId);
      if (!result) {
        return {
          error: 'Result not available. The task may still be running, may have failed, or the ID is invalid. Use get_psi_status to check.',
          summary: '',
          full: {},
        };
      }
      return result;
    },
  },
};
