let stepCounter = 0;

export function resetStepCounter() {
  stepCounter = 0;
}

function getNextStep() {
  return ++stepCounter;
}

export function initializeAccessibilitySystem() {
  return `You are an expert accessibility engineer and developer specializing in web accessibility compliance and source code analysis. Your role is to:

1. **Analyze rendered HTML** for accessibility issues according to WCAG 2.1 AA standards
2. **Analyze source code** (HTL/Sightly templates, JavaScript, CSS) to understand how accessibility issues originate
3. **Create PR-ready code changes** that fix accessibility issues at the source level
4. **Map DOM issues to source files** to provide precise, actionable fixes

## Key Capabilities:
- WCAG 2.1 AA compliance expertise
- HTL/Sightly template development (Adobe Experience Manager)
- JavaScript accessibility patterns
- CSS accessibility best practices
- ARIA implementation
- Keyboard navigation patterns
- Screen reader compatibility
- Focus management
- Color contrast and visual accessibility

## Analysis Approach:
1. Identify accessibility issues in the rendered HTML
2. Trace issues back to their source code origins
3. Provide complete, production-ready code fixes
4. Ensure fixes follow AEM/HTL best practices
5. Consider component reusability and maintainability

## Output Requirements:
- **Complete code blocks** (never use "..." or placeholders)
- **File-specific changes** with exact file paths
- **Before/After code comparisons**
- **Explanation of each fix**
- **Testing recommendations**

You will analyze both the rendered HTML and the source code to create comprehensive, PR-ready accessibility improvements.`;
}

export function htmlAnalysisStep(pageUrl, fullHtml) {
  const step = getNextStep();
  return `## Step ${step}: HTML Accessibility Analysis

**Page URL:** ${pageUrl}

**Task:** Analyze the rendered HTML for accessibility issues according to WCAG 2.1 AA standards.

**HTML Content:**
\`\`\`html
${fullHtml}
\`\`\`

Please identify all accessibility issues in this HTML, focusing on:
- Missing or incorrect ARIA attributes
- Semantic HTML structure problems
- Form accessibility issues
- Image alt text problems
- Heading hierarchy issues
- Keyboard navigation barriers
- Focus management problems
- Color contrast issues (where detectable)
- Screen reader compatibility issues

For each issue found, note the specific HTML elements and their line numbers/selectors for later mapping to source code.`;
}

export function sourceCodeAnalysisStep(pageUrl, sourceFiles) {
  const step = getNextStep();
  const fileList = Object.keys(sourceFiles);
  
  let sourceContent = '';
  Object.entries(sourceFiles).forEach(([filePath, content]) => {
    sourceContent += `\n### File: ${filePath}\n\`\`\`\n${content}\n\`\`\`\n`;
  });

  return `## Step ${step}: Source Code Analysis

**Page URL:** ${pageUrl}

**Task:** Analyze the source code files to understand how the HTML is generated and identify where accessibility fixes need to be applied.

**Source Files Found:** ${fileList.length} files
${fileList.map(f => `- ${f}`).join('\n')}

**Source Code Content:**
${sourceContent}

Please analyze these source files to:
1. **Map HTML issues to source code** - Identify which source files generate the problematic HTML elements
2. **Understand component structure** - How templates, JS, and CSS work together
3. **Identify fix points** - Exact locations where changes need to be made
4. **Consider dependencies** - How changes might affect other components
5. **Plan comprehensive fixes** - Address root causes, not just symptoms

Focus on HTL/Sightly templates (.html), JavaScript files (.js), and CSS files (.css) that contribute to accessibility issues.`;
}

export function accessibilityPrompt(pageUrl, deviceType) {
  const step = getNextStep();
  return `## Step ${step}: Generate PR-Ready Accessibility Fixes

**Page URL:** ${pageUrl}
**Device Type:** ${deviceType}

**Task:** Based on your analysis of both the rendered HTML and source code, create comprehensive, PR-ready code changes that fix all identified accessibility issues.

## Required Output Format:

### 1. Executive Summary
- Total issues found
- Severity breakdown (Critical/High/Medium/Low)
- Files that need changes

### 2. Detailed Fixes
For each accessibility issue, provide:

#### Issue: [Brief description]
**Severity:** Critical/High/Medium/Low
**WCAG Guideline:** [e.g., 1.1.1, 2.1.1, etc.]
**Affected HTML:** [Specific elements/selectors]
**Root Cause:** [Which source file(s) cause this issue]

**Fix Required:**
\`\`\`[file-extension]
// File: [exact-file-path]
// BEFORE:
[complete original code block]

// AFTER:
[complete fixed code block with all changes]
\`\`\`

**Explanation:** [Why this fix works and how it improves accessibility]

### 3. Testing Recommendations
- Manual testing steps
- Automated testing suggestions
- Screen reader testing guidance
- Keyboard navigation verification

### 4. Implementation Notes
- Any dependencies or prerequisites
- Potential side effects to watch for
- Additional considerations for AEM/HTL development

## Critical Requirements:
- **NEVER use "..." or placeholders** - Always provide complete code blocks
- **Include all attributes and children** in code examples
- **Specify exact file paths** for each change
- **Provide working, production-ready code**
- **Follow AEM/HTL best practices**
- **Consider component reusability**

Generate comprehensive fixes that address all accessibility issues found in both the HTML analysis and source code analysis steps.`;
} 