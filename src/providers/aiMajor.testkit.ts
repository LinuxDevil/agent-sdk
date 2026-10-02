/**
 * Test helper (LOU-D28b): which major of `ai` is installed as `ai`, and
 * an `it` gate for tests that only make sense on one of them.
 * Read from the package manifest, not from `isModernAi`, so a test can check
 * the compat layer's detection against an independent source.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { it } from 'vitest';

function readInstalledMajor(): number {
  const manifest = join(process.cwd(), 'node_modules', 'ai', 'package.json');
  return Number.parseInt((JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version, 10);
}

/** The installed `ai` major (4 on the default install, 7 on the ai-7 CI job). */
export const installedAiMajor = readInstalledMajor();

/** `it` that runs only when `ai` v4 is installed; the other majors skip it. */
export const itOnAiV4: ReturnType<typeof it.skipIf> = it.skipIf(installedAiMajor !== 4);

/**
 * Whether `ollama-ai-provider-v2` resolves from the repository (LOU-M8). It is an optional peer and
 * needs zod 4, so only the `ai6-zod4` and `ai7-zod4` CI jobs install it; everywhere else tests that
 * need an Ollama model on `ai` 6/7 use a stand-in.
 */
export const ollamaV2Installed: boolean = (() => {
  try {
    createRequire(join(process.cwd(), 'package.json')).resolve('ollama-ai-provider-v2');
    return true;
  } catch {
    return false;
  }
})();
