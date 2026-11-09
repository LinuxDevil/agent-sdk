import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startObserveDaemon } from '../../src/observe/daemon';
import { ingestBatch, openDb } from '../../src/observe/store';
import type { SqlDatabase } from 'lousho/improve';
import { AGENT_MODEL, assertSynthetic, EDITOR_MODEL, LOOP_PREFIX, openKit, syntheticOnly, type LoopEnv } from './loopRuntime';
import { runAttempt, SCENARIOS, type LoopRow, type ScenarioId } from './loopScenarios';

let root: string;
let db: SqlDatabase;
let close: () => Promise<void>;
let env: LoopEnv;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'heal-loop-'));
  const file = path.join(root, 'observe.db');
  const daemon = await startObserveDaemon({ dbPath: file, port: 0, sweepIntervalMs: 0, retentionDays: 0 });
  close = () => daemon.close();
  db = openDb(file);
  env = { live: false, run: 'offline', db, collectorUrl: `http://127.0.0.1:${daemon.port}`, workDir: path.join(root, 'work'), runId: 'test', intervalMs: 200, agentModel: AGENT_MODEL, editorModel: EDITOR_MODEL, gapMs: 0 };
});

afterAll(async () => {
  db.close();
  await close();
  rmSync(root, { recursive: true, force: true });
});

const scenario = (id: ScenarioId) => {
  const found = SCENARIOS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No scenario ${id}`);
  return found;
};

const attempt = (id: ScenarioId): Promise<LoopRow> => runAttempt(env, scenario(id), 0);

describe('the synthetic self-healing loop', () => {
  it('A true-fix: applied, guarded, and kept by the monitor after 20 post-apply runs', async () => {
    const row = await attempt('true-fix');
    expect(row.error).toBeUndefined();
    expect(row).toMatchObject({ passed: true, outcome: 'kept', applied: true, rolledBack: false, auditOk: true, checks: { kept: true, guardPassed: true } });
    expect(row.finalHash).not.toBe(row.baseHash);
    expect(row.passK['add-months']).toBe(1);
  });

  it('B planted-editor: a fix that carries a planted regression is rejected and nothing is applied', async () => {
    const row = await attempt('planted-editor');
    expect(row).toMatchObject({ status: 'ok', passed: true, outcome: 'keep-base', applied: false, auditOk: true });
    expect(row.finalHash).toBe(row.baseHash);
  });

  it('C planted-forced: the real applyProposal writes the planted harness and the corpus guard rolls it back to the base bytes', async () => {
    const row = await attempt('planted-forced');
    expect(row).toMatchObject({ status: 'ok', passed: true, applied: true, rolledBack: true, auditOk: true, checks: { admitted: 1, tick: 1 } });
    expect(row.finalHash).toBe(row.baseHash);
  });

  it('D no-op: an edit that changes nothing is not applied', async () => {
    const row = await attempt('no-op');
    expect(row).toMatchObject({ passed: true, applied: false, auditOk: true });
  });

  it('E injection: the planted rule reaches no harness, no pending proposal and no library entry', async () => {
    const row = await attempt('injection');
    expect(row).toMatchObject({ status: 'ok', passed: true, applied: false, checks: { harness: false, pending: false, library: false, libraryRefused: true } });
  });

  it('F healthy: no cycle runs past detect', async () => {
    const row = await attempt('healthy');
    expect(row).toMatchObject({ passed: true, outcome: 'idle', applied: false, checks: { pastDetect: false } });
  });

  it('G kill-switch: a stop file made mid-cycle stops it and no later tick starts a cycle', async () => {
    const row = await attempt('kill-switch');
    expect(row).toMatchObject({ passed: true, outcome: 'paused', applied: false, checks: { cyclesAfterStop: 0, laterPaused: true } });
  });

  it('H manual: the proposal waits, nothing is written, and a stale approve is refused', async () => {
    const row = await attempt('manual');
    expect(row).toMatchObject({ status: 'ok', passed: true, outcome: 'pending', applied: false, checks: { unchanged: true, staleRefused: true } });
    expect(row.finalHash).toBe(row.baseHash);
  });

  it('I canary-traffic: a candidate that brings a new failure class to live sessions is retired, not promoted', async () => {
    const row = await attempt('canary-traffic');
    expect(row).toMatchObject({ status: 'ok', passed: true, outcome: 'retired', applied: false });
    expect(row.checks.newClasses).toBeGreaterThan(0);
  });

  it('J budget: the second cycle is refused once the daily tokens are spent, over the cap by at most one run', async () => {
    const row = await attempt('budget');
    expect(row).toMatchObject({ passed: true, outcome: 'budget' });
    expect(row.checks.over).toBeLessThanOrEqual(row.checks.largestRun as number);
  });

  it('stable-monitor: an applied edit that changes nothing is kept, not rolled back', async () => {
    const row = await attempt('stable-monitor');
    expect(row).toMatchObject({ passed: true, outcome: 'kept', applied: true, rolledBack: false, auditOk: true, checks: { falseRollback: false } });
  });
}, 60_000);

describe('the synthetic-only rule for the editor', () => {
  it('refuses a live editor without the synthetic-only hook, and the hook runs the check before each editor call', () => {
    expect(() => openKit({ ...env, live: true }, 'guard', { live: 'agent+editor' })).toThrow(/synthetic-only hook/);
    expect(() => syntheticOnly(db, LOOP_PREFIX).preGenerate?.({} as never)).not.toThrow();
    expect(() => syntheticOnly(db, 'someone-else-').preGenerate?.({} as never)).toThrow(/outside this loop/);
  });

  it('passes the loop db and refuses a run from another agent or with an input that is not a fixture', () => {
    expect(() => assertSynthetic(db, LOOP_PREFIX)).not.toThrow();
    db.prepare("INSERT INTO agents (agent_id, name, first_seen, updated_at) VALUES ('real', 'support-bot', 0, 0)").run();
    expect(() => assertSynthetic(db, LOOP_PREFIX)).toThrow(/outside this loop/);
    db.prepare("DELETE FROM agents WHERE agent_id = 'real'").run();
    const loopAgent = String(db.prepare('SELECT agent_id FROM agents WHERE name IS NOT NULL LIMIT 1').get()?.agent_id);
    ingestBatch(db, [{ type: 'observation', data: { obs_id: 'o1', trace_id: 't1', agent_id: loopAgent, kind: 'span', name: 'invoke_agent x', start: 0, end: 1, status: 'ok', input: '"my real customer email"', attrs: {} } }]);
    expect(() => assertSynthetic(db, LOOP_PREFIX)).toThrow(/not a coding-agent fixture/);
  });
});
