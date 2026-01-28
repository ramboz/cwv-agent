/**
 * Lightweight template engine for prompts
 * Supports variable substitution, conditionals, and loops
 */

/**
 * Simple template engine with {{variable}} syntax
 */
export class TemplateEngine {
  constructor() {
    this.partials = new Map();
  }

  /**
   * Register a partial template
   * @param {string} name - Partial name
   * @param {string} template - Template string
   */
  registerPartial(name, template) {
    this.partials.set(name, template);
  }

  /**
   * Render a template with context
   * @param {string} template - Template string
   * @param {Object} context - Context variables
   * @returns {string} Rendered template
   */
  render(template, context = {}) {
    let result = template;

    // Process conditionals: {{#if variable}}...{{/if}}
    result = this.processConditionals(result, context);

    // Process loops: {{#each items}}...{{/each}}
    result = this.processLoops(result, context);

    // Process partials: {{> partialName}}
    result = this.processPartials(result, context);

    // Process variables: {{variable}}
    result = this.processVariables(result, context);

    return result;
  }

  /**
   * Process conditional blocks
   * @param {string} template - Template string
   * @param {Object} context - Context variables
   * @returns {string} Processed template
   */
  processConditionals(template, context) {
    const conditionalRegex = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;

    return template.replace(conditionalRegex, (match, variable, content) => {
      const value = this.getNestedValue(context, variable);
      return value ? content : '';
    });
  }

  /**
   * Process loop blocks
   * @param {string} template - Template string
   * @param {Object} context - Context variables
   * @returns {string} Processed template
   */
  processLoops(template, context) {
    const loopRegex = /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g;

    return template.replace(loopRegex, (match, variable, content) => {
      const items = this.getNestedValue(context, variable);
      if (!Array.isArray(items)) return '';

      return items
        .map((item, index) => {
          const itemContext = {
            ...context,
            this: item,
            '@index': index,
            '@first': index === 0,
            '@last': index === items.length - 1,
          };
          return this.processVariables(content, itemContext);
        })
        .join('');
    });
  }

  /**
   * Process partial includes
   * @param {string} template - Template string
   * @param {Object} context - Context variables
   * @returns {string} Processed template
   */
  processPartials(template, context) {
    const partialRegex = /\{\{>\s*(\w+)\}\}/g;

    return template.replace(partialRegex, (match, partialName) => {
      const partial = this.partials.get(partialName);
      if (!partial) {
        console.warn(`Partial '${partialName}' not found`);
        return '';
      }
      return this.render(partial, context);
    });
  }

