#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
let url = 'https://www.krisshop.com/en/store/newarrivals';
let device = 'desktop';

// Parse arguments
for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
        case '--url':
            url = args[i + 1];
            i++;
            break;
        case '--device':
            device = args[i + 1];
            i++;
            break;
        case '--help':
        case '-h':
            console.log(`
🚀 Ultra-Minimal CWV Analysis Runner

Usage: node run-ultra-minimal.js [options]

This script uses ONLY CrUX data to avoid any token issues.

Options:
  --url <url>        URL to analyze (default: https://www.krisshop.com/en/store/newarrivals)
  --device <device>  Device type: desktop or mobile (default: desktop)
  --help, -h         Show this help message

Examples:
  node run-ultra-minimal.js --url https://www.krisshop.com --device mobile
  node run-ultra-minimal.js --url https://www.krisshop.com/en/store/preorder --device desktop
            `);
            process.exit(0);
            break;
    }
}

console.log('🚀 Starting ULTRA-MINIMAL CWV analysis...');
console.log(`📊 Target URL: ${url}`);
console.log(`📊 Device: ${device}`);
console.log('📊 Using ONLY CrUX data (fastest possible)');

// Set environment variables to skip everything except CrUX
const env = {
    ...process.env,
    // Skip everything except CrUX
    SKIP_COVERAGE_ANALYSIS: 'true',
    SKIP_FULL_HTML: 'true',
    SKIP_PERFORMANCE_ENTRIES: 'true',
    SKIP_CODE_ANALYSIS: 'true',
    SKIP_HAR_ANALYSIS: 'true',
    SKIP_PSI_ANALYSIS: 'true',
    SKIP_RULES_ANALYSIS: 'true',
    // Use minimal token limits
    MAX_TOKENS_PER_CHUNK: '1000',
    MAX_TOTAL_TOKENS: '10000',
    // Use working model
    MODEL_NAME: 'gemini-2.5-pro'
};

// Run the analysis with ultra-minimal data collection
const child = spawn('node', ['index.js', '--action', 'prompt', '--url', url, '--device', device, '--model', 'gemini-2.5-pro'], {
    stdio: 'inherit',
    env: env,
    cwd: __dirname
});

// Set a very short timeout
const timeout = setTimeout(() => {
    console.log('⏰ Analysis timeout reached (2 minutes). Terminating process...');
    child.kill('SIGTERM');
    process.exit(1);
}, 2 * 60 * 1000); // 2 minutes

child.on('close', (code) => {
    clearTimeout(timeout);
    if (code === 0) {
        console.log('✅ Analysis completed successfully');
    } else {
        console.log(`❌ Analysis failed with code ${code}`);
    }
    process.exit(code);
});

child.on('error', (err) => {
    clearTimeout(timeout);
    console.error('❌ Error running analysis:', err);
    process.exit(1);
});

// Handle process termination
process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, terminating analysis...');
    child.kill('SIGTERM');
    clearTimeout(timeout);
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, terminating analysis...');
    child.kill('SIGTERM');
    clearTimeout(timeout);
    process.exit(0);
});
