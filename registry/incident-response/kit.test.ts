/**
 * The incident-response kit, exercised offline: the directory is loaded in
 * place with `loadAgentDir()` / `resolveAgentDir()` (the kit's files import
 * `@lousho/build-ai-agent` by name, resolved to this repo's dist through the
 * workspace self-link - like kit.test.ts in examples/coding-harness, this
 * needs `npm run build` to have run).
 *
 * The scripted mockModel plays the responder: an alert arrives (the same
 * JSON the `alerts` webhook channel would deliver), the agent diagnoses with
 * read-only tools, and its remediation goes through the risk-tiered gate -
 * staging auto-allowed, production asks (the kit's approver annotates the
 * tier), destructive calls denied - while the audit hook writes the
 * timeline.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgent, loadAgentDir, resolveAgentDir } from '@lousho/build-ai-agent';
import { mockModel, type MockModel } from '@lousho/build-ai-agent/testing';
// static imports share the module instances the loader's dynamic import gets
import { infra, resetInfra } from './tools/infra.js';
import { resetTimeline, timeline } from './hooks.js';
import approve from './approve.js';

const DIR = __dirname; // the kit directory itself

const ALERT = JSON.stringify({
  alert: {
    id: 'PD-4821',
    service: 'payments-api',
    environment: 'production',
    severity: 'critical',
    summary: 'error_rate 14% (baseline 0.4%)',
  },
});

let timelineFile: string;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-response-'));
  timelineFile = path.join(tmpRoot, 'timeline.jsonl');
  process.env.INCIDENT_TIMELINE_FILE = timelineFile;
  // set before any resolveAgentDir call so the channel file binds the HMAC secret at load
  process.env.INCIDENT_WEBHOOK_SECRET = 'test-secret';
  resetInfra();
  resetTimeline();
});

/** The tool-result messages of the provider's most recent request, joined - what the model saw. */
const toolOutputs = (provider: MockModel): string =>
  provider.calls[provider.calls.length - 1].messages
    .filter((m) => m.role === 'tool')
    .map((m) => String(m.content))
    .join('\n');

const auditLog = (): { audit: string[]; onPermissionDecision: (entry: { toolName: string; decision: string; rule?: { reason?: string } }) => void } => {
  const audit: string[] = [];
  return {
    audit,
    onPermissionDecision: (entry) => audit.push(`${entry.toolName}: ${entry.decision}${entry.rule?.reason ? ` (${entry.rule.reason})` : ''}`),
  };
};

describe('the kit, loaded in place', () => {
  it('discovers every tool, the skill and the alerts channel', async () => {
    const { manifest, channels } = await resolveAgentDir(DIR, { provider: mockModel(['x']) });
    expect(manifest.tools).toEqual([
      'check_logs',
      'query_metrics',
      'get_runbook',
      'check_status',
      'restart_service',
      'scale_replicas',
      'post_update',
      'drop_table',
      'delete_data',
    ]);
    expect(manifest.skills).toEqual(['incident-runbook']);
    expect(manifest.channels).toEqual(['alerts']);
    expect(channels[0].name).toBe('alerts');
  });
});

describe('the alerts webhook channel', () => {
  /** A request whose signature is computed with `key` (omit for unsigned). */
  const signedRequest = (body: string, key?: string) => {
    const rawBody = new TextEncoder().encode(body);
    const headers: Record<string, string> =
      key === undefined ? {} : { 'x-signature-256': `sha256=${crypto.createHmac('sha256', key).update(rawBody).digest('hex')}` };
    return { method: 'POST', url: '/channels/alerts', headers, rawBody, text: body };
  };

  it('requires the HMAC signature and turns an alert POST into agent input keyed on sessionKey', async () => {
    const { channels } = await resolveAgentDir(DIR, { provider: mockModel(['x']) });
    const channel = channels[0];
    const ok = async (req: ReturnType<typeof signedRequest>) => {
      const verdict = await channel.verify?.(req);
      return typeof verdict === 'object' ? verdict.ok : verdict !== false;
    };
    const body = JSON.stringify({ input: 'Alert: payments-api error_rate 14%', sessionKey: 'inc-4821' });

    expect(await ok(signedRequest(body))).toBe(false); // unsigned
    expect(await ok(signedRequest(body, 'bad'))).toBe(false); // wrong key
    expect(await ok(signedRequest(body, 'test-secret'))).toBe(true);

    const inbound = await channel.parse(signedRequest(body, 'test-secret'), () => {}, undefined as never);
    expect(inbound && 'input' in inbound && inbound.input).toBe('Alert: payments-api error_rate 14%');
    expect(inbound && 'sessionKey' in inbound && inbound.sessionKey).toBe('inc-4821');
  });
});

