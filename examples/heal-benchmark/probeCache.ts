import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Harness, ImproveOptions, ProbeRun } from 'lousho/improve';

export interface ProbeCounts {
  planned: number;
  run: number;
  cached: number;
  excluded: number;
}

export const emptyCounts = (): ProbeCounts => ({ planned: 0, run: 0, cached: 0, excluded: 0 });

export function cacheKey(parts: { model: string; salt: string; caseId: string; repeat: number; harness: Harness }): string {
  const { model, salt, caseId, repeat, harness } = parts;
  const skills = Object.entries(harness.skills).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256')
    .update(JSON.stringify([model, salt, caseId, repeat, harness.instructions, skills]))
    .digest('hex');
}

export function cachedProbe(probe: ImproveOptions['probe'], options: { dir: string; model: string; salt: string; counts: ProbeCounts }): ImproveOptions['probe'] {
  const { dir, model, salt, counts } = options;
  return async (harness, caseId, repeat) => {
    counts.planned += 1;
    const file = path.join(dir, `${cacheKey({ model, salt, caseId, repeat, harness })}.json`);
    if (existsSync(file)) {
      counts.cached += 1;
      return JSON.parse(readFileSync(file, 'utf8')) as ProbeRun;
    }
    const run = await probe(harness, caseId, repeat);
    counts.run += 1;
    if (run.passed === null) {
      counts.excluded += 1;
      return run;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(run));
    return run;
  };
}
