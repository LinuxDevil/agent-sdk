/**
 * The one human-score write (LangSmith "Add feedback"): one `source: 'human'`
 * score row on a trace, through ingest so rollups and the scores table see it
 * like any other score. `POST /api/v1/scores` and the annotation-queue
 * complete route both write through here.
 */

import { randomUUID } from 'node:crypto';

import type { SqlDatabase } from '../storage/sqlite/driver';
import { ingestBatch } from './store';

/** What a human score says about a trace (or one observation in it). */
export interface HumanScoreInput {
  trace_id: string;
  obs_id?: string;
  name: string;
  value: number | null;
  comment?: string;
}

/** Thrown by {@link writeHumanScore} when the trace (or the observation in it) does not exist; routes answer 404. */
export class ScoreTargetMissingError extends Error {
  override readonly name = 'ScoreTargetMissingError';
}

/**
 * Append one human score and return its `score_id`. The row's `agent_id` is
 * the trace root's. Throws {@link ScoreTargetMissingError} for an unknown
 * trace or an `obs_id` outside it. Joins an open `transaction()`.
 */
export function writeHumanScore(db: SqlDatabase, input: HumanScoreInput, now: number = Date.now()): string {
  const root = db
    .prepare('SELECT agent_id FROM observations WHERE trace_id = ? ORDER BY parent_obs_id IS NULL DESC LIMIT 1')
    .get(input.trace_id);
  if (root === undefined) throw new ScoreTargetMissingError(`No trace '${input.trace_id}'.`);
  if (input.obs_id !== undefined) {
    const inTrace = db.prepare('SELECT 1 AS ok FROM observations WHERE obs_id = ? AND trace_id = ?').get(input.obs_id, input.trace_id);
    if (inTrace === undefined) {
      throw new ScoreTargetMissingError(`No observation '${input.obs_id}' in trace '${input.trace_id}'.`);
    }
  }
  const score_id = randomUUID();
  ingestBatch(
    db,
    [
      {
        type: 'score',
        data: {
          score_id,
          trace_id: input.trace_id,
          obs_id: input.obs_id,
          name: input.name,
          value: input.value ?? undefined,
          source: 'human',
          comment: input.comment,
          agent_id: typeof root.agent_id === 'string' ? root.agent_id : undefined,
        },
      },
    ],
    now
  );
  return score_id;
}
