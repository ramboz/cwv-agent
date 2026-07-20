// ESLint flat config — codifies the house style ratified in
// docs/decisions/adr-0019-code-style-and-linting.md.
//
// Style: ESM, 2-space indent, semicolons, single quotes, trailing commas in
// multi-line literals, const/let (no var), node:-prefixed builtins.
// Run: `npm run lint` (report) / `npm run lint:fix` (autofix the mechanical rules).

import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

// Common Node builtins that must be imported with the `node:` prefix
// (ADR-0019 drift point 1). Bare `import fs from 'fs'` is rejected in favor of
// `import fs from 'node:fs'`.
const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'querystring',
  'readline',
  'stream',
  'string_decoder',
  'test',
  'timers',
  'tls',
  'url',
  'util',
  'zlib',
];

export default [
  {
    // Generated artifacts, vendored code, and run output are not house source.
    ignores: [
      'node_modules/**',
      'progress/**',
      'docs/**',
      '.agents/scripts/vendor/**',
      '**/*.min.js',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Node runtime globals + browser globals (analyzers run code inside
      // Puppeteer `page.evaluate(...)` callbacks that reference document/window).
      // `webVitals` is the in-page global exposed by the vendored web-vitals IIFE.
      globals: { ...globals.node, ...globals.browser, webVitals: 'readonly' },
    },
    rules: {
      // Correctness overlays on top of @eslint/js recommended.
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Formatting — codifies the observed style (@stylistic is the maintained
      // successor to ESLint core's removed stylistic rules).
      '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],

      // Drift point 1 — enforce the `node:` prefix on builtins going forward.
      'no-restricted-imports': ['error', {
        paths: NODE_BUILTINS.map((name) => ({
          name,
          message: `Import Node builtins with the "node:" prefix (use "node:${name}").`,
        })),
      }],
    },
  },
];
