/**
 * sdr-outreach — AI-SDR audit harness (live, OpenRouter).
 *
 * Replicates the production "AI SDR" pattern (Reply.io / AiSDR / Mesh-Pilot
 * style — drafts-as-pull-requests): an agent works a CRM lead queue —
 * enrich, qualify against the ICP, draft personalized cold outreach — but
 * can NEVER send. Every draft stops in a durable human approval queue
 * (`needsApproval: true` on draft_email — the pending approval record IS
 * the queue entry, persisted by fileStore). A rejection carries reviewer
 * feedback back to the model, which redrafts.
 *
 * Sending is a different principal with a different tool allowlist: a
 * second agent whose tools are ONLY send_email + log_activity — the SDR's
 * tool list simply omits send_email. send_email is itself approval-gated
 * AND its execute() refuses any draft not marked approved (defense in
 * depth, exercised in phase 3 against a rogue draft that never went
 * through the queue).
 *
 *   cd audit && npx tsx sdr-outreach/index.ts
 */
import '../_shared/env.ts';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createAgent, defineTool, fileStore, type AgentEvent, type ExecutionResult, type PendingApproval } from '@lousho/build-ai-agent';
import { LIVE_MODEL, hasLiveKey, report } from '../_shared/env.ts';

if (!hasLiveKey) {
  console.error('OPENROUTER_API_KEY not set (loadAuditEnv found nothing). Bailing.');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(here, '.runs', stamp);
const storeDir = path.join(runDir, 'store');
mkdirSync(storeDir, { recursive: true });
const auditLog = path.join(runDir, 'events.jsonl');
const log = (entry: Record<string, unknown>) =>
  appendFileSync(auditLog, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');

// Self-contained run artifacts: the CRM fixture travels with the run dir.
copyFileSync(path.join(here, 'leads.json'), path.join(runDir, 'leads.json'));

/* ------------------------------------------------------------------ */
/* CRM state (in-memory, seeded from leads.json)                        */
/* ------------------------------------------------------------------ */

interface Activity {
  at: string;
  type: string;
  note: string;
}
interface Lead {
  id: string;
  name: string;
  role: string;
  company: string;
  industry: string;
  size: number;
  signal: string;
  status: string;
  activities: Activity[];
}
type DraftStatus = 'pending' | 'approved' | 'rejected' | 'sent';
interface Draft {
  id: string;
  leadId: string;
  subject: string;
  body: string;
  status: DraftStatus;
  createdAt: string;
}

const leads = new Map<string, Lead>();
for (const l of JSON.parse(readFileSync(path.join(here, 'leads.json'), 'utf8')) as Lead[]) leads.set(l.id, l);

const drafts = new Map<string, Draft>();
const sent: { draftId: string; leadId: string; to: string; subject: string; at: string }[] = [];
/** Leads enrich_lead ran on — the harness asserts every ICP lead is in here. */
const enrichments = new Set<string>();
/** Draft ids actually created by draft_email's execute() (an approved call). */
const createdDraftIds: string[] = [];
/** Draft ids the reviewer approved (the queue decision recorded on the draft). */
const approvedDraftIds = new Set<string>();
let draftSeq = 0;

// A draft somebody parked in the CRM outside the agent workflow — it never
// went through the approval queue, so it stays 'pending' forever and the
// send path must refuse it (phase 3 checks this directly).
drafts.set('draft-rogue', {
  id: 'draft-rogue',
  leadId: 'lead-1',
  subject: 'quick question',
  body: 'Saw the team is hiring — worth a chat?',
  status: 'pending',
  createdAt: new Date().toISOString(),
});

const addActivity = (leadId: string, type: string, note: string) => {
  const lead = leads.get(leadId);
  if (lead) lead.activities.push({ at: new Date().toISOString(), type, note });
};

/** Simulated enrichment backend, keyed by lead id. */
const ENRICHMENT: Record<string, { techStack: string[]; recentNews: string; headcountGrowth: string; mutualConnections: string[] }> = {
  'lead-1': {
    techStack: ['Kotlin', 'Kubernetes', 'PostgreSQL'],
    recentNews: 'Opened a second engineering hub in Lisbon; hiring page lists 6 backend roles',
    headcountGrowth: '+18% engineering headcount in the last 6 months',
    mutualConnections: ['J. Park (former colleague, now at Nimbus)'],
  },
  'lead-2': {
    techStack: ['TypeScript', 'React', 'AWS'],
    recentNews: 'Closed an $18M Series B led by NorthPeak Capital to scale the engineering org',
    headcountGrowth: 'plans to grow engineering from 14 to ~30 this year',
    mutualConnections: ['S. Adeyemi (angel in the round)'],
  },
  'lead-3': {
    techStack: ['Go', 'Temporal', 'GCP'],
    recentNews: 'Engineering blog post on cutting meeting load for distributed teams',
    headcountGrowth: '+9% engineering headcount YoY',
    mutualConnections: [],
  },
  'lead-4': {
    techStack: ['Shopify', 'WordPress'],
    recentNews: 'Seasonal storefront work; no dedicated engineering hiring',
    headcountGrowth: 'flat — 2 developers',
    mutualConnections: [],
  },
  'lead-5': {
    techStack: ['Python', 'Flask'],
    recentNews: 'Won a regional student hackathon',
    headcountGrowth: 'n/a — student club',
    mutualConnections: [],
  },
};

/* ------------------------------------------------------------------ */
/* Domain tools — the same CRM surface a production AI SDR wraps        */
/* ------------------------------------------------------------------ */

const listLeads = defineTool({
  name: 'list_leads',
  description: "List leads in the SDR queue. Optional 'status' filter (e.g. 'new'). Returns summaries including the buying signal.",
  input: z.object({ status: z.string().optional() }),
  async execute({ status }) {
    return [...leads.values()]
      .filter((l) => !status || l.status === status)
      .map((l) => ({ id: l.id, name: l.name, role: l.role, company: l.company, industry: l.industry, size: l.size, signal: l.signal, status: l.status }));
  },
});

const getLead = defineTool({
  name: 'get_lead',
  description: 'Fetch one lead with its full CRM activity history.',
  input: z.object({ id: z.string() }),
  async execute({ id }) {
    return leads.get(id) ?? { error: `unknown lead ${id}` };
  },
});

const enrichLead = defineTool({
  name: 'enrich_lead',
  description: 'Enrich a lead: tech stack, recent company news, headcount growth, mutual connections.',
  input: z.object({ id: z.string() }),
  async execute({ id }) {
    const lead = leads.get(id);
    if (!lead) return { error: `unknown lead ${id}` };
    enrichments.add(id);
    addActivity(id, 'enriched', 'enrichment pulled (tech stack / news / headcount growth)');
    log({ kind: 'crm', op: 'enrich_lead', leadId: id });
    return {
      id,
      name: lead.name,
      company: lead.company,
      ...(ENRICHMENT[id] ?? { techStack: [], recentNews: 'nothing found', headcountGrowth: 'unknown', mutualConnections: [] }),
    };
  },
});

const draftEmail = defineTool({
  name: 'draft_email',
  description:
    'Create an outbound email draft for a lead. EVERY draft stops in the human approval queue before it can be sent — the call pauses for review. A rejection returns the reviewer note; incorporate it and draft again.',
  input: z.object({
    leadId: z.string(),
    subject: z.string(),
    body: z.string().describe('full email body — must reference this lead’s real signal, never a generic template'),
  }),
  needsApproval: true,
  async execute({ leadId, subject, body }) {
    const lead = leads.get(leadId);
    if (!lead) return { error: `unknown lead ${leadId}` };
    const draft: Draft = { id: `draft-${++draftSeq}`, leadId, subject, body, status: 'pending', createdAt: new Date().toISOString() };
    drafts.set(draft.id, draft);
    createdDraftIds.push(draft.id);
    addActivity(leadId, 'draft_created', `draft ${draft.id}: "${subject}"`);
    log({ kind: 'crm', op: 'draft_created', draftId: draft.id, leadId, subject });
    return draft;
  },
});

/** The actual send — callable directly so phase 3 can prove the guard without a tool call. */
async function sendDraft(draftId: string): Promise<Record<string, unknown>> {
  const draft = drafts.get(draftId);
  if (!draft) return { sent: false, reason: `unknown draft ${draftId}` };
  if (draft.status !== 'approved') {
    log({ kind: 'crm', op: 'send_refused', draftId, status: draft.status });
    return { sent: false, draftId, leadId: draft.leadId, reason: `draft ${draftId} is '${draft.status}' — only approved drafts can be sent` };
  }
  const lead = leads.get(draft.leadId);
  const local = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');
  const to = `${local(lead?.name ?? 'unknown')}@${local(lead?.company ?? 'unknown') || 'unknown'}.com`;
  draft.status = 'sent';
  sent.push({ draftId, leadId: draft.leadId, to, subject: draft.subject, at: new Date().toISOString() });
  addActivity(draft.leadId, 'sent', `email sent to ${to}: "${draft.subject}"`);
  log({ kind: 'crm', op: 'email_sent', draftId, leadId: draft.leadId, to });
  return { sent: true, draftId, leadId: draft.leadId, to, subject: draft.subject };
}

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send a draft that has cleared human review. Refuses drafts whose status is not approved.',
  input: z.object({ draftId: z.string() }),
  needsApproval: true,
  async execute({ draftId }) {
    return sendDraft(draftId);
  },
});

