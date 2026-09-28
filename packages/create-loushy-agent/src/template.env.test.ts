/**
 * LOU-H5: provider/env-var wiring test. Scaffolds two projects with
 * different --provider flags into separate temp dirs and greps each
 * generated .env.example for the expected exact var name (matching
 * LOU-F8's resolveProvider() env table: OPENAI_API_KEY, ANTHROPIC_API_KEY,
 * OLLAMA_BASE_URL).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_ENV_VARS } from './template';

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('provider env-var wiring', () => {
  it.each([
    ['openai', 'OPENAI_API_KEY'],
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['ollama', 'OLLAMA_BASE_URL'],
  ])('writes %s -> %s into .env.example', (provider, envVar) => {
    expect(PROVIDER_ENV_VARS[provider]).toBe(envVar);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `create-loushy-agent-env-${provider}-`));
    tempDirs.push(dir);
    const projectDir = path.join(dir, 'proj');

    execFileSync(
      process.execPath,
      [CLI, `--name=proj`, `--provider=${provider}`, '--yes', `--dir=${projectDir}`],
      { encoding: 'utf8' }
    );

    const envExample = fs.readFileSync(path.join(projectDir, '.env.example'), 'utf8');
    expect(envExample).toMatch(new RegExp(`^${envVar}=`, 'm'));
  });
});
