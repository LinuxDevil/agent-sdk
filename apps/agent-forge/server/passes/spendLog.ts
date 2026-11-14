/**
 * The pass spend log - one append-only JSONL file of `PassRecord`s.
 *
 * Every settled background pass (summaries, reviews, portability checks,
 * suggestions, eval judges - see passRunner.ts) writes exactly one line
 * here, so Studio can answer "what did the passes cost this month" without
 * a database. The file is an accounting record: lines are only ever
 * appended, never rewritten or truncated.
 *
 * The path is a `studioPaths().spend` file (workspace/studioPaths.ts) -
 * spend is Studio-global, not per-workspace, so `PassJob`/`PassRecord`
 * carry `workspaceId` to name the workspace a pass ran for.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { PassSpendSummary } from '../../shared/wireTypes';
import type { PassRecord } from './passRunner';

export type { PassSpendSummary };

/**
 * Appends `PassRecord`s to `<file>` and reads them back. Appends are
 * serialized through an in-process promise chain so two settles racing
 * each other still land as two whole lines (each `appendFile` writes one
 * `JSON.stringify` + `\n` in a single call).
 */
export class SpendLog {
  private readonly file: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  /** Queues one record's line behind every earlier append; resolves once it is on disk. */
  append(record: PassRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const write = this.tail.then(() => this.appendLine(line));
    // A failed append must not poison the chain for later records.
    this.tail = write.then(
      () => undefined,
      () => undefined
    );
    return write;
  }

  private async appendLine(line: string): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, line);
  }

  /**
   * Every parseable record, oldest first. `month` (`'YYYY-MM'`) keeps only
   * records whose `at` falls in that month; corrupt lines are skipped.
   * A missing file reads as empty.
   */
  async read(month?: string): Promise<PassRecord[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: PassRecord[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const record = JSON.parse(trimmed) as PassRecord;
        if (month === undefined || (typeof record.at === 'string' && record.at.startsWith(month))) {
          records.push(record);
        }
      } catch {
        // A torn or hand-edited line is skipped, not fatal: the rest of
        // the accounting record still reads.
      }
    }
    return records;
  }
}

/**
 * Rolls `records` up for `month`: `calls` counts every record (a `null`
 * `costUsd` counts as 0 toward `totalUsd` and the kind's `costUsd`), and
 * `byKind` breaks calls and spend out per pass kind.
 */
export function summarizeSpend(records: PassRecord[], month: string): PassSpendSummary {
  const summary: PassSpendSummary = { month, totalUsd: 0, calls: records.length, byKind: {} };
  for (const record of records) {
    const cost = record.costUsd ?? 0;
    summary.totalUsd += cost;
    const kind = (summary.byKind[record.kind] ??= { calls: 0, costUsd: 0 });
    kind.calls += 1;
    kind.costUsd += cost;
  }
  return summary;
}
