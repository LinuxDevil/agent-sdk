/**
 * LOU-D45: Forge's FileCheckpointStore keeps the same bounded history ring
 * as the SDK's stores - the SDK's own history contract suite, run against it.
 */
import { afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileCheckpointStore } from '../checkpointStore';
import { describeCheckpointHistoryContract } from '../../../../src/execution/__fixtures__/checkpointHistoryContract';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describeCheckpointHistoryContract('FileCheckpointStore (Agent Forge)', (options) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d45-store-'));
  dirs.push(dir);
  return new FileCheckpointStore(dir, options);
});
