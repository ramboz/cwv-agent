import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import fs from 'fs';
import path from 'path';

/**
 * GitHub integration for creating PRs with accessibility fixes
 * Supports both GitHub Apps (recommended) and Personal Access Tokens
 */
export class GitHubIntegration {
  constructor(auth) {
    if (auth.type === 'app') {
      // Store GitHub App credentials for later use
      this.appId = auth.appId;
      this.privateKey = auth.privateKey;
      this.installationId = auth.installationId;
      this.authType = 'app';
      
      // GitHub App authentication
      if (auth.installationId) {
        this.octokit = new Octokit({
          baseUrl: process.env.GITHUB_API_URL || 'https://git.corp.adobe.com/api/v3',
          authStrategy: createAppAuth,
          auth: {
            appId: auth.appId,
            privateKey: auth.privateKey,
            installationId: auth.installationId,
          },
        });
      } else {
        // Will be initialized later when installation ID is detected
        this.octokit = null;
      }
    } else {
      // Personal Access Token authentication
      this.octokit = new Octokit({
        baseUrl: process.env.GITHUB_API_URL || 'https://git.corp.adobe.com/api/v3',
        auth: auth.token,
      });
      this.authType = 'token';
    }
  }

  /**
   * Get installation ID for a repository (GitHub Apps only)
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {number} Installation ID
   */
  async getInstallationId(owner, repo) {
    if (this.authType !== 'app') {
      throw new Error('Installation ID lookup only available for GitHub Apps');
    }

    try {
      const { data } = await this.octokit.rest.apps.getRepoInstallation({
        owner,
        repo,
      });
      return data.id;
    } catch (error) {
      throw new Error(`GitHub App not found on ${owner}/${repo}. Please check: 1) App is installed on this repo, 2) App ID is correct, 3) App has proper permissions.`);
    }
  }

  /**
   * Parse accessibility report and extract code changes
   * @param {string} reportContent - Markdown content of accessibility report
   * @returns {Array} Array of file changes
   */
  parseAccessibilityReport(reportContent) {
    const changes = [];
    const lines = reportContent.split('\n');
    
    console.log('Parsing accessibility report for code changes...');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Look for file path patterns in comments
      const filePathMatch = line.match(/^\/\/\s*File:\s*(.+)$/);
      if (filePathMatch) {
        const filePath = filePathMatch[1].trim();
        console.log(`Found file path: ${filePath}`);
        
        // Look for BEFORE/AFTER blocks following this file path
        const beforeAfterBlocks = this.extractBeforeAfterBlocks(lines, i);
        
        if (beforeAfterBlocks.after) {
          const description = this.extractChangeDescription(reportContent, i);
          
          changes.push({
            filePath: filePath,
            newContent: beforeAfterBlocks.after,
            beforeContent: beforeAfterBlocks.before || null,
            description: description,
            issueType: this.extractIssueType(reportContent, i)
          });
          
          console.log(`Extracted change for ${filePath}: ${description}`);
        }
      }
    }
    
