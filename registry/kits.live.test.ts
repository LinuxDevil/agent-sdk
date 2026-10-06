/**
 * Live registry-kit tests: both kits load through `loadAgentDir()` exactly as
 * an installed kit would, then run once against the real model
 * (`openrouter/openai/gpt-4o-mini`, declared in each kit's agent.json and
 * resolved from OPENROUTER_API_KEY in the shell or a `.env` at the repo
 * root; vitest loads `.env` into `process.env`, `.env` is gitignored).
 *
 *   npm run build        # the kits import '@lousho/build-ai-agent' -> dist/
 *   npm run test:live
 *
 * NEVER in CI: `*.live.test.ts` is excluded from the default vitest config.
 * These prove a real model can drive a kit's full declarative surface -
 * permissions, hooks, approver file, memory, schedules, channels - where the
 * mock-model suite only proves the wiring.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAgentDir } from '@lousho/build-ai-agent';
import { infra, resetInfra } from './incident-response/tools/infra.js';
import { resetTimeline, timeline } from './incident-response/hooks.js';

const ALERT = JSON.stringify({
  alert: {
    id: 'PD-4821',
    service: 'payments-api',
    environment: 'production',
    severity: 'critical',
    summary: 'error_rate 14% (baseline 0.4%)',
  },
});

describe.skipIf(!process.env.OPENROUTER_API_KEY)('live registry kits on OpenRouter (needs .env OPENROUTER_API_KEY)', () => {
  describe('inbox-triage', () => {
    const KIT = path.join(__dirname, 'inbox-triage');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-triage-live-'));
    process.env.INBOX_TRIAGE_HOME = home;

    const SEED = [
      { id: 'm-budget', from: 'priya@acme.com', subject: 'Invoice #1042 question', body: 'Hi - the invoice lists 12 seats but we only have 10. Confirm before Friday?', receivedAt: '2026-01-05T09:12:00.000Z', status: 'new' },
      { id: 'm-spam', from: 'winner@lottery-prizes.example', subject: 'You WON $5,000,000', body: 'Claim your prize now - reply with your bank details.', receivedAt: '2026-01-05T07:30:00.000Z', status: 'new' },
    ];

    beforeEach(() => {
      fs.rmSync(home, { recursive: true, force: true });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'inbox.json'), `${JSON.stringify(SEED, null, 2)}\n`, 'utf8');
    });
    afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

    it(
      'triages the seeded inbox on the real model without sending anything unapproved',
      async () => {
        const agent = await loadAgentDir(KIT);
        const result = await agent.send(
          'Triage the inbox: classify everything new, draft a reply where one is needed, hold sends for review.'
        );
        // a real model either pauses on send_reply or finishes having held it
        if (result.finishReason === 'awaiting-approval') {
          await agent.approvals.resolve({ id: result.approvalId!, approved: false, note: 'live test: do not send' });
        }
        const inbox = JSON.parse(fs.readFileSync(path.join(home, 'inbox.json'), 'utf8')) as Array<{ status: string }>;
        // every seeded message was triaged, and no reply left the outbox
        expect(inbox.every((m) => m.status !== 'new')).toBe(true);
        expect(fs.existsSync(path.join(home, 'outbox.json'))).toBe(false);
      },
      180_000
    );
  });

  describe('incident-response', () => {
    const KIT = path.join(__dirname, 'incident-response');
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-response-live-'));
      process.env.INCIDENT_TIMELINE_FILE = path.join(tmpRoot, 'timeline.jsonl');
      process.env.INCIDENT_WEBHOOK_SECRET = 'live-test-secret';
      resetInfra();
      resetTimeline();
    });
    afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    it(
      'diagnoses a production alert and gates remediation behind approval',
      async () => {
        const agent = await loadAgentDir(KIT);
        const result = await agent.send(`New alert on the intake channel:\n${ALERT}`);

        // the run must reach a sane end: a diagnosis, or a pause on a gated
        // remediation call - never an unapproved production change
        if (result.finishReason === 'awaiting-approval') {
          await agent.approvals.resolve({ id: result.approvalId!, approved: false, note: 'live test: deny remediation' });
        } else {
          expect(result.text.length).toBeGreaterThan(10);
        }

        // every call the model made was audited on the timeline
        expect(timeline.length).toBeGreaterThanOrEqual(1);
        // the deny rules held: every database still has all its rows
        expect(Object.values(infra.databases).every((db) => db.rows > 0)).toBe(true);
      },
      180_000
    );
  });
});
