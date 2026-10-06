/**
 * support-desk - Swarm-style customer support built on `createAgent({ handoffs })` (N6).
 *
 * The #1 production archetype for agent handoffs: a triage agent classifies the
 * request and hands the WHOLE conversation to a specialist, which replies to the
 * customer itself and owns every later turn of the session until it hands back:
 *
 *   user -> triage --transfer_to_billing-----> billing     (orders, refunds)
 *                \--transfer_to_techSupport--> techSupport (diagnostics, tickets)
 *
 * Why handoffs and not subagents - the difference is control flow:
 *
 *   - handoff  (`createAgent({ handoffs })`): control TRANSFERS. The
 *     `transfer_to_<name>` tool call is never executed as a tool; the run goes
 *     on as the target - its own instructions, model and tools - and later
 *     `session.send()` turns go straight to it. No "result" comes back to
 *     triage; triage is out of the loop.
 *   - subagent (`createAgent({ subagents })`): control RETURNS. The lead calls
 *     `task`, the child runs in a clean context, its answer comes back as the
 *     tool result, and the lead keeps owning the conversation.
 *
 * Swarm chose handoffs for support desks for exactly this reason: once the
 * request is classified, the specialist - not the router - should talk to the
 * customer.
 *
 * Wiring this example exercises:
 *   - `handoff(target, { input })` gives the transfer tool a structured schema
 *     (`{ reason, orderId? }` instead of the default `{ reason? }`), so triage's
 *     routing is validated data, not prose.
 *   - `inputFilter` shapes what the specialist sees:
 *     `handoffFilters.removeToolCalls` drops triage's tool noise and keeps the
 *     routing system note the SDK itself appends at each handoff - who was
 *     transferred, with the validated routing args.
 *   - The specialist owns its write path: `permissions: [ask('issue_refund')]`
 *     pauses refund calls for a human. `approve` decides them - set on the
 *     TRIAGE, because approval is an option of the run's starting agent and a
 *     handoff target's own `approve` is never consulted (createAgent warns if
 *     a target is built with one). Without an `approve` callback the run
 *     pauses (`awaiting-approval`) and `agent.approvals.resolve()` continues
 *     it - still as billing.
 *   - `handoffs` arrays are read at every run, so they can be filled after
 *     `createAgent()` returns: the specialists hand back to triage without a
 *     circular construction problem.
 *
 * Offline (the default) a scripted conversation runs: broken order -> triage ->
 * billing -> lookup_order -> issue_refund paused -> human approves -> refund ->
 * a follow-up turn answered by billing directly. With OPENROUTER_API_KEY it
 * runs live on openrouter/openai/gpt-4o-mini.
 *
 * Run with: npx tsx examples/support-desk/index.ts
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  allow,
  ask,
  createAgent,
  defineTool,
  handoff,
  handoffFilters,
  type AgentEvent,
  type ApproveToolCall,
  type Handoff,
  type HandoffInputData,
  type LLMProvider,
  type SimpleAgent,
} from '../../src';
import { mockModel } from '../../src/testing';

export const LIVE_MODEL = 'openrouter/openai/gpt-4o-mini';

export interface Order {
  orderId: string;
  status: 'processing' | 'shipped' | 'delivered';
  totalCents: number;
  items: string[];
}

export interface Refund {
  refundId: string;
  orderId: string;
  amountCents: number;
  reason: string;
}

export interface Ticket {
  ticketId: string;
  summary: string;
  priority: 'low' | 'normal' | 'high';
}

/** The desk's data stores; inject one per test so tools write into your copy. */
export interface SupportDeskState {
  orders: Record<string, Order>;
  refunds: Refund[];
  tickets: Ticket[];
}

export function demoState(): SupportDeskState {
  return {
    orders: {
      'A-10042': { orderId: 'A-10042', status: 'delivered', totalCents: 2599, items: ['ceramic pour-over set'] },
      'A-10017': { orderId: 'A-10017', status: 'shipped', totalCents: 8999, items: ['espresso grinder'] },
    },
    refunds: [],
    tickets: [],
  };
}

export interface SupportDeskOptions {
  /** A `provider/model` string for live runs, e.g. 'openrouter/openai/gpt-4o-mini'. */
  model?: string;
  /** One provider for all three agents; the per-agent options override it. */
  provider?: LLMProvider;
  triageProvider?: LLMProvider;
  billingProvider?: LLMProvider;
  techProvider?: LLMProvider;
  /** The desk's data; defaults to {@link demoState}. */
  state?: SupportDeskState;
  /**
   * Decides every tool call that pauses for approval - INCLUDING the
   * specialists' gated tools after a handoff: approval is an option of the
   * agent the run started with, so a specialist's own `approve` would never be
   * consulted. Omit it and gated calls pause the run with
   * `finishReason: 'awaiting-approval'`; decide them through
   * `agent.approvals.resolve()`.
   */
  approve?: ApproveToolCall;
  /** Observes each handoff (its structured routing args included). */
  onHandoff?: (data: HandoffInputData & { sessionId?: string }) => void;
  /** One line per permission decision: the desk's audit log. */
  onAudit?: (line: string) => void;
  /** Every run event (`tool.start`, `handoff`, `approval.requested`, ...). */
  onEvent?: (event: AgentEvent) => void;
}