    console.log(`Total changes extracted: ${changes.length}`);
    return changes;
  }

  /**
   * Extract BEFORE and AFTER code blocks following a file path
   * @param {Array} lines - All lines from the report
   * @param {number} startIndex - Starting index to search from
   * @returns {Object} Object with before and after code content
   */
  extractBeforeAfterBlocks(lines, startIndex) {
    let beforeContent = null;
    let afterContent = null;
    let currentSection = null;
    
    // Look ahead from the file path line
    for (let i = startIndex + 1; i < lines.length && i < startIndex + 100; i++) {
      const line = lines[i].trim();
      
      // Identify sections
      if (line.includes('// BEFORE:')) {
        currentSection = 'before';
        continue;
      } else if (line.includes('// AFTER:')) {
        currentSection = 'after';
        continue;
      }
      
      // Extract code blocks
      if (line.startsWith('```') && currentSection) {
        const codeLanguage = line.substring(3).trim();
        if (codeLanguage.match(/^(html|javascript|css|htl|js)$/)) {
          // Extract the code content
          const codeContent = this.extractCodeBlock(lines, i + 1);
          
          if (currentSection === 'before') {
            beforeContent = codeContent;
          } else if (currentSection === 'after') {
            afterContent = codeContent;
            // Stop after finding the AFTER block
            break;
          }
        }
      }
      
      // Stop if we hit another file path or major section
      if (line.match(/^\/\/\s*File:/) || line.startsWith('#### Issue')) {
        break;
      }
    }
    
    return { before: beforeContent, after: afterContent };
  }

  /**
   * Extract code content from a code block
   * @param {Array} lines - All lines from the report
   * @param {number} startIndex - Starting index of code content
   * @returns {string} Code content
   */
  extractCodeBlock(lines, startIndex) {
    const codeLines = [];
    
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.trim().startsWith('```')) {
        // End of code block
        break;
      }
      
      codeLines.push(line);
    }
    
    return codeLines.join('\n').trim();
  }

  /**
   * Extract the type of accessibility issue being fixed
   * @param {string} content - Full report content
   * @param {number} position - Position in content
   * @returns {string} Issue type
   */
  extractIssueType(content, position) {
    const lines = content.split('\n');
    
    // Look backwards for issue headers
    for (let i = position; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('#### Issue')) {
        return line.replace(/^#### Issue \d+:\s*/, '');
      }
      if (line.includes('Missing Page Language') || line.includes('Language of Page')) {
        return 'Missing Page Language';
      }
      if (line.includes('Vague Link Text') || line.includes('Link Purpose')) {
        return 'Vague Link Text';
      }
      if (line.includes('Non-Semantic') || line.includes('Info and Relationships')) {
        return 'Non-Semantic Elements';
      }
    }
    
    return 'Accessibility improvement';
  }

  /**
   * Extract description of the change from surrounding context
   * @param {string} content - Full report content
   * @param {number} position - Position in content
   * @returns {string} Change description
   */
  extractChangeDescription(content, position) {
    const lines = content.split('\n');
    
    // Look backwards for section headers or issue descriptions
    for (let i = position; i >= 0; i--) {
      const line = lines[i].trim();
      
      // Look for issue headers
      if (line.startsWith('#### Issue')) {
        return line.replace(/^#### Issue \d+:\s*/, '');
      }
      
      // Look for WCAG guidelines
      if (line.includes('WCAG Guideline:')) {
        const wcagMatch = line.match(/WCAG Guideline:\s*(.+)/);
        if (wcagMatch) {
          return `WCAG: ${wcagMatch[1]}`;
        }
      }
      
      // Look for severity indicators
      if (line.includes('Severity:')) {
        const severityMatch = line.match(/Severity:\s*(\w+)/);
        if (severityMatch) {
          return `${severityMatch[1]} severity accessibility fix`;
        }
      }
    }
    
    return 'Accessibility improvement';
  }

  /**
   * Create a new branch for accessibility fixes
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} baseBranch - Base branch (usually 'main' or 'master')
   * @returns {string} New branch name
   */
  async createAccessibilityBranch(owner, repo, baseBranch = 'main') {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    const branchName = `accessibility-fixes-${timestamp}`;
    
    // Get the latest commit SHA from base branch
    const { data: ref } = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });
    
    // Create new branch
    await this.octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: ref.object.sha,
    });
    
    return branchName;
  }

  /**
   * Apply code changes to repository files
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} branch - Target branch
   * @param {Array} changes - Array of file changes
   */
  async applyChanges(owner, repo, branch, changes) {
    const commits = [];
    
    for (const change of changes) {
      try {
        // Clean file path - remove leading slash if present
        const cleanPath = change.filePath.startsWith('/') ? change.filePath.substring(1) : change.filePath;
        
        // Get current file content (if it exists)
        let currentFile = null;
        try {
          const { data } = await this.octokit.rest.repos.getContent({
            owner,
            repo,
            path: cleanPath,
            ref: branch,
          });
          currentFile = data;
        } catch (error) {
          // File doesn't exist, will create new
          console.log(`File ${cleanPath} doesn't exist, will create new file`);
        }
        
        // Prepare file content
        const content = Buffer.from(change.newContent).toString('base64');
        
        // Update or create file
        const commitData = {
          owner,
          repo,
          path: cleanPath,
          message: `Fix accessibility: ${change.description}`,
          content,
          branch,
        };
        
        if (currentFile) {
          commitData.sha = currentFile.sha;
        }
        
        const { data: commit } = await this.octokit.rest.repos.createOrUpdateFileContents(commitData);
        commits.push(commit);
        
        console.log(`Applied accessibility fix to ${cleanPath}`);
        
      } catch (error) {
        console.error(`Failed to apply changes to ${cleanPath}:`, error.message);
      }
    }
    
    return commits;
  }

  /**
   * Create a pull request with accessibility fixes
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} branch - Source branch with changes
   * @param {string} baseBranch - Target branch (usually 'main')
   * @param {string} pageUrl - URL that was analyzed
   * @param {Array} changes - Array of changes made
   * @returns {Object} Created pull request
   */
  async createAccessibilityPR(owner, repo, branch, baseBranch, pageUrl, changes) {
    const title = `🔧 Accessibility fixes for ${new URL(pageUrl).hostname}`;
    
    const body = this.generatePRDescription(pageUrl, changes);
    
    const { data: pr } = await this.octokit.rest.pulls.create({
      owner,
      repo,
      title,
      head: branch,
      base: baseBranch,
      body,
    });
    
    // Add labels
    try {
      await this.octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: pr.number,
        labels: ['accessibility', 'automated-fix', 'wcag-compliance', 'cwv-agent'],
      });
    } catch (error) {
      console.log('Could not add labels (labels may not exist)');
    }
    
    // Add reviewers if configured
    const reviewers = process.env.GITHUB_DEFAULT_REVIEWERS?.split(',').map(r => r.trim()).filter(Boolean);
    if (reviewers && reviewers.length > 0) {
      try {
        await this.octokit.rest.pulls.requestReviewers({
          owner,
          repo,
          pull_number: pr.number,
          reviewers,
        });
      } catch (error) {
        console.log('Could not add reviewers:', error.message);
      }
    }
    
    return pr;
  }

  /**
   * Generate PR description from changes
   * @param {string} pageUrl - URL that was analyzed
   * @param {Array} changes - Array of changes
   * @returns {string} PR description in markdown
   */
  generatePRDescription(pageUrl, changes) {
    const changesList = changes.map(change => 
      `- **${change.filePath}**: ${change.description}`
    ).join('\n');
    
    const botSignature = this.authType === 'app' ? 
      '*🤖 Generated by CWV Agent Bot*' : 
      '*Generated by CWV Agent - Accessibility Analysis*';
    
    return `## 🔧 Accessibility Fixes

This PR contains automated accessibility fixes generated by the CWV Agent for: **${pageUrl}**

### 📋 Changes Made:
${changesList}

### ♿ WCAG Compliance:
These changes address WCAG 2.1 AA compliance issues including:
- Semantic HTML improvements
- ARIA implementation fixes  
- Keyboard navigation enhancements
- Form accessibility improvements
- Mobile accessibility considerations

### 🧪 Testing Checklist:
Please test these changes with:
- [ ] Manual keyboard navigation
- [ ] Screen reader testing (NVDA, JAWS, VoiceOver)
- [ ] Automated accessibility tools (axe, WAVE, Lighthouse)
- [ ] Mobile device testing
- [ ] Cross-browser compatibility

### 📚 Resources:
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [Accessibility Testing Guide](https://www.w3.org/WAI/test-evaluate/)

---
${botSignature}`;
  }

  /**
   * Complete workflow: analyze accessibility and create PR
   * @param {string} pageUrl - URL to analyze
   * @param {string} deviceType - Device type
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {Object} options - Additional options
   */
  async createAccessibilityPR_Complete(pageUrl, deviceType, owner, repo, options = {}) {
    const baseBranch = options.baseBranch || 'main';
    
    console.log(`Creating accessibility PR for ${pageUrl} in ${owner}/${repo}`);
    
    try {
      // For GitHub Apps, auto-detect installation ID if needed
      if (this.authType === 'app' && !this.installationId) {
        console.log('Auto-detecting installation ID...');
        
        // Create a temporary app-only client to detect installation ID
        const tempOctokit = new Octokit({
          baseUrl: process.env.GITHUB_API_URL || 'https://git.corp.adobe.com/api/v3',
          authStrategy: createAppAuth,
          auth: {
            appId: this.appId,
            privateKey: this.privateKey,
          },
        });
        
        try {
          const { data } = await tempOctokit.rest.apps.getRepoInstallation({
            owner,
            repo,
          });
          const installationId = data.id;
          console.log(`Found installation ID: ${installationId}`);
          
          // Create a new octokit instance with the detected installation ID
          this.octokit = new Octokit({
            baseUrl: process.env.GITHUB_API_URL || 'https://git.corp.adobe.com/api/v3',
            authStrategy: createAppAuth,
            auth: {
              appId: this.appId,
              privateKey: this.privateKey,
              installationId: installationId,
            },
          });
          this.installationId = installationId;
        } catch (error) {
          console.error('GitHub API Error:', error.message);
          throw new Error(`GitHub App not found on ${owner}/${repo}. Please check: 1) App is installed on this repo, 2) App ID is correct, 3) App has proper permissions.`);
        }
      }
      
      // 1. Create new branch
      const branch = await this.createAccessibilityBranch(owner, repo, baseBranch);
      console.log(`Created branch: ${branch}`);
      
      // 2. Get accessibility report (assume it exists)
      const reportPath = this.getAccessibilityReportPath(pageUrl, deviceType);
      if (!fs.existsSync(reportPath)) {
        throw new Error(`Accessibility report not found at ${reportPath}. Run accessibility analysis first.`);
      }
      
      const reportContent = fs.readFileSync(reportPath, 'utf8');
      
      // 3. Parse changes from report
      const changes = this.parseAccessibilityReport(reportContent);
      if (changes.length === 0) {
        console.log('No code changes found in accessibility report');
        return null;
      }
      
      console.log(`Found ${changes.length} accessibility fixes to apply`);
      
      // 4. Apply changes to repository
      await this.applyChanges(owner, repo, branch, changes);
      
      // 5. Create pull request
      const pr = await this.createAccessibilityPR(owner, repo, branch, baseBranch, pageUrl, changes);
      
      console.log(`Created PR #${pr.number}: ${pr.html_url}`);
      
      return {
        pr,
        branch,
        changes,
        url: pr.html_url,
        authType: this.authType
      };
      
    } catch (error) {
      console.error('Failed to create accessibility PR:', error.message);
      throw error;
    }
  }

  /**
   * Get the path to the accessibility report file
   * @param {string} pageUrl - Page URL
   * @param {string} deviceType - Device type
   * @returns {string} Report file path
   */
  getAccessibilityReportPath(pageUrl, deviceType) {
    const urlObj = new URL(pageUrl);
    const hostname = urlObj.hostname.replace(/\./g, '-');
    const pathname = urlObj.pathname.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const filename = `${hostname}${pathname ? '-' + pathname : ''}.${deviceType}.accessibility-report.gemini25pro.summary.md`;
    
    return path.join('.cache', filename);
  }
}

