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
import { Result } from '../result.js';
import { ErrorCodes } from '../error-codes.js';

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

    /**
     * Safe wrapper for invoke() that returns Result
     * Includes retry logic with exponential backoff for rate limits
     * @param {string} input - Input prompt for the agent
     * @param {number} maxRetries - Maximum retry attempts (default: 3)
     * @returns {Promise<Result>} Result containing agent output or error
     */
    async invokeSafe(input, maxRetries = 3) {
        const startTime = Date.now();
        const INITIAL_RETRY_DELAY = 5000; // 5 seconds

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const output = await this.invoke(input);
                return Result.ok(output, {
                    agent: this.name,
                    attempts: attempt + 1,
                    duration: Date.now() - startTime
                });
            } catch (error) {
                // Check if it's a rate limit error (429)
                const isRateLimitError = error.message?.includes('429') ||
                    error.message?.includes('Resource exhausted') ||
                    error.message?.includes('rateLimitExceeded');

                // If rate limit and retries remaining, retry with exponential backoff
                if (isRateLimitError && attempt < maxRetries - 1) {
                    const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
                    console.log(`⚠️  ${this.name} hit rate limit, retrying in ${retryDelay / 1000}s (attempt ${attempt + 2}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    continue;
                }

                // All retries exhausted or non-retryable error
                const errorCode = isRateLimitError ? ErrorCodes.RATE_LIMIT : ErrorCodes.ANALYSIS_FAILED;
                return Result.err(
                    errorCode,
                    `Agent ${this.name} failed: ${error.message}`,
                    {
                        agent: this.name,
                        attempts: attempt + 1,
                        error: error.stack
                    },
                    isRateLimitError // Rate limits are retryable
                );
            }
        }

        // Should never reach here, but added for completeness
        return Result.err(
            ErrorCodes.ANALYSIS_FAILED,
            `Agent ${this.name} failed after ${maxRetries} attempts`,
            { agent: this.name, attempts: maxRetries },
            false
        );
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
     * @returns {Promise<Array>} Array of {agent: string, result: Result}
     */
    async executeParallelTasks(tasks) {
        const total = tasks.length;
        let completed = 0;

        // Rate limiting configuration
        const BATCH_SIZE = parseInt(process.env.AGENT_BATCH_SIZE || '3', 10);
        const DELAY_BETWEEN_BATCHES = parseInt(process.env.AGENT_BATCH_DELAY || '2000', 10); // ms
        const MAX_RETRIES = 3;

        // Helper: Execute single agent using invokeSafe
        const executeAgent = async ({ agent: agentName, description }) => {
            const agent = this.agents.get(agentName);
            if (!agent) {
                return {
                    agent: agentName,
                    result: Result.err(
                        ErrorCodes.MISSING_CONFIG,
                        `Agent ${agentName} not found`,
                        { agent: agentName },
                        false
                    )
                };
            }

            const input = description || `Please perform your assigned role as ${agent.role}`;
            const t0 = Date.now();

            // Use invokeSafe which includes retry logic
            const result = await agent.invokeSafe(input, MAX_RETRIES);
            const dt = ((Date.now() - t0) / 1000).toFixed(1);
            completed++;

            if (result.isOk()) {
                console.log(`✅ ${agentName} (${Math.round(completed / total * 100)}%, ${Number(dt)}s)`);
            } else {
                console.log(`❌ ${agentName} (${Math.round(completed / total * 100)}%, ${Number(dt)}s):`, result.error.message);
            }

            return { agent: agentName, result };
        };

        // Execute tasks in batches to avoid rate limiting
        const results = [];
        for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
            const batch = tasks.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(tasks.length / BATCH_SIZE);

            console.log(`🔄 Executing batch ${batchNum}/${totalBatches} (${batch.length} agents)...`);

            // Execute batch in parallel
            const batchResults = await Promise.all(batch.map(task => executeAgent(task)));
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
