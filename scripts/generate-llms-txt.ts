/**
 * generate-llms-txt (LOU-D12)
 *
 * Generates `llms.txt` and `llms-full.txt` at the repo root from README.md,
 * the user-facing docs/*.md pages and examples/<name>/README.md. Both files
 * are generated, never hand-edited, and are shipped in the npm package so
 * coding agents can read them from node_modules.
 *
 * Usage:
 *   npx tsx scripts/generate-llms-txt.ts           write the files
 *   npx tsx scripts/generate-llms-txt.ts --check   exit 1 if they are stale
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isUserDoc, normalizeNewlines, renderLlmsFull, renderLlmsTxt } from './llmsTxt';
import type { DocPage, ExampleEntry, LlmsInput } from './llmsTxt';

const REPO_ROOT = path.resolve(__dirname, '..');

function readText(file: string): string {
  return normalizeNewlines(fs.readFileSync(file, 'utf8'));
}

function readDocs(): DocPage[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, 'docs'))
    .map((name) => `docs/${name}`)
    .filter(isUserDoc)
    .sort()
    .map((p) => ({ path: p, markdown: readText(path.join(REPO_ROOT, p)) }));
}

function readExamples(): ExampleEntry[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, 'examples'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(REPO_ROOT, 'examples', d.name, 'README.md')))
    .map((d) => ({
      dir: `examples/${d.name}`,
      readme: readText(path.join(REPO_ROOT, 'examples', d.name, 'README.md')),
    }));
}

function loadInput(): LlmsInput {
  const pkg = JSON.parse(readText(path.join(REPO_ROOT, 'package.json'))) as {
    name: string;
    repository: { url: string };
  };
  return {
    name: pkg.name,
    repositoryUrl: pkg.repository.url,
    readme: { path: 'README.md', markdown: readText(path.join(REPO_ROOT, 'README.md')) },
    docs: readDocs(),
    examples: readExamples(),
  };
}

function main(): void {
  const input = loadInput();
  const outputs: Record<string, string> = {
    'llms.txt': renderLlmsTxt(input),
    'llms-full.txt': renderLlmsFull(input),
  };
  if (process.argv.includes('--check')) {
    const stale = Object.entries(outputs).filter(([file, content]) => {
      const target = path.join(REPO_ROOT, file);
      return !fs.existsSync(target) || readText(target) !== content;
    });
    if (stale.length > 0) {
      console.error(`llms.txt is stale: run npm run docs:llms (out of date: ${stale.map(([f]) => f).join(', ')})`);
      process.exit(1);
    }
    return;
  }
  for (const [file, content] of Object.entries(outputs)) {
    fs.writeFileSync(path.join(REPO_ROOT, file), content);
  }
}

main();
