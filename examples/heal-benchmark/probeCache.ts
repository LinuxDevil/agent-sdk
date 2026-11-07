import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

function readCached(file: string): ProbeRun | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ProbeRun;
  } catch {
    return undefined;
  }
}

function writeCached(dir: string, file: string, run: ProbeRun): void {
  mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(run));
  renameSync(temp, file);
}

export function cachedProbe(probe: ImproveOptions['probe'], options: { dir: string; model: string; salt: string; counts: ProbeCounts; distinct?: boolean }): ImproveOptions['probe'] {
  const { dir, model, salt, counts, distinct = false } = options;
  const seen = new Map<string, number>();
  return async (harness, caseId, repeat) => {
    counts.planned += 1;
    const first = cacheKey({ model, salt, caseId, repeat, harness });
    const nth = seen.get(first) ?? 0;
    seen.set(first, nth + 1);
    const key = distinct && nth > 0 ? cacheKey({ model, salt: `${salt}#${nth}`, caseId, repeat, harness }) : first;
    const file = path.join(dir, `${key}.json`);
    const hit = readCached(file);
    if (hit) {
      counts.cached += 1;
      return hit;
    }
    const run = await probe(harness, caseId, repeat);
    counts.run += 1;
    if (run.passed === null) {
      counts.excluded += 1;
      return run;
    }
    writeCached(dir, file, run);
    return run;
  };
}
