#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const source = path.join(
  projectRoot,
  'node_modules',
  'web-vitals',
  'dist',
  'web-vitals.attribution.iife.js',
);
const destination = path.join(
  projectRoot,
  '.agents',
  'scripts',
  'vendor',
  'web-vitals.attribution.iife.js',
);

try {
  if (!fs.existsSync(source)) {
    throw new Error(
      `Missing ${path.relative(projectRoot, source)}. Run \`npm ci\` from the project root so web-vitals is installed.`,
    );
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  process.stdout.write(
    `copied ${path.relative(projectRoot, source)} -> ${path.relative(projectRoot, destination)}\n`,
  );
} catch (error) {
  process.stderr.write(`postinstall-web-vitals failed: ${error.message}\n`);
  process.exit(1);
}