const makeLogActivity = () =>
  defineTool({
    name: 'log_activity',
    description: "Append a note to a lead's CRM activity timeline.",
    input: z.object({
      leadId: z.string(),
      type: z.string().describe("activity type, e.g. 'researched', 'note'"),
      note: z.string(),
    }),
    async execute({ leadId, type, note }) {
      if (!leads.has(leadId)) return { error: `unknown lead ${leadId}` };
      addActivity(leadId, type, note);
      log({ kind: 'crm', op: 'log_activity', leadId, type });
      return { ok: true };
    },
  });

const markDisqualified = defineTool({
  name: 'mark_disqualified',
  description: 'Mark a lead disqualified with a one-line reason. Use for leads outside the ICP.',
  input: z.object({ leadId: z.string(), reason: z.string() }),
  async execute({ leadId, reason }) {
    const lead = leads.get(leadId);
    if (!lead) return { error: `unknown lead ${leadId}` };
    lead.status = 'disqualified';
    addActivity(leadId, 'disqualified', reason);
    log({ kind: 'crm', op: 'mark_disqualified', leadId, reason });
    return { ok: true, id: leadId, status: lead.status };
  },
});

/* ------------------------------------------------------------------ */
/* Agents — the allowlist boundary IS the tool list                     */
/* ------------------------------------------------------------------ */

