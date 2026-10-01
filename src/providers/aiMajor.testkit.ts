/**
 * Test helper (LOU-D28b): which major of `ai` is installed as `ai`, and
 * `describe`/`it` gates for tests that only make sense on one of them.
 * Read from the package manifest, not from `isModernAi`, so a test can check
 * the compat layer's detection against an independent source.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

function readInstalledMajor(): number {
  const manifest = join(process.cwd(), 'node_modules', 'ai', 'package.json');
  return Number.parseInt((JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version, 10);
}

/** The installed `ai` major (4 on the default install, 7 on the ai-7 CI job). */
export const installedAiMajor = readInstalledMajor();

/** `describe` that runs only when `ai` v4 is installed; the other majors skip it. */
export const describeOnAiV4 = describe.skipIf(installedAiMajor !== 4);

/** `it` that runs only when `ai` v4 is installed; the other majors skip it. */
export const itOnAiV4 = it.skipIf(installedAiMajor !== 4);
