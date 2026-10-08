/**
 * The support desk agents: a `triage` lead that hands off to `orders` and
 * `billing` specialists. Tools read/write the JSON db (db.ts). Customer identity
 * is the run's `principal` (set by route auth), never the model's arguments.
 */
import { createAgent, defineMemory, defineTool, handoff, type HandoffInputData, type Principal } from '@lousho/build-ai-agent';
import type { AuthFn } from '@lousho/build-ai-agent/auth';
import { SqliteStore, sqliteMemory } from '@lousho/build-ai-agent/sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { localProvider } from '../_shared/local.js';
import { DATA_DIR, readDb, refundedSoFar, writeDb } from './db.js';

export const REFUND_APPROVAL_THRESHOLD_USD = 50;

/** Every tool resolves the customer from the verified principal, never from args. */
function customerOf(principal: Readonly<Principal> | undefined): string | undefined {
  return principal?.type === 'user' && principal.authenticator === 'custom' ? principal.id : undefined;
}

function ownOrder(orderId: string, principal: Readonly<Principal> | undefined) {
  const customerId = customerOf(principal);
  const order = readDb().orders.find((o) => o.id === orderId.trim().toUpperCase());
  if (!customerId) return { error: 'No signed-in customer.' } as const;
  if (!order || order.customerId !== customerId) return { error: `No order ${orderId} on this account.` } as const;
  return { order } as const;
}

export const listMyOrders = defineTool({
  name: 'list_my_orders',
  description: "Lists the signed-in customer's orders (id, items, total, status).",
  input: z.object({}),
  execute: async (_args, ctx) => {
    const customerId = customerOf(ctx.principal);
    if (!customerId) return { error: 'No signed-in customer.' };
    return readDb().orders.filter((o) => o.customerId === customerId).map(({ id, items, totalUsd, status }) => ({ id, items, totalUsd, status }));
  },
});

export const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Looks up one order of the signed-in customer by id (e.g. A-1001).',
  input: z.object({ orderId: z.string().describe('Order id like A-1001') }),
  execute: async ({ orderId }, ctx) => {
    const found = ownOrder(orderId, ctx.principal);
    if ('error' in found) return found;
    const db = readDb();
    return { ...found.order, refundedUsd: refundedSoFar(db, found.order.id) };
  },
});

export const trackShipment = defineTool({
  name: 'track_shipment',
  description: 'Shipment status, carrier, tracking number and ETA of an order of the signed-in customer.',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }, ctx) => {
    const found = ownOrder(orderId, ctx.principal);
    if ('error' in found) return found;
    const { status, carrier, tracking, eta } = found.order;
    return status === 'processing' ? { status, note: 'Not shipped yet.' } : { status, carrier, tracking, eta };
  },
});

/** Counts executions per process (so a repro can see double execution). */
export const refundExecutions: string[] = [];

export const issueRefund = defineTool({
  name: 'issue_refund',
  description: `Refunds money to the signed-in customer for one of their orders. Refunds over $${REFUND_APPROVAL_THRESHOLD_USD} wait for a human supervisor.`,
  input: z.object({
    orderId: z.string(),
    amountUsd: z.number().positive(),
    reason: z.string(),
  }),
  needsApproval: ({ amountUsd }) => amountUsd > REFUND_APPROVAL_THRESHOLD_USD,
  execute: async ({ orderId, amountUsd, reason }, ctx) => {
    refundExecutions.push(ctx.toolCallId);
    const found = ownOrder(orderId, ctx.principal);
    if ('error' in found) return found;
    const db = readDb();
    const already = refundedSoFar(db, found.order.id);
    if (already + amountUsd > found.order.totalUsd + 1e-9) {
      return { error: `Refund too large: order total $${found.order.totalUsd}, already refunded $${already}.` };
    }
    const refund = {
      id: `R-${randomUUID().slice(0, 8)}`, orderId: found.order.id, customerId: found.order.customerId, amountUsd, reason,
      toolCallId: ctx.toolCallId, approvedBy: ctx.approval?.by?.id, note: ctx.approval?.note, at: new Date().toISOString(), pid: process.pid,
    };
    db.refunds.push(refund);
    writeDb(db);
    return { refunded: true, refundId: refund.id, amountUsd };
  },
});

/** Bearer `tok-<name>` is a customer; `tok-staff` is a supervisor (role claim). */
export const supportAuth: AuthFn = async (request) => {
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return null;
  if (token === 'tok-staff') return { id: 'staff-maria', type: 'user', authenticator: 'staff', claims: { role: 'supervisor' } };
  const customer = readDb().customers.find((c) => c.token === token);
  return customer ? { id: customer.id, type: 'user', authenticator: 'custom', claims: { name: customer.name } } : null;
};
supportAuth.challenges = [{ scheme: 'Bearer' }];

/** Keeps everything except the system-role routing note (the tool result keeps the handoff marker). */
export const dropRoutingNote = ({ messages }: HandoffInputData) => messages.filter((m) => !(m.role === 'system' && m.metadata?.handoff));

export interface Desk {
  triage: ReturnType<typeof createAgent>;
  store: SqliteStore;
}

export function buildDesk(options: { dbFile?: string; onEvent?: (e: unknown) => void } = {}): Desk {
  const provider = localProvider();
  const store = new SqliteStore(options.dbFile ?? join(DATA_DIR, 'agent.db'));
  const customerNotes = defineMemory({
    name: 'customer_notes',
    description: 'durable facts about THIS customer (preferences, sizes, contact preferences)',
    scope: ({ principal }) => (principal ? `customer:${principal.id}` : undefined),
    provider: sqliteMemory(store),
  });

  const orders = createAgent({
    name: 'orders',
    description: 'Order status, shipment tracking and delivery questions',
    instructions:
      'You are the orders desk of the Northwind Outfitters store. Use list_my_orders, lookup_order and track_shipment. ' +
      'Answer in at most two sentences. Never invent order data.',
    provider,
    tools: [listMyOrders, lookupOrder, trackShipment],
    maxSteps: 6,
    retry: { maxRetries: 3 },
  });

  const billing = createAgent({
    name: 'billing',
    description: 'Refunds, charges and payment questions',
    instructions:
      'You are the billing desk of the Northwind Outfitters store. To refund, first call lookup_order to check the order total, ' +
      'then call issue_refund with the exact amount the customer asked for (never more than the order total). ' +
      'A refund only happens if issue_refund returns refunded: true. Answer in at most two sentences.',
    provider,
    tools: [lookupOrder, issueRefund],
    maxSteps: 6,
    retry: { maxRetries: 3 },
  });

  const triage = createAgent({
    name: 'triage',
    instructions:
      'You are the front desk of the Northwind Outfitters online store. Do not answer order or money questions yourself: ' +
      'call transfer_to_orders for order status / shipping / tracking, and transfer_to_billing for refunds, charges or payments. ' +
      'Save lasting personal preferences the customer states (e.g. shoe size, preferred contact channel) with remember_customer_notes. ' +
      'For greetings or small talk, answer briefly yourself.',
    provider,
    // WORKAROUND (FINDINGS F1): the SDK's routing note is a mid-transcript `system` message,
    // which Qwen/Llama chat templates reject ("System message must be at the beginning").
    handoffs: process.env.KEEP_ROUTING_NOTE === '1' ? [orders, billing] : [handoff(orders, { inputFilter: dropRoutingNote }), handoff(billing, { inputFilter: dropRoutingNote })],
    memory: [customerNotes],
    store,
    maxSteps: 8,
    retry: { maxRetries: 3 },
    ...(options.onEvent && { onEvent: options.onEvent as never }),
  });
  return { triage, store };
}