/**
 * Factory function to create GitHub integration with App authentication
 * @param {Object} appConfig - GitHub App configuration
 * @param {string} appConfig.appId - GitHub App ID
 * @param {string} appConfig.privateKey - GitHub App private key
 * @param {string} appConfig.installationId - Installation ID (optional, can be auto-detected)
 * @returns {GitHubIntegration} GitHub integration instance
 */
export function createGitHubApp(appConfig) {
  const { appId, privateKey, installationId } = appConfig;
  
  if (!appId || !privateKey) {
    throw new Error('GitHub App ID and private key are required');
  }
  
  // If no installation ID provided, we'll set it to null and detect it later
  return new GitHubIntegration({
    type: 'app',
    appId,
    privateKey,
    installationId: installationId || null,
  });
}

/**
 * Factory function to create GitHub integration with Personal Access Token
 * @param {string} token - GitHub personal access token
 * @returns {GitHubIntegration} GitHub integration instance
 */
export function createGitHubIntegration(token) {
  if (!token) {
    throw new Error('GitHub token is required. Set GITHUB_TOKEN environment variable.');
  }
  
  return new GitHubIntegration({
    type: 'token',
    token,
  });
}

/**
 * Factory function that auto-detects authentication method
 * @returns {GitHubIntegration} GitHub integration instance
 */
export function createGitHubClient() {
  // Try GitHub App first (preferred method)
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  
  if (appId && privateKey) {
    console.log('Using GitHub App authentication');
    return createGitHubApp({ appId, privateKey, installationId });
  }
  
  // Fallback to Personal Access Token
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    console.log('Using Personal Access Token authentication');
    return createGitHubIntegration(token);
  }
  
  throw new Error('No GitHub authentication found. Set either GITHUB_APP_* or GITHUB_TOKEN environment variables.');
} 