import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class MCPClientDemo {
  constructor(serverUrl = 'http://localhost:3000/mcp') {
    this.serverUrl = serverUrl;
    this.client = null;
    this.transport = null;
  }

  async connect() {
    try {
      console.log(`🔌 Connecting to MCP server at ${this.serverUrl}...`);

      this.client = new Client({
        name: "mcp-demo-client",
        version: "1.0.0"
      });

      this.transport = new StreamableHTTPClientTransport(
        new URL(this.serverUrl)
      );

      await this.client.connect(this.transport);
      console.log('✅ Connected to MCP server successfully!');
      return true;
    } catch (error) {
      console.error('❌ Failed to connect to MCP server:', error.message);
      return false;
    }
  }

  async disconnect() {
    if (this.transport) {
      await this.transport.close();
      console.log('🔌 Disconnected from MCP server.');
    }
  }

  async listTools() {
    try {
      console.log('\n📋 Listing available tools...');
      const tools = await this.client.listTools();

      if (tools.tools.length === 0) {
        console.log('-  No tools available');
        return;
      }

      tools.tools.forEach(tool => {
        console.log(`-  ${tool.name}: ${tool.description}`);
        if (tool.inputSchema && tool.inputSchema.properties) {
          const params = Object.keys(tool.inputSchema.properties).join(', ');
          console.log(`   Parameters: ${params}`);
        }
      });

      return tools.tools;
    } catch (error) {
      console.error('❌ Error listing tools:', error.message);
      return [];
    }
  }

  async listResources() {
    try {
      console.log('\n📚 Listing available resources...');
      const resources = await this.client.listResources();

      if (resources.resources.length === 0) {
        console.log('-  No resources available');
        return;
      }

      resources.resources.forEach(resource => {
        console.log(`-  ${resource.uri}: ${resource.description || resource.name}`);
        if (resource.mimeType) {
          console.log(`   Type: ${resource.mimeType}`);
        }
      });

      return resources.resources;
    } catch (error) {
      console.error('❌ Error listing resources:', error.message);
      return [];
    }
  }

  async listPrompts() {
    try {
      console.log('\n💭 Listing available prompts...');
      const prompts = await this.client.listPrompts();

      if (prompts.prompts.length === 0) {
        console.log('-  No prompts available');
        return;
      }

      prompts.prompts.forEach(prompt => {
        console.log(`-  ${prompt.name}: ${prompt.description}`);
        if (prompt.arguments && prompt.arguments.length > 0) {
          const args = prompt.arguments.map(arg =>
            `${arg.name}${arg.required ? ' (required)' : ' (optional)'}`
          ).join(', ');
          console.log(`   Arguments: ${args}`);
        }
      });

      return prompts.prompts;
    } catch (error) {
      console.error('❌ Error listing prompts:', error.message);
      return [];
    }
  }

  async callTool(name, arguments_) {
    try {
      console.log(`\n🔧 Calling tool "${name}" with arguments:`, arguments_);
      const result = await this.client.callTool({
        name: name,
        arguments: arguments_
      });

      // console.log('✅ Tool result:');
      // result.content.forEach(content => {
      //   if (content.type === 'text') {
      //     console.log(`   ${content.text}`);
      //   } else {
      //     console.log(`   [${content.type}]:`, content);
      //   }
      // });

      return result;
    } catch (error) {
      console.error(`❌ Error calling tool "${name}":`, error.message);
      return null;
    }
  }

  async readResource(uri) {
    try {
      console.log(`\n📖 Reading resource: ${uri}`);
      const result = await this.client.readResource({ uri });

      console.log('✅ Resource content:');
      result.contents.forEach(content => {
        console.log(`   URI: ${content.uri}`);
        if (content.mimeType) {
          console.log(`   Type: ${content.mimeType}`);
        }
        console.log(`   Content: ${content.text || '[Binary content]'}`);
      });

      return result;
    } catch (error) {
      console.error(`❌ Error reading resource "${uri}":`, error.message);
      return null;
    }
  }

  async getPrompt(name, arguments_) {
    try {
      console.log(`\n💭 Getting prompt "${name}" with arguments:`, arguments_);
      const result = await this.client.getPrompt({
        name: name,
        arguments: arguments_
      });

      console.log('✅ Prompt result:');
      result.messages.forEach((message, index) => {
        console.log(`   Message ${index + 1} (${message.role}):`);
        if (message.content.type === 'text') {
          console.log(`   ${message.content.text}`);
        } else {
          console.log(`   [${message.content.type}]:`, message.content);
        }
      });

      return result;
    } catch (error) {
      console.error(`❌ Error getting prompt "${name}":`, error.message);
      return null;
    }
  }

  // async runDemo() {
  //   console.log('🎬 Starting MCP Client Demo...\n');
  //
  //   if (!await this.connect()) {
  //     return;
  //   }
  //
  //   try {
  //     // List all available capabilities
  //     await this.listTools();
  //     await this.listResources();
  //     await this.listPrompts();
  //
  //     // Demo tool calls
  //     console.log('\n🔧 === TOOL DEMONSTRATIONS ===');
  //     await this.callTool('add', { a: 15, b: 27 });
  //     await this.callTool('multiply', { x: 8, y: 9 });
  //     // Scrape tool requires external services, commented out for basic demo
  //     await this.callTool('scrape', { url: "https://example.com" });
  //
  //     // Demo resource reads
  //     console.log('\n📚 === RESOURCE DEMONSTRATIONS ===');
  //     await this.readResource('info://server');
  //     await this.readResource('greeting://Alice');
  //     await this.readResource('greeting://Bob');
  //
  //     // Demo prompt
  //     console.log('\n💭 === PROMPT DEMONSTRATIONS ===');
  //     await this.getPrompt('review-code', {
  //       code: 'function add(a, b) { return a + b; }',
  //       language: 'javascript'
  //     });
  //
  //   } catch (error) {
  //     console.error('❌ Demo error:', error.message);
  //   } finally {
  //     await this.disconnect();
  //   }
  // }

  createMcpContentResult(results) {
    return {
      content: results.map((result) => ({
        type: 'text',
        text: JSON.stringify(result, null, 2),
      })),
    };
  }
}

// Interactive CLI mode
async function interactiveMode() {
  const client = new MCPClientDemo();

  if (!await client.connect()) {
    process.exit(1);
  }

  console.log('\n🎮 Interactive MCP Client');
  console.log('Commands:');
  console.log('  list tools    - Show available tools');
  console.log('  list resources - Show available resources');
  console.log('  list prompts  - Show available prompts');
  console.log('  call <tool> <json-args> - Call a tool');
  console.log('  read <uri>    - Read a resource');
  console.log('  prompt <name> <json-args> - Get a prompt');
  console.log('  demo          - Run full demo');
  console.log('  exit          - Quit');

  // Note: In a real implementation, you'd use readline or another input library
  // For this demo, we'll just run the automated demo
  console.log('\n📝 Running automated demo (interactive mode would require readline)...');
  // await client.runDemo();
}

// Main execution
// async function startMcp() {
//   const args = process.argv.slice(2);
//
//   if (args.includes('--interactive') || args.includes('-i')) {
//     await interactiveMode();
//   } else {
//     const client = new MCPClientDemo();
//     // await client.runDemo();
//   }
// }

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Goodbye!');
  process.exit(0);
});

// Run the client
// startMcp().catch(error => {
//   console.error('❌ Client error:', error);
//   process.exit(1);
// });
