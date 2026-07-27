#!/usr/bin/env node

/**
 * plugin-sync.js — regenerate the Claude Code plugin skill layout
 * (`skills/<name>/SKILL.md`) from the canonical skills in `.agents/skills/`.
 *
 * `.agents/skills/*.md` is the single source of truth (also read directly by
 * AGENTS.md-driven CLIs). This script wraps each one in the SKILL.md front
 * matter the Claude Code plugin loader expects, so the two layouts never
 * drift: edit `.agents/skills/`, run `npm run plugin:sync`, commit both.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, '.agents', 'skills');
const DEST = path.join(ROOT, 'skills');

/** First sentence of the "## Purpose" section, flattened to one line. */
function extractDescription(body) {
  const m = body.match(/## Purpose\s*\n([\s\S]*?)(?:\n##|\n$)/);
  if (!m) return '';
  const text = m[1].replace(/\s+/g, ' ').trim();
  const sentence = text.match(/^.*?[.!?](?:\s|$)/);
  return (sentence ? sentence[0] : text).trim();
}

function main() {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.md')).sort();
  for (const f of files) {
    const name = f.replace(/\.md$/, '');
    const body = fs.readFileSync(path.join(SRC, f), 'utf8');
    const description = extractDescription(body).replace(/"/g, "'");
    const out = [
      '---',
      `name: ${name}`,
      `description: "${description}"`,
      '---',
      '',
      '<!-- Generated from .agents/skills/' + f + ' by plugin-sync.js — edit there, then `npm run plugin:sync`. -->',
      '',
      body.trimEnd(),
      '',
    ].join('\n');
    const dir = path.join(DEST, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), out, 'utf8');
    process.stdout.write(`skills/${name}/SKILL.md\n`);
  }
}

main();