export interface SupportDesk {
  /** The front-line agent; sessions and approvals belong to it. */
  agent: SimpleAgent;
  billing: SimpleAgent;
  techSupport: SimpleAgent;
  state: SupportDeskState;
  /** `{ from, to, args }` of each handoff the desk has made, in order. */
  handoffsSeen: Array<{ from: string; to: string; args: Record<string, unknown> }>;
}

export function createSupportDesk(options: SupportDeskOptions = {}): SupportDesk {
  const { state = demoState(), model = LIVE_MODEL } = options;
  const modelFor = (provider?: LLMProvider) => (provider ? { provider } : { model });

  const handoffsSeen: SupportDesk['handoffsSeen'] = [];
  const observe = (data: HandoffInputData & { sessionId?: string }) => {
    handoffsSeen.push({ from: data.from, to: data.to, args: data.args });
    options.onHandoff?.(data);
  };

  // The specialists' way back to triage. `handoffs` is read at every run, so
  // the shared array is filled once triage exists - no construction cycle.
  const backToTriage: Handoff[] = [];

  const billing = createAgent({
    name: 'billing',
    description: 'Billing specialist: refunds, invoices, duplicate charges and order problems.',
    instructions: [
      'You are the billing specialist of a support desk; this conversation is yours now.',
      'Always look the order up before refunding, then issue the refund (it needs human approval).',
      'If the request turns out not to be billing, hand the conversation back to triage.',
      'Keep replies short and concrete: order id, amount, what happens next.',
    ].join('\n'),
    ...modelFor(options.billingProvider ?? options.provider),
    tools: [
      defineTool({
        name: 'lookup_order',
        description: 'Look up an order by its id (e.g. "A-10042"). Read-only.',
        input: z.object({ orderId: z.string() }),
        execute: async ({ orderId }) => state.orders[orderId] ?? { error: `no such order: ${orderId}` },
      }),
      defineTool({
        name: 'issue_refund',
        description: 'Issue a refund for an order (amount in cents). Writes to the payment system; requires approval.',
        input: z.object({ orderId: z.string(), amountCents: z.number(), reason: z.string() }),
        execute: async ({ orderId, amountCents, reason }) => {
          const refund: Refund = { refundId: `R-${1000 + state.refunds.length}`, orderId, amountCents, reason };
          state.refunds.push(refund);
          return refund;
        },
      }),
    ],
    permissions: [allow('lookup_order'), ask('issue_refund')],
    handoffs: backToTriage,
  });

  const techSupport = createAgent({
    name: 'techSupport',
    description: 'Tech-support specialist: devices, errors, crashes, connectivity and setup.',
    instructions: [
      'You are the tech-support specialist of a support desk; this conversation is yours now.',
      'Run diagnostics before suggesting a fix; open a ticket only when the problem cannot be solved on the spot.',
      'If the request turns out to be billing, hand the conversation back to triage.',
      'Keep replies short: what you found, what to do.',
    ].join('\n'),
    ...modelFor(options.techProvider ?? options.provider),
    tools: [
      defineTool({
        name: 'run_diagnostics',
        description: 'Run diagnostics on a device or service. Read-only.',
        input: z.object({ device: z.string() }),
        execute: async ({ device }) => ({
          device,
          checks: [
            { name: 'firmware', ok: false, detail: 'firmware 1.02, latest is 1.04' },
            { name: 'signal', ok: true },
          ],
        }),
      }),
      defineTool({
        name: 'create_ticket',
        description: 'Open an engineering ticket for a problem that cannot be fixed on the spot. Requires approval.',
        input: z.object({ summary: z.string(), priority: z.enum(['low', 'normal', 'high']) }),
        execute: async ({ summary, priority }) => {
          const ticket: Ticket = { ticketId: `T-${100 + state.tickets.length}`, summary, priority };
          state.tickets.push(ticket);
          return ticket;
        },
      }),
    ],
    permissions: [allow('run_diagnostics'), ask('create_ticket')],
    handoffs: backToTriage,
  });

  const triage = createAgent({
    name: 'triage',
    description: 'Front-line triage: greets the customer and routes to the right specialist.',
    instructions: [
      'You are the front line of a support desk.',
      'Read the request and hand it to the right specialist with exactly one tool call:',
      '- transfer_to_billing for refunds, charges, invoices and order problems.',
      '- transfer_to_techSupport for devices, errors, crashes, connectivity and setup.',
      'Then stop: the specialist answers the customer, not you.',
      'If neither fits, answer yourself in at most two sentences.',
    ].join('\n'),
    ...modelFor(options.triageProvider ?? options.provider),
    handoffs: [
      handoff(billing, {
        // Structured routing instead of the default `{ reason?: string }`.
        input: z.object({
          reason: z.string().describe('Why this is billing, in one sentence'),
          orderId: z.string().optional().describe('The order id, when the customer gave one'),
        }),
        inputFilter: handoffFilters.removeToolCalls,
        onHandoff: observe,
      }),
      handoff(techSupport, {
        inputFilter: handoffFilters.removeToolCalls,
        onHandoff: observe,
      }),
    ],
    // Approval and audit are run-level options of the STARTING agent: this
    // `approve` also decides the specialists' gated tools post-handoff.
    approve: options.approve,
    onPermissionDecision: (entry) => options.onAudit?.(`${entry.toolName}: ${entry.decision}`),
    onEvent: options.onEvent,
    maxHandoffs: 5,
  });

  // Now that triage exists the specialists can hand back to it.
  backToTriage.push(
    handoff(triage, {
      description: 'Hand the conversation back to triage when the request is not your specialty.',
      onHandoff: observe,
    })
  );

  return { agent: triage, billing, techSupport, state, handoffsSeen };
}

