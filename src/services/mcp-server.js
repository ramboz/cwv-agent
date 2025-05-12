import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import express from 'express';
import { z } from 'zod';
import { collect as collectCrux } from '../tools/crux.js';
import { collect as collectHar } from '../tools/har.js';
import { collect as collectPsi } from '../tools/psi.js';
import { collect as collectCode } from '../tools/code.js';
import { applyRules } from '../tools/rules.js';
import { detectAEMVersion } from '../tools/aem.js';
import merge from '../tools/merge.js';
import { estimateTokenSize } from '../utils.js';
import dotenv from 'dotenv';

dotenv.config();

// Create MCP Server
const server = new McpServer({
  name: "cwv-mcp-server",
  version: "1.0.0",
  defaultRequestOptions: {
    timeout: 300000, // 300 seconds (5 minutes)
    resetTimeoutOnProgress: true
  }
});

// Define schemas for tool parameters
const PageUrlDeviceOptionsSchema = {
  pageUrl: z.string().url(),
  deviceType: z.enum(["mobile", "desktop"]),
  options: z.record(z.any()).optional().default({})
};

const CodeCollectionSchema = {
  ...PageUrlDeviceOptionsSchema,
  requests: z.array(z.string())
};

const RulesSchema = {
  ...PageUrlDeviceOptionsSchema,
  data: z.record(z.any())
};

const AemDetectionSchema = z.object({
  headers: z.array(z.record(z.any())),
  fullHtml: z.string()
});