  /**
   * Process variable substitutions
   * @param {string} template - Template string
   * @param {Object} context - Context variables
   * @returns {string} Processed template
   */
  processVariables(template, context) {
    const variableRegex = /\{\{([^>#/][^}]*)\}\}/g;

    return template.replace(variableRegex, (match, variable) => {
      const trimmed = variable.trim();
      const value = this.getNestedValue(context, trimmed);
      return value !== undefined && value !== null ? String(value) : '';
    });
  }

  /**
   * Get nested value from context using dot notation
   * @param {Object} context - Context object
   * @param {string} path - Dot-notation path
   * @returns {*} Value or undefined
   */
  getNestedValue(context, path) {
    const keys = path.split('.');
    let value = context;

    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return undefined;
      }
    }

    return value;
  }
}

/**
 * Prompt template manager
 */
export class PromptTemplateManager {
  constructor() {
    this.engine = new TemplateEngine();
    this.templates = new Map();
    this.examples = new Map();
    this.versions = new Map();

    // Register common partials
    this.registerCommonPartials();
  }

  /**
   * Register common partial templates
   */
  registerCommonPartials() {
    // Chain-of-thought guidance
    this.engine.registerPartial(
      'chainOfThought',
      `## Chain-of-Thought Reasoning (MANDATORY)

For EVERY finding, you MUST provide structured reasoning using this 4-step chain:

1. **Observation**: What specific data point did you observe?
   - Be concrete: Include file names, sizes (in KB/MB), timings (in ms)

2. **Diagnosis**: Why is this observation problematic for CWV?

3. **Mechanism**: How does this problem affect the specific metric?

4. **Solution**: Why will your proposed fix address the root cause?`
    );

    // Output schema partial
    this.engine.registerPartial(
      'outputSchema',
      `## Output Schema

You MUST output valid JSON matching this schema:

\`\`\`json
{
  "findings": [
    {
      "id": "string (unique identifier)",
      "type": "bottleneck | waste | opportunity",
      "metric": "LCP | TBT | CLS | INP | TTFB | FCP",
      "description": "string (human-readable finding)",
      "reasoning": {
        "observation": "string",
        "diagnosis": "string",
        "mechanism": "string",
        "solution": "string"
      },
      "evidence": {
        "source": "string (data source)",
        "reference": "string (specific data point)",
        "confidence": number (0-1)
      },
      "estimatedImpact": {
        "metric": "string",
        "reduction": number,
        "confidence": number (0-1)
      },
      "rootCause": boolean
    }
  ]
}
\`\`\``
    );

    // Header partial
    this.engine.registerPartial(
      'header',
      `You are a specialized {{agentName}} analyzing {{dataSource}} for {{cms}} on {{deviceType}}.

## Your Expertise
{{expertise}}`
    );

    // Footer partial
    this.engine.registerPartial(
      'footer',
      `## Critical Requirements
- Output valid JSON only (no markdown, no commentary)
- Include reasoning for every finding
- Be specific with evidence (file:line, sizes, timings)
- Distinguish root causes from symptoms
- Estimate realistic impacts with confidence scores`
    );
  }

  /**
   * Register a template
   * @param {string} name - Template name
   * @param {string} template - Template string
   * @param {string} version - Version identifier
   */
  registerTemplate(name, template, version = 'v1') {
    const key = `${name}:${version}`;
    this.templates.set(key, template);

    // Track versions
    if (!this.versions.has(name)) {
      this.versions.set(name, []);
    }
    if (!this.versions.get(name).includes(version)) {
      this.versions.get(name).push(version);
    }
  }

  /**
   * Register examples for a template
   * @param {string} templateName - Template name
   * @param {Array} examples - Array of example objects
   */
  registerExamples(templateName, examples) {
    this.examples.set(templateName, examples);
  }

  /**
   * Get template by name and version
   * @param {string} name - Template name
   * @param {string} version - Version identifier
   * @returns {string|null} Template string or null
   */
  getTemplate(name, version = 'v1') {
    const key = `${name}:${version}`;
    return this.templates.get(key) || null;
  }

  /**
   * Get examples for a template
   * @param {string} templateName - Template name
   * @param {Object} context - Context to filter examples
   * @returns {Array} Filtered examples
   */
  getExamples(templateName, context = {}) {
    const allExamples = this.examples.get(templateName) || [];

    // If no context provided, return all
    if (Object.keys(context).length === 0) {
      return allExamples;
    }

    // Filter examples based on context
    return allExamples.filter(example => {
      // Match by CMS
      if (context.cms && example.cms && example.cms !== context.cms) {
        return false;
      }

      // Match by metric
      if (context.metric && example.metric && example.metric !== context.metric) {
        return false;
      }

      // Match by has rich data
      if (context.hasRichData !== undefined && example.hasRichData !== context.hasRichData) {
        return false;
      }

      return true;
    });
  }

  /**
   * Build prompt from template
   * @param {string} templateName - Template name
   * @param {Object} context - Context variables
   * @param {Object} options - Build options
   * @returns {string} Rendered prompt
   */
  buildPrompt(templateName, context, options = {}) {
    const version = options.version || 'v1';
    const maxExamples = options.maxExamples || 3;

    // Get template
    const template = this.getTemplate(templateName, version);
    if (!template) {
      throw new Error(`Template '${templateName}:${version}' not found`);
    }

    // Get relevant examples
    const examples = this.getExamples(templateName, context).slice(0, maxExamples);

    // Build full context
    const fullContext = {
      ...context,
      examples,
      exampleCount: examples.length,
    };

    // Render template
    return this.engine.render(template, fullContext);
  }

  /**
   * List available templates
   * @returns {Array<Object>} Template info
   */
  listTemplates() {
    const result = [];

    for (const [name, versions] of this.versions.entries()) {
      result.push({
        name,
        versions,
        exampleCount: (this.examples.get(name) || []).length,
      });
    }

    return result;
  }

  /**
   * A/B test two template versions
   * @param {string} templateName - Template name
   * @param {string} versionA - First version
   * @param {string} versionB - Second version
   * @param {Object} context - Context variables
   * @returns {Object} Both rendered prompts
   */
  abTest(templateName, versionA, versionB, context) {
    return {
      versionA: this.buildPrompt(templateName, context, { version: versionA }),
      versionB: this.buildPrompt(templateName, context, { version: versionB }),
    };
  }
}

// Export singleton instance
export const promptManager = new PromptTemplateManager();