const SDR_INSTRUCTIONS = `You are an AI SDR for FlowBoard, an async-standup tool for engineering teams: it replaces the synchronous daily standup with async written check-ins, built for remote and distributed engineering orgs.

ICP: engineering leaders (Engineering Manager / Director / VP Eng) at tech companies of roughly 50-500 employees showing a hiring or remote-team signal.
Out of ICP: students, tiny non-technical teams, companies far outside that size band.

Workflow:
1. list_leads to see the queue (status 'new'). The summary already carries role, size and signal — call get_lead only if you need the activity history.
2. For each lead, call enrich_lead to pull tech stack, news, headcount growth, mutual connections.
3. ICP fit -> draft_email with a personalized opener that references THIS lead's real signal or enrichment (their company, the raise, the remote team, the standup pain). Generic templates get rejected by the reviewer — a rejection returns the note; incorporate it and draft_email again. Then log_activity type 'researched' with a one-line rationale.
4. Qualify BEFORE drafting — never draft for a lead you are about to disqualify. Not ICP -> mark_disqualified with a one-line reason.
5. You have NO send capability — drafts go to the human review queue and a separate operator/agent sends what is approved. Never ask for send_email.
Work the whole queue, then reply with one line per lead: qualified/drafted or disqualified and why.`;

const sdr = createAgent({
  name: 'sdr',
  model: LIVE_MODEL,
  store: fileStore(path.join(storeDir, 'sdr')),
  instructions: SDR_INSTRUCTIONS,
  tools: [listLeads, getLead, enrichLead, draftEmail, makeLogActivity(), markDisqualified],
  maxSteps: 25,
});
const sdrSession = sdr.session({ id: 'sdr-queue-1' });