// ---- Scripted offline demo --------------------------------------------------

export function scriptedTriage() {
  return mockModel([
    {
      text: 'That sounds frustrating - let me get our billing team on this.',
      toolCalls: [{ name: 'transfer_to_billing', args: { reason: 'Order arrived broken; customer wants a refund', orderId: 'A-10042' } }],
    },
  ]);
}

export function scriptedBilling() {
  return mockModel([
    { toolCalls: [{ name: 'lookup_order', args: { orderId: 'A-10042' } }] },
    { toolCalls: [{ name: 'issue_refund', args: { orderId: 'A-10042', amountCents: 2599, reason: 'order arrived broken' } }] },
    { text: 'I found order A-10042 (delivered, $25.99) and issued a full refund. It should reach your card in 3-5 business days.' },
    // The follow-up turn goes straight to billing - triage is not re-involved.
    { text: 'The refund is already issued; it should appear on your card within 3-5 business days.' },
  ]);
}

/** Prints the interesting run events for the demo. */
const trace = (event: AgentEvent) => {
  if (event.type === 'tool.start') console.log(`    [tool] ${event.toolName}(${JSON.stringify(event.args)})`);
  if (event.type === 'handoff') console.log(`    [handoff] ${event.from} -> ${event.to}`);
  if (event.type === 'approval.requested') console.log(`    [approval requested] ${event.toolName}`);
};

async function main() {
  const live = Boolean(process.env.OPENROUTER_API_KEY);
  const desk = createSupportDesk({
    onEvent: trace,
    ...(live
      ? // Live runs stay non-interactive: log each gated call and approve it.
        { approve: async ({ toolName, args }) => (console.log(`    [approval] auto-approving ${toolName}(${JSON.stringify(args)})`), true) }
      : // Offline runs take the pause + approvals.resolve() path below instead.
        { triageProvider: scriptedTriage(), billingProvider: scriptedBilling(), techProvider: mockModel([]) }),
  });

  console.log(live ? `Live run on ${LIVE_MODEL}` : 'Offline run with scripted models');
  const session = desk.agent.session();

  console.log('\nuser> Hi - my order A-10042 arrived smashed to pieces. I want my money back.');
  let result = await session.send('Hi - my order A-10042 arrived smashed to pieces. I want my money back.');

  // Billing's gated write paused the session's turn; the human on duty decides
  // it and the SAME session turn continues - still as billing.
  if (result.finishReason === 'awaiting-approval') {
    const [pending] = await desk.agent.approvals.list();
    console.log(`    [approval] ${pending.toolName}(${JSON.stringify(pending.args)}) paused the run - a human approves`);
    result = await desk.agent.approvals.resolve({ id: pending.id, approved: true });
  }
  console.log(`${result.agentName ?? 'agent'}> ${result.text}`);

  // No fresh classification needed: the follow-up goes straight to billing.
  console.log('\nuser> Thanks! Roughly when will the money land?');
  const followUp = await session.send('Thanks! Roughly when will the money land?');
  console.log(`${followUp.agentName ?? 'agent'}> ${followUp.text}`);

  console.log(`\nrefunds on file: ${JSON.stringify(desk.state.refunds)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
