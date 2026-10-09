/**
 * incident-responder: on-call incident-response agent, run LIVE.
 *
 *   cd E:\agent-sdk\audit && npx tsx incident-responder/index.ts
 *
 * Pipeline (all over real HTTP + a real OpenRouter model):
 *   signed alert webhook -> commander agent
 *     -> parallel `task` fan-out (logs / metrics / deploys investigators)
 *     -> `task` to severity-triage (typed {severity, confidence, rationale} output)
 *     -> `restart_service` tool call -> run PAUSES for human approval
 *     -> approval posted over HTTP -> run resumes -> remediation executes
 *     -> `transfer_to_report_writer` handoff -> incidents/<id>.md written
 *
 * Durability: createAgent({ store: fileStore('.lousho') }) keeps sessions,
 * turn checkpoints and the pending approval on disk.
 */
import '../_shared/env.ts';
import * as http from 'node:http';
import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { decide, mountChannels, webhookChannel, SessionAwaitingApprovalError, SDKError } from '@lousho/build-ai-agent';
import { LIVE_MODEL, hasLiveKey, report } from '../_shared/env.ts';
import {
  buildCommander,
  investigatorSpans,
  restartCalls,
  restartRequests,
  STORE_DIR,
  INCIDENTS_DIR,
} from './agents.ts';

const WEBHOOK_SECRET = 'audit-webhook-secret-7f3a';
const TS_HEADER = 'x-alert-timestamp';
const SIG_HEADER = 'x-signature-256';

