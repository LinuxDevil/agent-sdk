/**
 * N9b: a full sign-in (pause, callback, resume) over a `SqliteStore`, traced
 * through OpenTelemetry (in-memory exporter) and recorded with `recordReplay`,
 * leaves the access token, the refresh token, the authorization code and the
 * PKCE verifier in no emitted event, session transcript, checkpoint row,
 * approval row, span attribute or cassette. A tool that returns the token has
 * it replaced with `[REDACTED]`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { createAgent } from '../createAgent';
import { mockModel, recordReplay } from '../testing';
import { SqliteStore } from '../storage/sqlite';
import { loadDatabaseSync } from '../storage/sqlite/driver';
import { createOtelTraceExporter } from '../execution/otel';
import type { AgentEvent } from '../execution/agentEvents';
import { generateTokenKey } from './tokenCipher';
import { ALICE, fakeOAuthServer, githubProvider, listReposTool } from './__fixtures__/fakeOAuth';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every row of every table except the encrypted OAuth ones, as JSON per table. */
function dumpTables(file: string): Record<string, string> {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(file);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name));
    return Object.fromEntries(tables.filter((name) => !name.startsWith('oauth_')).map((name) => [name, JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())]));
  } finally {
    db.close();
  }
}

describe('sign-in secret hygiene (N9b)', () => {
  it('no token, code or verifier in events, transcript, checkpoints, approvals, spans or the cassette; a returned token is redacted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-signin-hygiene-'));
    dirs.push(dir);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new SqliteStore(join(dir, 'agent.db'), { tokenKey: generateTokenKey() });
    const spans = new InMemorySpanExporter();
    const tracer = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }).getTracer('test');
    const cassette = join(dir, 'cassette.json');
    const events: AgentEvent[] = [];
    const server = fakeOAuthServer();
    const { tool, executions } = listReposTool(githubProvider(server), { returnToken: true });
    const agent = createAgent({
      provider: recordReplay(mockModel([{ toolCalls: [{ name: 'list_repos', id: 'call_1', args: {} }] }, { text: 'You have lousho-demo.' }]), { cassette, mode: 'record' }),
      tools: [tool],
      store,
      exporter: createOtelTraceExporter({ tracer }),
      captureContent: true,
      onEvent: (event) => events.push(event),
    });

    const session = agent.session({ id: 'chat' });
    const paused = await session.send('List my repositories.', { principal: ALICE });
    expect(paused.finishReason).toBe('awaiting-approval');
    const [pending] = await agent.approvals.list();
    const state = new URL(pending.signIn?.url ?? '').searchParams.get('state') ?? '';
    await agent.oauth.complete({ state, code: 'code-alice' });
    const done = await agent.approvals.resolve({ id: pending.id, approved: true });
    expect(done.finishReason).toBe('stop');
    const transcript = JSON.stringify(await store.sessions.load('chat'));
    store.connection.close();

    const secrets = {
      access: executions[0],
      refresh: 'ghr_SECRET_1',
      code: 'code-alice',
      verifier: server.requests[0].get('code_verifier') ?? '',
    };
    expect(secrets.access).toBe('gho_SECRET_alice_1');
    expect(secrets.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const tables = dumpTables(join(dir, 'agent.db'));
    const outputs: Record<string, string> = {
      events: JSON.stringify(events),
      transcript,
      checkpoints: tables.checkpoints + tables.checkpoint_history,
      approvals: tables.approvals,
      spans: JSON.stringify(spans.getFinishedSpans().map((span) => span.attributes)),
      cassette: readFileSync(cassette, 'utf8'),
      result: JSON.stringify(done),
    };
    for (const [where, text] of Object.entries(outputs)) {
      expect(text.length, `${where} is empty, so the scan proves nothing`).toBeGreaterThan(2);
      for (const [name, secret] of Object.entries(secrets)) expect(text, `${name} in ${where}`).not.toContain(secret);
    }
    // the tool's own copy of the token was replaced, wherever its result went
    expect(outputs.events).toContain('token=[REDACTED]');
    expect(outputs.transcript).toContain('token=[REDACTED]');
    expect(outputs.spans).toContain('token=[REDACTED]');
    expect(outputs.approvals).toContain('sign-in'); // the scan saw the paused approval
    expect(spans.getFinishedSpans().length).toBeGreaterThan(2);
  });
});
