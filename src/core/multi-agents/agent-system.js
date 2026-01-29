/**
 * Agent System Classes
 * Extracted from multi-agents.js for better maintainability
 *
 * Contains:
 * - Tool: Wrapper for LangChain DynamicTool
 * - Agent: Individual agent with LLM, prompts, and optional tools
 * - MultiAgentSystem: Orchestrates multiple agents with parallel execution
 */

import { ChatPromptTemplate } from '@langchain/core/prompts';
import { DynamicTool } from '@langchain/core/tools';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

/**
 * Tool Wrapper
 * Wraps a function as a LangChain DynamicTool for agent use
 */
export class Tool {
    constructor({ name, description, func }) {
        this.name = name;
        this.description = description;
        this.instance = new DynamicTool({ name, description, func });
    }
}

/**
 * Agent
 * Represents a single AI agent with specific role and capabilities
 */
export class Agent {
    constructor({ name, role, systemPrompt, humanPrompt = "", llm, tools = [], globalSystemPrompt = "" }) {
        if (typeof systemPrompt !== "string" || typeof humanPrompt !== "string") {
            throw new Error(`Invalid prompt for Agent "${name}"`);
        }

        const combinedSystem = [globalSystemPrompt, systemPrompt]
            .filter((s) => typeof s === 'string' && s.trim().length > 0)
            .join('\n\n');

        const prompt = ChatPromptTemplate.fromMessages([
            new SystemMessage(combinedSystem),
            new HumanMessage(humanPrompt)
        ]);

        this.name = name;
        this.role = role;
        this.tools = tools;
        this.llm = llm;

        // Extract the base LLM from ModelAdapter if needed for RunnableSequence
        const baseLLM = llm.getBaseLLM ? llm.getBaseLLM() : llm;
        this.chain = RunnableSequence.from([prompt, baseLLM, new StringOutputParser()]);
    }

    async invoke(input) {
        // Use native tool calling if tools are available
        if (this.tools.length > 0) {
            // Extract base LLM for tool binding
            const baseLLM = this.llm.getBaseLLM ? this.llm.getBaseLLM() : this.llm;
            // Bind tools to LLM for native tool calling
            const llmWithTools = baseLLM.bindTools(this.tools.map(t => t.instance));

            // Create message array with system and human messages
            const messages = [
                new SystemMessage(this.chain.steps[0].promptMessages[0].prompt.template),
                new HumanMessage(input)
            ];

            // Initial invocation
            let aiMessage = await llmWithTools.invoke(messages);
            messages.push(aiMessage);

            // Auto-loop on tool calls
            while (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
                for (const toolCall of aiMessage.tool_calls) {
                    const tool = this.tools.find(t => t.name === toolCall.name);
                    if (tool) {
                        const toolMessage = await tool.instance.invoke(toolCall);
                        messages.push(toolMessage);
                    }
                }
                aiMessage = await llmWithTools.invoke(messages);
                messages.push(aiMessage);
            }

            return aiMessage.content;
        }

        // Fallback to simple chain for agents without tools
        const result = await this.chain.invoke({ input });
        return result;
    }
}

/**
 * MultiAgentSystem
 * Manages multiple agents and orchestrates their parallel execution
 */
export class MultiAgentSystem {
    constructor({ llm, toolsConfig, agentsConfig, globalSystemPrompt = "" }) {
        this.llm = llm;
        this.tools = new Map();
        this.agents = new Map();
        this.globalSystemPrompt = globalSystemPrompt;

        this.initTools(toolsConfig);
        this.initAgents(agentsConfig);
    }

    initTools(toolsConfig) {
        for (const toolConf of toolsConfig) {
            const tool = new Tool(toolConf);
            this.tools.set(tool.name, tool);
        }
    }

    initAgents(agentsConfig) {
        for (const config of agentsConfig) {
            const tools = config.toolNames?.map(name => this.tools.get(name)).filter(Boolean) || [];
            const agent = new Agent({ ...config, llm: this.llm, tools, globalSystemPrompt: this.globalSystemPrompt });
            this.agents.set(config.name, agent);
        }
    }

    /**
     * Execute multiple agent tasks in parallel with batching and retry logic
     * @param {Array} tasks - Array of {agent: string, description?: string}
     * @returns {Promise<Array>} Array of {agent: string, output: string}
     */
    async executeParallelTasks(tasks) {
        const total = tasks.length;
        let completed = 0;

        // Rate limiting configuration
        const BATCH_SIZE = parseInt(process.env.AGENT_BATCH_SIZE || '3', 10);
        const DELAY_BETWEEN_BATCHES = parseInt(process.env.AGENT_BATCH_DELAY || '2000', 10); // ms
        const MAX_RETRIES = 3;
        const INITIAL_RETRY_DELAY = 5000; // 5 seconds

        // Helper: Execute single agent with retry logic
        const executeAgentWithRetry = async ({ agent: agentName, description }, retryCount = 0) => {
            const agent = this.agents.get(agentName);
            if (!agent) throw new Error(`Agent ${agentName} not found`);
            const input = description || `Please perform your assigned role as ${agent.role}`;
            const t0 = Date.now();

            try {
                const output = await agent.invoke(input);
                const dt = ((Date.now() - t0) / 1000).toFixed(1);
                completed++;
                console.log(`✅ ${agentName} (${Math.round(completed / total * 100)}%, ${Number(dt)}s)`);
                return { agent: agentName, output };
            } catch (err) {
                const dt = ((Date.now() - t0) / 1000).toFixed(1);

                // Check if it's a rate limit error (429)
                const isRateLimitError = err.message?.includes('429') ||
                    err.message?.includes('Resource exhausted') ||
                    err.message?.includes('rateLimitExceeded');

                if (isRateLimitError && retryCount < MAX_RETRIES) {
                    const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount); // Exponential backoff
                    console.log(`⚠️  ${agentName} hit rate limit, retrying in ${retryDelay / 1000}s (attempt ${retryCount + 1}/${MAX_RETRIES})`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    return executeAgentWithRetry({ agent: agentName, description }, retryCount + 1);
                }

                completed++;
                console.log(`❌ ${agentName} (${Math.round(completed / total * 100)}%, ${Number(dt)}s):`, err.message);
                return { agent: agentName, output: `Error: ${err.message}` };
            }
        };

        // Execute tasks in batches to avoid rate limiting
        const results = [];
        for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
            const batch = tasks.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(tasks.length / BATCH_SIZE);

            console.log(`🔄 Executing batch ${batchNum}/${totalBatches} (${batch.length} agents)...`);

            // Execute batch in parallel
            const batchResults = await Promise.all(batch.map(task => executeAgentWithRetry(task)));
            results.push(...batchResults);

            // Add delay between batches (except after last batch)
            if (i + BATCH_SIZE < tasks.length) {
                console.log(`⏳ Waiting ${DELAY_BETWEEN_BATCHES / 1000}s before next batch...`);
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }
        }

        return results;
    }
}
