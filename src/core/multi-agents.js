// -------------------- Imports --------------------
import {ChatPromptTemplate} from "@langchain/core/prompts";
import {DynamicTool} from "@langchain/core/tools";
import {RunnableSequence} from "@langchain/core/runnables";
import {StringOutputParser} from "@langchain/core/output_parsers";
import {cacheResults} from '../utils.js';

import {
    actionPrompt, codeStep, coverageStep, coverageSummaryStep,
    cruxStep, cruxSummaryStep, harStep, harSummaryStep,
    htmlStep, perfStep, perfSummaryStep, psiStep,
    psiSummaryStep, rulesStep
} from "../prompts/index.js";

import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import {Tiktoken} from "js-tiktoken/lite";
import rules from "../rules/index.js";
import {HumanMessage, SystemMessage} from "@langchain/core/messages";
import {
    codeReviewAgentPrompt, coverageAgentPrompt,
    cruxAgentPrompt, harAgentPrompt, htmlAgentPrompt,
    perfObserverAgentPrompt, psiAgentPrompt, rulesAgentPrompt
} from "../prompts/initialize.js";

// -------------------- Tool Wrapper --------------------
export class Tool {
    constructor({name, description, func}) {
        this.name = name;
        this.description = description;
        this.instance = new DynamicTool({name, description, func});
    }
}

// -------------------- Agent --------------------
export class Agent {
    constructor({name, role, systemPrompt, humanPrompt = "", llm, tools = []}) {
        if (typeof systemPrompt !== "string" || typeof humanPrompt !== "string") {
            throw new Error(`Invalid prompt for Agent "${name}"`);
        }

        const prompt = ChatPromptTemplate.fromMessages([
            new SystemMessage(systemPrompt),
            new HumanMessage(humanPrompt)
        ]);

        this.name = name;
        this.role = role;
        this.tools = tools;
        // this.llm = LangchainLLMFactory.createLLM(llm);
        this.llm = llm
        this.chain = RunnableSequence.from([prompt, this.llm, new StringOutputParser()]); // ← Fixed: use this.llm
    }

    async invoke(input) {
        let processedInput = input;

        const toolDecision = await this.shouldUseTool(input);
        if (toolDecision?.use && toolDecision?.toolObj) {
            const toolResult = await toolDecision.toolObj.instance.func(toolDecision.query);
            processedInput += `\n\nTool Result: ${toolResult}`;
        }

        const result = await this.chain.invoke({input: processedInput});
        return result;
    }

    async shouldUseTool(input) {
        if (!this.tools.length) return {use: false};

        const toolNames = this.tools.map(t => t.name).join(", ");
        const toolPrompt = `
Given this input: "${input}"
Available tools: ${toolNames}
Should I use a tool? Respond as:
{"use": true/false, "tool": "tool_name", "query": "search_query"}
`;

        try {
            const response = await this.llm.invoke([{role: "user", content: toolPrompt}]);
            const raw = response.content.replace(/```json|```/gi, "").trim();
            const parsed = JSON.parse(raw);
            const selectedTool = this.tools.find(t => t.name === parsed.tool);
            return {...parsed, toolObj: selectedTool};
        } catch (error) {
            console.warn("Tool decision parsing failed:", error.message);
            return {use: false};
        }
    }
}

// -------------------- MultiAgentSystem --------------------
export class MultiAgentSystem {
    constructor({llm, toolsConfig, agentsConfig}) {
        this.llm = llm;
        this.tools = new Map();
        this.agents = new Map();

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
            const agent = new Agent({...config, llm: this.llm, tools});
            this.agents.set(config.name, agent);
        }
    }

    async executeSequentialTasks(tasks) {
        const results = [];
        let context = "";

        for (let i = 0; i < tasks.length; i++) {
            const {agent: agentName, description = ""} = tasks[i];
            const agent = this.agents.get(agentName);
            if (!agent) throw new Error(`Agent ${agentName} not found`);

            const input = `${description}${context ? `\n\nPrevious Context:\n${context}` : ""}`;
            const output = await agent.invoke(input);
            results.push({phase: i + 1, agent: agentName, output});
            context += `\n${agentName}: ${output}`;
        }
        return results;
    }

    async executeParallelTasks(tasks) {
        return await Promise.all(tasks.map(async ({agent: agentName, description}) => {
            const agent = this.agents.get(agentName);
            if (!agent) throw new Error(`Agent ${agentName} not found`);
            const input = description || `Please perform your assigned role as ${agent.role}`;
            const output = await agent.invoke(input);
            return {agent: agentName, output};
        }));
    }
}