const sender = createAgent({
  name: 'sender',
  model: LIVE_MODEL,
  store: fileStore(path.join(storeDir, 'sender')),
  instructions:
    'You are the outbound sender for the SDR team. The operator gives you a list of approved draft ids. ' +
    'For each one: call send_email with the draftId. If a send is refused, report it and move on — do not retry and do not argue. ' +
    'When done, reply with one line per draft: sent or refused.',
  tools: [sendEmail, makeLogActivity()],
  maxSteps: 15,
});
const senderSession = sender.session({ id: 'sender-1' });

/* ------------------------------------------------------------------ */
/* Event log                                                           */
/* ------------------------------------------------------------------ */

const counts: Record<string, number> = {};
const approvalsRequestedByTool: Record<string, number> = {};
const short = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
};
function show(e: AgentEvent): void {
  counts[e.type] = (counts[e.type] ?? 0) + 1;
  switch (e.type) {
    case 'step.start': console.log(`  -- step ${e.step}`); break;
    case 'tool.start': console.log(`  tool.start ${e.toolName} ${short(e.args, 110)}`); break;
    case 'tool.done': console.log(`  tool.done ${e.toolName} (${e.durationMs}ms)`); break;
    case 'tool.error': console.log(`  tool.error ${e.toolName}: ${short(e.error.message, 140)}`); break;
    case 'approval.requested':
      approvalsRequestedByTool[e.toolName] = (approvalsRequestedByTool[e.toolName] ?? 0) + 1;
      console.log(`  approval.requested ${e.toolName}`);
      break;
    case 'text.done': console.log(`  text: ${short(e.text, 300)}`); break;
    case 'error': console.log(`  ERROR ${e.error.name}: ${short(e.error.message, 160)}`); break;
    case 'provider.retry': console.log(`  provider.retry ${e.attempt}`); break;
    case 'run.done': console.log(`  == run.done ${e.finishReason}`); break;
  }
}
sdrSession.on(show);
senderSession.on(show);

/* ------------------------------------------------------------------ */
/* Deterministic operator policy (the human review queue)              */
/* ------------------------------------------------------------------ */

// lead-2's signal is the $18M Series B — the one draft this harness always
// rejects once, with actionable feedback, to exercise the redraft loop.
const REJECT_LEAD_ID = 'lead-2';
const REJECT_NOTE = 'too generic — mention their Series B and the async-standup angle';
const rejectedOnce = new Set<string>();
const rejectionsPerLead = new Map<string, number>();
const draftCallsPerLead = new Map<string, number>();
let draftDecisions = 0;
let draftApprovedCalls = 0;
let draftRejectedCalls = 0;

const SIGNAL_KEYWORDS: Record<string, string[]> = {
  'lead-1': ['nimbus', 'hiring', 'remote', 'time zone', 'backend'],
  'lead-2': ['cartloop', 'series b', 'doubl', 'engineering org'],
  'lead-3': ['ledgerly', 'remote', 'standup', 'maker time', 'meeting'],
  'lead-4': ['petal', 'stem'],
  'lead-5': ['university', 'student', 'hack'],
};

function personalized(lead: Lead, text: string): boolean {
  const hay = text.toLowerCase();
  const keys = [lead.company.split(/[\s&]+/)[0]!, ...(SIGNAL_KEYWORDS[lead.id] ?? [])];
  return keys.some((k) => k && hay.includes(k.toLowerCase()));
}