// Register tools
server.tool(
  "crux",
  PageUrlDeviceOptionsSchema,
  async ({ pageUrl, deviceType, options }) => {
    const result = await collectCrux(pageUrl, deviceType, options);
    if (result.full.error && result.full.error.code === 404) {
      console.warn('ℹ️  No CrUX data for that page.');
    } else if (result.full.error) {
      console.error('❌ Failed to collect CrUX data.', result.full.error.message);
    } else if (result.fromCache) {
      console.log('✓ Loaded CrUX data from cache. Estimated token size: ~', estimateTokenSize(result.full));
    } else {
      console.log('✅ Processed CrUX data. Estimated token size: ~', estimateTokenSize(result.full));
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "psi",
  PageUrlDeviceOptionsSchema,
  async ({ pageUrl, deviceType, options }) => {
    const result = await collectPsi(pageUrl, deviceType, options);
    if (result.fromCache) {
      console.log('✓ Loaded PSI data from cache. Estimated token size: ~', estimateTokenSize(result.full));
    } else {
      console.log('✅ Processed PSI data. Estimated token size: ~', estimateTokenSize(result.full));
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "har",
  PageUrlDeviceOptionsSchema,
  async ({ pageUrl, deviceType, options }) => {
    const result = await collectHar(pageUrl, deviceType, options);
    if (result.fromCache) {
      console.log('✓ Loaded HAR data from cache. Estimated token size: ~', estimateTokenSize(result.har));
      console.log('✓ Loaded Performance Entries data from cache. Estimated token size: ~', estimateTokenSize(result.perfEntries));
      console.log('✓ Loaded full rendered HTML markup from cache. Estimated token size: ~', estimateTokenSize(result.fullHtml));
      console.log('✓ Loaded JS API data from cache. Estimated token size: ~', estimateTokenSize(result.jsApi));
    } else {
      console.log('✅ Processed HAR data. Estimated token size: ~', estimateTokenSize(result.har));
      console.log('✅ Processed Performance Entries data. Estimated token size: ~', estimateTokenSize(result.perfEntries));
      console.log('✅ Processed full rendered HTML markup. Estimated token size: ~', estimateTokenSize(result.fullHtml));
      console.log('✅ Processed JS API data. Estimated token size: ~', estimateTokenSize(result.jsApi));
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "code",
  CodeCollectionSchema,
  async ({ pageUrl, deviceType, requests, options }) => {
    const result = await collectCode(pageUrl, deviceType, requests, options);
    if (result.stats.fromCache === result.stats.total) {
      console.log('✓ Loaded code from cache. Estimated token size: ~', estimateTokenSize(result.codeFiles));
    } else if (result.stats.fromCache > 0) {
      console.log(`✓ Partially loaded code from cache (${result.stats.fromCache}/${result.stats.total}). Estimated token size: ~`, estimateTokenSize(result.codeFiles));
    } else if (result.stats.failed > 0) {
      console.error('❌ Failed to collect all project code. Estimated token size: ~', estimateTokenSize(result.codeFiles));
    } else {
      console.log('✅ Processed project code. Estimated token size: ~', estimateTokenSize(result.codeFiles));
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "rules",
  RulesSchema,
  async ({ pageUrl, deviceType, options, data }) => {
    const result = await applyRules(pageUrl, deviceType, options, data);
    if (result.fromCache) {
      console.log('✓ Loaded rules from cache. Estimated token size: ~', estimateTokenSize(result.summary));
    } else {
      console.log('✅ Processed rules. Estimated token size: ~', estimateTokenSize(result.summary));
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "aem",
  AemDetectionSchema,
  async ({ headers, fullHtml }) => {
    const version = detectAEMVersion(headers, fullHtml);
    console.log('AEM Version:', version);
    return { content: [{ type: "text", text: version }] };
  }
);

server.tool(
  "merge",
  z.object({ pageUrl: z.string(), deviceType: z.string() }),
  async ({ pageUrl, deviceType }) => {
    const result = merge(pageUrl, deviceType);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "collect-all",
  PageUrlDeviceOptionsSchema,
  async ({ pageUrl, deviceType, options }) => {
    try {
      // Sequential calls to ensure proper error handling and logging
      const cruxResult = await collectCrux(pageUrl, deviceType, options);
      const psiResult = await collectPsi(pageUrl, deviceType, options);
      const harResult = await collectHar(pageUrl, deviceType, options);
      const requests = harResult.har.log.entries.map((e) => e.request.url);
      const codeResult = await collectCode(pageUrl, deviceType, requests, options);
      const report = merge(pageUrl, deviceType);
      const rulesResult = await applyRules(pageUrl, deviceType, options, {
        crux: cruxResult.full,
        psi: psiResult.full,
        har: harResult.har,
        perfEntries: harResult.perfEntries,
        resources: codeResult.codeFiles,
        fullHtml: harResult.fullHtml,
        jsApi: harResult.jsApi,
        report
      });
      
      const cms = detectAEMVersion(harResult.har.log.entries[0].headers, harResult.fullHtml);
      
      const result = {
        har: harResult.har,
        harSummary: harResult.harSummary,
        psi: psiResult.full,
        psiSummary: psiResult.summary,
        resources: codeResult.codeFiles,
        crux: cruxResult.full,
        cruxSummary: cruxResult.summary,
        perfEntries: harResult.perfEntries,
        perfEntriesSummary: harResult.perfEntriesSummary,
        fullHtml: harResult.fullHtml,
        jsApi: harResult.jsApi,
        cms,
        rulesSummary: rulesResult.summary
      };
      
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      console.error('Collect All Error:', error);
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

// Set up HTTP server
const app = express();
const PORT = process.env.MCP_PORT || 3333;

// Setup HTTP transport for MCP
app.use(express.json({ limit: '50mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Create a map to store transports by session ID
const transports = {};

// MCP endpoint
app.post('/mcp', async (req, res) => {
  // Check for existing session ID
  const sessionId = req.headers['mcp-session-id'];
  let transport;

  if (sessionId && transports[sessionId]) {
    // Reuse existing transport
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New initialization request
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        // Store the transport by session ID
        transports[sessionId] = transport;
      }
    });

    // Clean up transport when closed
    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
      }
    };

    // ... set up server resources, tools, and prompts ...

    // Connect to the MCP server
    await server.connect(transport);
  } else {
    // Invalid request
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session ID provided',
      },
      id: null,
    });
    return;
  }
  // Handle the request
  await transport.handleRequest(req, res, req.body);
});

// Start HTTP server
const httpServer = app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
});

// Also support stdio for CLI usage
if (process.env.ENABLE_STDIO_TRANSPORT !== 'false') {
  const stdioTransport = new StdioServerTransport();
  server.connect(stdioTransport).catch(err => {
    console.error('Error connecting stdio transport:', err);
  });
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing MCP server');
  httpServer.close(() => {
    console.log('MCP server closed');
  });
});

export { server, httpServer }; 