describe('an incident end to end', () => {
  it('diagnoses, gets the production restart approved at tier 2, verifies and audits every call', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'check_logs', args: { service: 'payments-api', severity: 'error' } }] },
      { toolCalls: [{ name: 'query_metrics', args: { service: 'payments-api', metric: 'error_rate' } }] },
      { toolCalls: [{ name: 'get_runbook', args: { topic: 'high-error-rate' } }] },
      { toolCalls: [{ name: 'restart_service', args: { service: 'payments-api', environment: 'production', reason: 'pool exhausted' } }] },
      { toolCalls: [{ name: 'check_status', args: { service: 'payments-api' } }] },
      { toolCalls: [{ name: 'post_update', args: { message: 'payments-api restarted; error_rate recovering', severity: 'info' } }] },
      { text: 'Mitigated: restarted payments-api in production (approved at tier 2); error_rate back to baseline.' },
    ]);
    const { audit, onPermissionDecision } = auditLog();
    const agent = await loadAgentDir(DIR, { provider, onPermissionDecision });

    const result = await agent.send(ALERT);

    expect(result.finishReason).toBe('stop');
    expect(result.text).toContain('Mitigated');
    // diagnosis ran, the gate asked on the production restart, then it executed
    expect(audit).toContain('check_logs: allow');
    expect(audit).toContain('query_metrics: allow');
    expect(audit).toContain('restart_service: ask');
    expect(infra.services['payments-api'].status).toBe('healthy');
    expect(infra.services['payments-api'].restarts).toBe(2);
    // the update was posted and every call is on the timeline (memory + JSONL file)
    expect(infra.updates.map((u) => u.message)).toContain('payments-api restarted; error_rate recovering');
    // the approved call re-enters the pipeline after the pause, so its 'call' is recorded twice
    const calls = timeline.filter((e) => e.phase === 'call').map((e) => e.toolName);
    expect(calls).toEqual(['check_logs', 'query_metrics', 'get_runbook', 'restart_service', 'restart_service', 'check_status', 'post_update']);
    const restartResult = timeline.find((e) => e.toolName === 'restart_service' && e.phase === 'result');
    expect(restartResult?.detail).toContain('"after":"healthy"');
    const lines = fs.readFileSync(timelineFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { toolName: string; phase: string });
    expect(lines.filter((l) => l.toolName === 'restart_service').map((l) => l.phase)).toEqual(['call', 'approval', 'call', 'result']);
    // the model saw the canned diagnosis data
    expect(toolOutputs(provider)).toContain('pool exhausted');
  });

  it('pauses for a human when no approver answers, and resumes on approval', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'restart_service', args: { service: 'payments-api', environment: 'production' } }] },
      { toolCalls: [{ name: 'check_status', args: { service: 'payments-api' } }] },
      { text: 'Restarted after human approval; verified healthy.' },
    ]);
    const { config } = await resolveAgentDir(DIR, { provider });
    const agent = createAgent({ ...config, approve: undefined });

    const paused = await agent.send(ALERT);
    expect(paused.finishReason).toBe('awaiting-approval');
    const [pending] = await agent.approvals.list();
    expect(pending.toolName).toBe('restart_service');
    expect(infra.services['payments-api'].status).toBe('degraded'); // not executed while paused

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.finishReason).toBe('stop');
    expect(infra.services['payments-api'].status).toBe('healthy');
  });

  it('refuses tier-3 asks: scaling to zero is rejected by the kit approver', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'scale_replicas', args: { service: 'payments-api', environment: 'production', replicas: 0 } }] },
      { text: 'Approval refused - escalating to the on-call human.' },
    ]);
    const { audit, onPermissionDecision } = auditLog();
    const agent = await loadAgentDir(DIR, { provider, onPermissionDecision });

    const result = await agent.send(ALERT);

    expect(result.finishReason).toBe('stop');
    expect(audit).toContain('scale_replicas: ask');
    expect(infra.services['payments-api'].desiredReplicas).toBe(3);
    expect(toolOutputs(provider)).toMatch(/reject|denied|refused/i);
  });

  it('auto-allows staging remediation without asking', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'restart_service', args: { service: 'checkout-web', environment: 'staging' } }] },
      { text: 'Staging restarted.' },
    ]);
    const { audit, onPermissionDecision } = auditLog();
    const agent = await loadAgentDir(DIR, { provider, onPermissionDecision });

    await agent.send('Alert: checkout-web staging deploy check');

    expect(audit).toContain('restart_service: allow');
    expect(audit).not.toContain('restart_service: ask');
    expect(infra.services['checkout-web'].restarts).toBe(1);
  });
});