function sign(body: string, timestamp?: string): Record<string, string> {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.`).update(body).digest('hex');
  return { [SIG_HEADER]: `sha256=${expected}`, [TS_HEADER]: ts, 'content-type': 'application/json' };
}

async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

const alertBody = (sessionKey: string, input: string) => JSON.stringify({ sessionKey, input });

async function main(): Promise<void> {
  console.log(`model: ${LIVE_MODEL}`);
  report('env: OPENROUTER_API_KEY', hasLiveKey, hasLiveKey ? 'key present (not printed)' : 'MISSING - live run impossible');
  if (!hasLiveKey) process.exit(1);

  /* -------------------------------------------------------------- */
  /* Surface 3a: decide() asymmetry — OpenAI Decisions API only       */
  /* -------------------------------------------------------------- */
  try {
    const r = await decide({
      input: 'HTTP 5xx spike on checkout',
      questions: [
        {
          type: 'choice',
          name: 'severity',
          instructions: 'How severe?',
          choices: [
            { value: 'low' },
            { value: 'high' },
          ],
        },
      ],
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      timeoutMs: 15_000,
    });
    report('decide() via OpenRouter', false, `unexpectedly succeeded: ${JSON.stringify(r)}`);
  } catch (error) {
    const e = error as SDKError;
    report('decide() via OpenRouter', true, `fails as documented (OpenAI-only endpoint): ${e.name} code=${(e as any).code ?? '?'} :: ${e.message.slice(0, 140)}`);
  }

  /* -------------------------------------------------------------- */
  /* Surface 1: webhook channel + HMAC auth -> agent session          */
  /* -------------------------------------------------------------- */
  // Channel sessions are durable since EVE-0 (#472): the inc-7001 conversation
  // from an earlier run would otherwise carry over. Start each run clean.
  rmSync(STORE_DIR, { recursive: true, force: true });
  const { commander } = buildCommander();
  const alerts = webhookChannel({
    name: 'alerts',
    auth: { type: 'hmac', secret: WEBHOOK_SECRET, timestampHeader: TS_HEADER, toleranceSeconds: 120 },
    principal: (body) => ({ id: 'pagerduty', type: 'service', authenticator: 'webhook' }),
  });
  // Predictable, filename-safe session id so the harness can resume() it.
  alerts.sessionId = (inbound) => String(inbound.sessionKey);
  const channels = mountChannels(commander, [alerts]);

  const server = http.createServer((req, res) => {
    void channels(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end('not found');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/channels/alerts`;
  console.log(`webhook listening at ${base}`);

  try {
    // --- auth negatives -------------------------------------------------
    const b1 = alertBody('inc-auth-check', 'ping');
    const unsigned = await post(base, b1);
    report('webhook: unsigned request rejected', unsigned.status === 401, `status=${unsigned.status}`);

    const badSig = await post(base, b1, { ...sign(b1), [SIG_HEADER]: 'sha256=deadbeef' });
    report('webhook: bad signature rejected', badSig.status === 401, `status=${badSig.status}`);

    const stale = await post(base, b1, sign(b1, String(Math.floor(Date.now() / 1000) - 3600)));
    report('webhook: stale timestamp rejected (replay protection)', stale.status === 401, `status=${stale.status}`);

    /* -------------------------------------------------------------- */
    /* Scenario 1: real 5xx spike on checkout                         */
    /* -------------------------------------------------------------- */
    const alert1 = alertBody(
      'inc-7001',
      [
        'INCIDENT ALERT INC-7001 (source: pagerduty)',
        'alert: http_5xx_spike',
        'service: checkout',
        'window: last 15m',
        'detail: ~42% of requests to checkout returning HTTP 502/503 since 14:02Z.',
        'Investigate, triage severity, remediate if justified, then produce an incident report.',
      ].join('\n'),
    );

    console.log('\n--- firing signed alert INC-7001 (checkout 5xx spike) ---');
    const t0 = Date.now();
    const fired = await post(base, alert1, sign(alert1));
    const paused = fired.json;
    console.log(`webhook run finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('finishReason:', paused.finishReason, '| steps:', paused.steps, '| approvalId:', paused.approvalId ?? 'none');
    console.log('toolCalls:', JSON.stringify((paused.toolCalls ?? []).map((c: any) => c.function?.name ?? c.toolName ?? c.name)));
    console.log('text:', String(paused.text ?? '').slice(0, 600));
    console.log('restartRequests so far:', JSON.stringify(restartRequests));

    report(
      'webhook: signed alert accepted, run paused for approval',
      fired.status === 200 && paused.finishReason === 'awaiting-approval' && typeof paused.approvalId === 'string',
      `status=${fired.status} finishReason=${paused.finishReason} approvalId=${paused.approvalId ?? 'none'}`,
    );
    if (typeof paused.approvalId !== 'string') throw new Error('run did not pause for approval - see diagnostics above');
    const approvalId = paused.approvalId as string;

    // --- surface 2: parallel sub-agent fan-out -------------------------
    const overlap =
      investigatorSpans.length >= 3 &&
      investigatorSpans.every((s) => investigatorSpans.some((o) => o !== s && o.startedAt < s.endedAt && s.startedAt < o.endedAt));
    const fanoutMsg = (paused.messages as any[] | undefined)?.find(
      (m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.filter((c: any) => c.function?.name === 'task' || c.toolName === 'task').length >= 3,
    );
    report(
      'sub-agents: 3 investigators fanned out in parallel',
      overlap || Boolean(fanoutMsg),
      `spans=${investigatorSpans.map((s) => `${s.investigator} ${s.startedAt % 100000}-${s.endedAt % 100000}ms`).join(' | ')}; single-turn-3x-task=${Boolean(fanoutMsg)}`,
    );
    const kinds = new Set(investigatorSpans.map((s) => s.investigator));
    report(
      'sub-agents: isolation (same tool name `query_telemetry`, 3 distinct backends)',
      kinds.size === 3,
      `distinct investigators ran: ${[...kinds].join(', ')}`,
    );

    // --- surface 6: durable pause on disk -------------------------------
    const approvalFile = join(STORE_DIR, 'approvals', `${approvalId}.json`);
    const onDisk = existsSync(approvalFile) ? JSON.parse(readFileSync(approvalFile, 'utf8')) : undefined;
    report(
      'durable store: pending approval persisted to disk',
      Boolean(onDisk?.pending?.toolName === 'restart_service' && onDisk?.snapshot),
      `file=${approvalFile.replace(/\\/g, '/').split('/audit/')[1] ?? approvalFile} tool=${onDisk?.pending?.toolName ?? 'n/a'}`,
    );
    const pendingInfo = await commander.approvals.get(approvalId);
    report(
      'approvals.get(id) reads the pause back',
      pendingInfo?.toolName === 'restart_service',
      `toolName=${pendingInfo?.toolName} args=${JSON.stringify(pendingInfo?.args)}`,
    );

    // The paused turn's checkpoint must be on disk WHILE paused (deleted on completion).
    const cpDir = join(STORE_DIR, 'checkpoints');
    const cpFiles = existsSync(cpDir) ? readdirSync(cpDir) : [];
    const cpFile = cpFiles.find((f) => f.startsWith('inc-7001'));
    const cp = cpFile ? JSON.parse(readFileSync(join(cpDir, cpFile), 'utf8')) : undefined;
    report(
      'durable store: paused turn checkpointed on disk',
      Boolean(cp && cp.status === 'awaiting-approval'),
      `checkpoint=${cpFile ?? 'none'} status=${cp?.status ?? 'n/a'}`,
    );

    let resumeRefused = false;
    let resumeError: unknown;
    let resumeReturned: unknown = 'not-called';
    try {
      resumeReturned = await commander.resume('inc-7001');
    } catch (error) {
      resumeError = error;
      resumeRefused = error instanceof SessionAwaitingApprovalError;
    }
    if (!resumeRefused) {
      const detail =
        resumeError instanceof Error
          ? `${resumeError.constructor.name}: ${resumeError.message}\n${(resumeError.stack ?? '').split('\n').slice(1, 8).join('\n')}`
          : `resolved with ${resumeReturned === null ? 'null' : JSON.stringify(resumeReturned)?.slice(0, 300)}`;
      console.log('resume diagnostic:', detail);
    }
    report('durable store: session checkpoint marked awaiting-approval (resume refuses)', resumeRefused, `session inc-7001.resume() -> ${resumeRefused ? 'SessionAwaitingApprovalError' : 'unexpected'}`);

    // --- surface 4: approve over the channel's approvals route ---------
    console.log(`\n--- approving ${approvalId} via POST /channels/alerts/approvals/${approvalId} ---`);
    const decisionBody = JSON.stringify({ approved: true, note: 'oncall-lead: restart approved' });
    const decided = await post(`${base}/approvals/${approvalId}`, decisionBody, sign(decisionBody));
    const continued = decided.json;

    report(
      'approval: paused run resumed via HTTP approvals route',
      decided.status === 200 && continued.finishReason === 'stop',
      `status=${decided.status} finishReason=${continued.finishReason}`,
    );
    report(
      'remediation: restart_service executed only after approval',
      restartCalls.length === 1 && restartCalls[0].service === 'checkout',
      `executed=${JSON.stringify(restartCalls)}`,
    );

    // --- surface 5: handoff to report writer ---------------------------
    const handedOff = (continued.toolCalls ?? []).some((c: any) => (c.function?.name ?? c.toolName ?? c.name) === 'transfer_to_report_writer');
    report(
      'handoff: transfer_to_report_writer called, run continued as the specialist',
      handedOff,
      `toolCalls in resumed run: ${JSON.stringify((continued.toolCalls ?? []).map((c: any) => c.function?.name ?? c.toolName ?? c.name))}`,
    );
    const reports = readdirSync(INCIDENTS_DIR).filter((f) => f.includes('INC-7001'));
    const reportFile = reports[0] && readFileSync(join(INCIDENTS_DIR, reports[0]), 'utf8');
    report(
      'handoff: report-writer produced incidents/INC-7001.md',
      Boolean(reportFile && reportFile.length > 200),
      reports[0] ? `${reports[0]} (${reportFile!.length} bytes)` : 'no file written; final text: ' + String(continued.text ?? '').slice(0, 200),
    );

    // After a finished turn the checkpoint + approval records are cleaned up; the transcript stays.
    const approvalGone = !existsSync(approvalFile);
    const sessionFiles = readdirSync(join(STORE_DIR, 'sessions'));
    report(
      'durable store: session transcript persisted; resolved approval claimed & deleted',
      sessionFiles.some((f) => f.includes('inc-7001')) && approvalGone,
      `sessions=${sessionFiles.filter((f) => !f.startsWith('subagent')).join(',')} (+${sessionFiles.filter((f) => f.startsWith('subagent')).length} subagent task sessions); approval file gone=${approvalGone}`,
    );

    // Edge probes (no model calls): invalid approval id, fork of a finished turn.
    let getThrew = false;
    try {
      await commander.approvals.get('bogus id!');
    } catch {
      getThrew = true;
    }
    report(
      'approvals.get(<invalid id>)',
      !getThrew,
      getThrew ? 'throws LOUSHO_CONFIG_INVALID instead of returning undefined' : 'returned undefined',
    );
    let forkErr = '';
    try {
      await commander.fork('inc-7001', { fromStep: 0 });
    } catch (error) {
      forkErr = (error as Error).message;
    }
    report(
      'fork: a finished session turn has no checkpoint history to fork',
      forkErr !== '',
      forkErr ? `refused: ${forkErr.slice(0, 140)}` : 'unexpectedly succeeded',
    );

    /* -------------------------------------------------------------- */
    /* Scenario 2: ambiguous alert -> confidence floor -> escalate      */
    /* -------------------------------------------------------------- */
    const restartsBefore = restartCalls.length;
    const requestsBefore = restartRequests.length;
    const alert2 = alertBody(
      'inc-7002',
      [
        'INCIDENT ALERT INC-7002 (source: pagerduty)',
        'alert: possible_anomaly',
        'service: staging-api',
        'detail: monitoring flagged a possible anomaly; no user complaints; unclear if real.',
        'Investigate, triage severity, remediate ONLY if justified, else escalate.',
      ].join('\n'),
    );
    console.log('\n--- firing signed alert INC-7002 (ambiguous staging-api alert) ---');
    const fired2 = await post(base, alert2, sign(alert2));
    const done2 = fired2.json;
    report(
      'confidence floor: no remediation, escalated to human',
      fired2.status === 200 &&
        done2.finishReason === 'stop' &&
        restartCalls.length === restartsBefore &&
        restartRequests.length === requestsBefore &&
        /escalat|human|on-?call/i.test(done2.text ?? ''),
      `finishReason=${done2.finishReason} restartRequests+${restartRequests.length - requestsBefore} restarts=${restartCalls.length} text=${String(done2.text ?? '').slice(0, 180)}`,
    );

    /* -------------------------------------------------------------- */
    console.log('\n=== artifacts ===');
    for (const dir of ['approvals', 'sessions', 'checkpoints']) {
      const p = join(STORE_DIR, dir);
      console.log(`${dir}/: ${existsSync(p) ? readdirSync(p).join(', ') : '(none)'}`);
    }
    console.log(`incidents/: ${readdirSync(INCIDENTS_DIR).join(', ')}`);
  } finally {
    server.close();
    await commander.close();
  }
}

await main();