function decide(pending: PendingApproval | undefined): { approved: boolean; note?: string } {
  if (!pending) return { approved: false, note: 'no pending approval found' };

  if (pending.toolName === 'draft_email') {
    draftDecisions++;
    const leadId = String(pending.args.leadId ?? '');
    draftCallsPerLead.set(leadId, (draftCallsPerLead.get(leadId) ?? 0) + 1);
    const lead = leads.get(leadId);
    if (!lead) {
      draftRejectedCalls++;
      return { approved: false, note: `unknown lead ${leadId}` };
    }
    // The one scripted rejection: first draft for REJECT_LEAD_ID, once only.
    if (leadId === REJECT_LEAD_ID && !rejectedOnce.has(leadId)) {
      rejectedOnce.add(leadId);
      draftRejectedCalls++;
      return { approved: false, note: REJECT_NOTE };
    }
    const text = `${pending.args.subject ?? ''}\n${pending.args.body ?? ''}`;
    if (personalized(lead, text)) {
      draftApprovedCalls++;
      return { approved: true };
    }
    // Non-personalized drafts get rejected — but a reviewer can't stall the
    // queue forever, so each lead gets at most one quality rejection.
    const n = rejectionsPerLead.get(leadId) ?? 0;
    if (n < 1) {
      rejectionsPerLead.set(leadId, n + 1);
      draftRejectedCalls++;
      return { approved: false, note: `reviewer: reads like a template — reference ${lead.company}'s actual signal (${lead.signal})` };
    }
    console.log(`  !! operator override: approving non-personalized draft for ${leadId} after rejection budget`);
    draftApprovedCalls++;
    return { approved: true };
  }

  if (pending.toolName === 'send_email') {
    const draftId = String(pending.args.draftId ?? '');
    const draft = drafts.get(draftId);
    if (draft?.status === 'approved') return { approved: true };
    return { approved: false, note: `operator policy: draft ${draftId} is not approved — send refused` };
  }

  return { approved: false, note: `operator policy: unexpected tool ${pending.toolName}` };
}

/** The reviewer's queue decision, recorded on the draft and in the CRM. */
function flushApprovedDrafts(): void {
  for (const d of drafts.values()) {
    if (d.status === 'pending' && createdDraftIds.includes(d.id)) {
      d.status = 'approved';
      approvedDraftIds.add(d.id);
      addActivity(d.leadId, 'draft_approved', `reviewer approved ${d.id}`);
      log({ kind: 'crm', op: 'draft_approved', draftId: d.id, leadId: d.leadId });
    }
  }
}

const approvalFileExists = (id: string) =>
  ['sdr', 'sender'].some((sub) => existsSync(path.join(storeDir, sub, 'approvals', `${id}.json`)));

let durablePauseSeen = false;