// -------------------- Utility Functions --------------------
const countTokens = (text) => new Tiktoken(cl100k_base).encode(text).length;

const isPromptValid = (length, limits) =>
    length <= (limits.input - limits.output) * 0.9;

const generateAgentConfig = (isSummary, pageData, cms) => {
    const steps = {
        "Crux Agent": [cruxAgentPrompt(cms), isSummary ? cruxSummaryStep(pageData.cruxSummary) : cruxStep(pageData.crux)],
        "Psi Agent": [psiAgentPrompt(cms), isSummary ? psiSummaryStep(pageData.psiSummary) : psiStep(pageData.psi)],
        "Perf Observer Agent": [perfObserverAgentPrompt(cms), isSummary ? perfSummaryStep(pageData.perfEntriesSummary) : perfStep(pageData.perfEntries)],
        "Har Agent": [harAgentPrompt(cms), isSummary ? harSummaryStep(pageData.harSummary) : harStep(pageData.har)],
        "Html Agent": [htmlAgentPrompt(cms), htmlStep(pageData.pageUrl, pageData.resources)],
        "Rules Agent": [rulesAgentPrompt(cms), isSummary ? rulesStep(pageData.rulesSummary) : rulesStep(rules)],
        "Coverage Agent": [coverageAgentPrompt(cms), isSummary ? coverageSummaryStep(pageData.coverageDataSummary) : coverageStep(pageData.coverageData)],
        "Code Review Agent": [codeReviewAgentPrompt(cms), codeStep(pageData.pageUrl, pageData.resources, 10_000)]
    };

    return Object.entries(steps).map(([name, [sys, hum]]) => ({
        name,
        role: name.replace(/_/g, " ").replace("agent", "").trim(),
        systemPrompt: sys,
        humanPrompt: hum
    }));
};

function getBlueText(text) {
    const blue = '\x1b[34m';
    const reset = '\x1b[0m';
    return blue + text + reset;
}

// -------------------- Main Runner --------------------
export async function runMultiAgents(pageData, tokenLimits, llm) {
    let agentsConfig = generateAgentConfig(false, pageData, pageData.cms);
    const summaryConfig = generateAgentConfig(true, pageData, pageData.cms);

    // Check if the system prompt is valid
    agentsConfig = agentsConfig.map((agent, i) => {
        const tokenLength = countTokens(agent.systemPrompt) + countTokens(agent.humanPrompt);
        if (!isPromptValid(tokenLength, tokenLimits)) {
            // Count tokens for the summary prompt
            const summaryTokenLength = countTokens(summaryConfig[i].systemPrompt) + countTokens(summaryConfig[i].humanPrompt);
            console.log(`${agent.name} prompt is too long. Estimated token size ~ ${getBlueText(tokenLength)}. Using summarized prompt. Estimated token size ~ ${getBlueText(summaryTokenLength)}.`);
            return {...agent, humanPrompt: summaryConfig[i].humanPrompt};
        } else {
            console.log(`${agent.name} prompt is valid. Estimated token size ~ ${getBlueText(tokenLength)}.`);
        }
        return agent;
    });

    cacheResults(pageData.pageUrl, pageData.deviceType, 'prompt', agentsConfig.map(a => a.systemPrompt).join('\n') + '\n' + agentsConfig.map(a => a.humanPrompt).join('\n' + '-'.repeat(64) + '\n'));

    const system = new MultiAgentSystem({
        llm,
        toolsConfig: [],
        agentsConfig
    });

    const tasks = agentsConfig.map(agent => ({agent: agent.name}));
    const responses = await system.executeParallelTasks(tasks);

    console.log("\nParallel Results:");

    let result = "";
    let context = "";
    responses.forEach(({agent, output}, index) => {
        const section = `## Phase ${index + 1} - ${agent}:\n${output}`;
        result += `\n\n${section}`;
        context += `\n${agent}: ${output}`;
    });

    // -------------------- Final Action Prompt --------------------
    const finalPrompt = actionPrompt(pageData.pageUrl, pageData.deviceType);

    const finalChain = RunnableSequence.from([
        ChatPromptTemplate.fromMessages([
            new SystemMessage(finalPrompt),
            new HumanMessage(`Here is the context from previous agents:\n${context}`)
        ]),
        llm,
        new StringOutputParser()
    ]);

    const finalOutput = await finalChain.invoke({input: context});

    // Return both the outputs and suggestions
    return result + "\n\n## Final Suggestions:\n" + finalOutput;
}
