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
🚀 Fast CWV Analysis Runner

Usage: node run-fast-analysis.js [options]

Options:
  --url <url>        URL to analyze (default: https://www.krisshop.com/en/store/newarrivals)
  --device <device>  Device type: desktop or mobile (default: desktop)
  --help, -h         Show this help message

Examples:
  node run-fast-analysis.js --url https://www.krisshop.com --device mobile
  node run-fast-analysis.js --url https://www.krisshop.com/en/store/preorder --device desktop
            `);
            process.exit(0);
            break;
    }
}

console.log('🚀 Starting FAST CWV analysis...');
console.log(`📊 Target URL: ${url}`);
console.log(`📊 Device: ${device}`);
console.log('📊 Using gemini-1.5-flash with reduced token limits');

// Run the analysis with the faster model
const child = spawn('node', ['index.js', '--action', 'prompt', '--url', url, '--device', device, '--model', 'gemini-1.5-flash'], {
    stdio: 'inherit',
    cwd: __dirname
});

// Set a timeout to prevent infinite hanging
const timeout = setTimeout(() => {
    console.log('⏰ Analysis timeout reached (15 minutes). Terminating process...');
    child.kill('SIGTERM');
    process.exit(1);
}, 15 * 60 * 1000); // 15 minutes

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