async function drive(
  agent: ReturnType<typeof createAgent>,
  send: (input: string) => Promise<ExecutionResult>,
  input: string
): Promise<ExecutionResult> {
  let result = await send(input);
  while (result.finishReason === 'awaiting-approval' && result.approvalId) {
    if (approvalFileExists(result.approvalId)) durablePauseSeen = true;
    const pending = await agent.approvals.get(result.approvalId);
    const d = decide(pending);
    console.log(`  >> operator ${d.approved ? 'APPROVED' : 'REJECTED'} ${pending?.toolName} ${short(pending?.args, 100)}${d.note ? ` (${d.note})` : ''}`);
    log({ kind: 'approval-decision', id: result.approvalId, tool: pending?.toolName, args: pending?.args, ...d });
    if (!d.approved && pending?.toolName === 'draft_email') {
      addActivity(String(pending.args.leadId ?? ''), 'draft_rejected', `reviewer: ${d.note ?? 'rejected'}`);
    }
    result = await agent.approvals.resolve({ id: result.approvalId, approved: d.approved, ...(d.note && { note: d.note }) });
    flushApprovedDrafts();
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

console.log(`model: ${LIVE_MODEL}\nrun dir: ${runDir}\nstore: ${storeDir}`);

console.log('\n=== PHASE 1: the SDR works the lead queue ===');
const t1 = await drive(
  sdr,
  (m) => sdrSession.send(m),
  'Work the lead queue: research each lead, draft personalized outreach for ICP-fit leads, disqualify the rest.'
);
log({ kind: 'phase', phase: 'sdr', finishReason: t1.finishReason });
console.log(`phase 1 finish: ${t1.finishReason}`);

console.log('\n=== PHASE 2: a different principal sends the approved drafts ===');
const approved = [...drafts.values()].filter((d) => d.status === 'approved');
log({ kind: 'phase', phase: 'send', approvedDrafts: approved.map((d) => d.id) });
const sendList = approved
  .map((d) => `${d.id} (lead ${d.leadId}, ${leads.get(d.leadId)?.name} @ ${leads.get(d.leadId)?.company})`)
  .join('; ');
const t2 = await drive(
  sender,
  (m) => senderSession.send(m),
  approved.length
    ? `These drafts cleared human review: ${sendList}. Send each one with send_email, then report the outcome per draft.`
    : 'No drafts cleared review. Reply with "nothing to send".'
);
log({ kind: 'phase', phase: 'send-done', finishReason: t2.finishReason });
console.log(`phase 2 finish: ${t2.finishReason}`);

console.log('\n=== PHASE 3: defense in depth — the send path refuses unapproved drafts ===');
// draft-rogue never entered the queue; even a call that bypassed the approval
// layer entirely must fail inside send_email's execute().
const rogueAttempt = await sendDraft('draft-rogue');
report(
  'send path refuses an unapproved draft',
  rogueAttempt.sent === false && !sent.some((s) => s.draftId === 'draft-rogue'),
  `result=${short(rogueAttempt, 160)}`
);

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

console.log('\n=== VERDICT ===');

const lead5 = leads.get('lead-5');
report('out-of-ICP lead disqualified', lead5?.status === 'disqualified', `lead-5 status=${lead5?.status} activities=${lead5?.activities.length}`);

const icpIds = ['lead-1', 'lead-2', 'lead-3'];
report(
  'every ICP lead was enriched',
  icpIds.every((id) => enrichments.has(id)),
  `enriched=${[...enrichments].sort().join(',')}`
);

const requestedDraft = approvalsRequestedByTool['draft_email'] ?? 0;
report(
  'every draft paused in the human approval queue',
  requestedDraft > 0 && requestedDraft === draftDecisions && createdDraftIds.length === draftApprovedCalls,
  `approval.requested(draft_email)=${requestedDraft} decisions=${draftDecisions} approved=${draftApprovedCalls} rejected=${draftRejectedCalls} created=${createdDraftIds.length}`
);

const lead2Drafts = [...drafts.values()].filter((d) => d.leadId === REJECT_LEAD_ID);
const incorporatesNote = lead2Drafts.some((d) => /series b|async/i.test(`${d.subject} ${d.body}`));
report(
  'rejected draft was redrafted with the feedback incorporated',
  rejectedOnce.has(REJECT_LEAD_ID) && (draftCallsPerLead.get(REJECT_LEAD_ID) ?? 0) >= 2 && incorporatesNote,
  `lead-2 draft_email calls=${draftCallsPerLead.get(REJECT_LEAD_ID) ?? 0} drafts=${lead2Drafts.length} mentionsNote=${incorporatesNote}`
);

const sentClean = sent.length > 0 && sent.every((s) => approvedDraftIds.has(s.draftId));
const allApprovedSent = [...approvedDraftIds].every((id) => sent.some((s) => s.draftId === id));
report(
  'only approved drafts were sent',
  sentClean && allApprovedSent,
  `sent=${sent.length} approved=${approvedDraftIds.size} rogueSent=${sent.some((s) => s.draftId === 'draft-rogue')}`
);

const sentLeadIds = new Set(sent.map((s) => s.leadId));
const chainOk =
  sentLeadIds.size > 0 &&
  [...sentLeadIds].every((id) => {
    const types = new Set(leads.get(id)?.activities.map((a) => a.type) ?? []);
    return ['enriched', 'draft_created', 'draft_approved', 'sent'].every((t) => types.has(t));
  });
const auditLines = existsSync(auditLog) ? readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
report(
  'audit trail: events.jsonl + CRM activities record the full chain',
  chainOk && auditLines > 5,
  `auditLines=${auditLines} sentLeads=${[...sentLeadIds].join(',')}`
);

const storeArtifacts = (sub: string) => (existsSync(path.join(storeDir, sub)) ? readdirSync(path.join(storeDir, sub), { recursive: true }).length : 0);
report(
  'durable: paused approvals persisted under store/',
  durablePauseSeen && storeArtifacts('sdr') > 0,
  `durablePauseSeen=${durablePauseSeen} sdrStoreEntries=${storeArtifacts('sdr')} senderStoreEntries=${storeArtifacts('sender')}`
);

writeFileSync(
  path.join(runDir, 'crm-snapshot.json'),
  JSON.stringify({ leads: [...leads.values()], drafts: [...drafts.values()], sent }, null, 2)
);
console.log('event counts:', JSON.stringify(counts));
console.log(`run dir kept at ${runDir}`);
