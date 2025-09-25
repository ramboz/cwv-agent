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
let action = 'prompt';

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
        case '--action':
            action = args[i + 1];
            i++;
            break;
        case '--help':
        case '-h':
            console.log(`
🚀 CWV Agent Analysis Runner with Token Limits

Usage: node run-analysis-optimized.js [options]

Options:
  --url <url>        URL to analyze (default: https://www.krisshop.com/en/store/newarrivals)
  --device <device>  Device type: desktop or mobile (default: desktop)
  --action <action>  Analysis action (default: prompt)
  --help, -h         Show this help message

Examples:
  node run-analysis-optimized.js --url https://www.krisshop.com --device mobile
  node run-analysis-optimized.js --url https://www.krisshop.com/en/store/preorder --device desktop
  node run-analysis-optimized.js --url https://example.com --device mobile --action prompt
            `);
            process.exit(0);
            break;
    }
}

console.log('🚀 Starting CWV Agent analysis with optimized settings...');
console.log(`📊 Target URL: ${url}`);
console.log(`📊 Device: ${device}`);
console.log(`📊 Action: ${action}`);

// Set environment variables to optimize performance and prevent hanging
const env = {
    ...process.env,
    // Reduce token limits to prevent hanging
    MAX_TOKENS_PER_CHUNK: '30000',
    MAX_TOTAL_TOKENS: '150000',
    SKIP_LARGE_FILES: 'true',
    CHUNK_SIZE_LIMIT: '500000',
    // Skip some heavy processing
    SKIP_COVERAGE_ANALYSIS: 'true',
    SKIP_FULL_HTML: 'true',
    // Use faster model to reduce processing time
    MODEL_NAME: 'gemini-1.5-flash',
    // Add timeout settings
    REQUEST_TIMEOUT: '300000', // 5 minutes
    MAX_RETRIES: '3'
};

console.log('📊 Configuration:');
console.log('  - Max tokens per chunk:', env.MAX_TOKENS_PER_CHUNK);
console.log('  - Max total tokens:', env.MAX_TOTAL_TOKENS);
console.log('  - Skip large files:', env.SKIP_LARGE_FILES);
console.log('  - Skip coverage analysis:', env.SKIP_COVERAGE_ANALYSIS);
console.log('  - Model:', env.MODEL_NAME);
console.log('  - Request timeout:', env.REQUEST_TIMEOUT);

// Find the main index.js file
const indexPath = path.join(__dirname, 'index.js');

console.log('📁 Using entry point:', indexPath);

// Run the analysis with the provided arguments
const child = spawn('node', [indexPath, '--action', action, '--url', url, '--device', device], {
    stdio: 'inherit',
    env: env,
    cwd: __dirname
});

// Set a timeout to prevent infinite hanging
const timeout = setTimeout(() => {
    console.log('⏰ Analysis timeout reached (25 minutes). Terminating process...');
    child.kill('SIGTERM');
    process.exit(1);
}, 25 * 60 * 1000); // 25 minutes

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