describe('the safety rails', () => {
  it('denies drop_table before the tool can run, leaving the data intact', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'drop_table', args: { table: 'payments' } }] },
      { text: 'The drop was denied by policy; escalating to the on-call human.' },
    ]);
    const { audit, onPermissionDecision } = auditLog();
    const agent = await loadAgentDir(DIR, { provider, onPermissionDecision });

    await agent.send(ALERT);

    expect(audit).toContain("drop_table: deny (Destructive data operations are never within an incident responder's mandate)");
    expect(infra.databases.payments.rows).toBe(184_203);
    expect(toolOutputs(provider)).toContain('denied');
    expect(timeline.find((e) => e.toolName === 'drop_table')?.phase).toBe('call'); // the attempt is audited
  });

  it('denies delete_data too', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'delete_data', args: { table: 'sessions' } }] },
      { text: 'Denied.' },
    ]);
    const { audit, onPermissionDecision } = auditLog();
    const agent = await loadAgentDir(DIR, { provider, onPermissionDecision });

    await agent.send(ALERT);

    expect(audit).toContain("delete_data: deny (Destructive data operations are never within an incident responder's mandate)");
    expect(infra.databases.sessions.rows).toBe(51_977);
  });

  it('catches a model that labels a production service as staging to dodge the ask tier', async () => {
    const provider = mockModel([
      // the "allow staging" rule matches the claimed argument, but the tool
      // cross-checks the estate and refuses the mismatched call
      { toolCalls: [{ name: 'restart_service', args: { service: 'payments-api', environment: 'staging' } }] },
      { text: 'Environment mismatch caught - re-issuing as production with approval.' },
    ]);
    const { audit, onPermissionDecision } = auditLog();
    const agent = await loadAgentDir(DIR, { provider, onPermissionDecision });

    await agent.send(ALERT);

    expect(audit).toContain('restart_service: allow'); // the rule trusted the claimed arg
    expect(toolOutputs(provider)).toContain('environment mismatch'); // the tool did not
    expect(infra.services['payments-api'].status).toBe('degraded');
  });
});

describe('the kit approver', () => {
  const pending = (toolName: string, args: Record<string, unknown>) => ({ id: 'ap-1', toolCallId: 'call_1', toolName, args, createdAt: new Date().toISOString() });

  it('annotates tier-2 approvals and refuses everything hotter', () => {
    expect(approve(pending('restart_service', { environment: 'production' }))).toContain('risk tier 2');
    expect(approve(pending('scale_replicas', { environment: 'production', replicas: 4 }))).toContain('risk tier 2');
    expect(approve(pending('scale_replicas', { environment: 'production', replicas: 0 }))).toBe(false);
    expect(approve(pending('unknown_tool', {}))).toBe(false);
  });
});
