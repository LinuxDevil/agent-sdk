/**
 * A tiny JSON "database" for the support desk: customers, orders, and a refund
 * ledger. Written atomically (temp file + rename) so two processes never see a
 * half-written file. The refund ledger is append-only and deliberately NOT
 * de-duplicated, so any double execution of the refund tool shows up as two rows.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Customer { id: string; name: string; email: string; token: string }
export interface Order {
  id: string; customerId: string; items: string[]; totalUsd: number;
  status: 'processing' | 'shipped' | 'delivered'; carrier?: string; tracking?: string; eta?: string;
}
export interface Refund {
  id: string; orderId: string; customerId: string; amountUsd: number; reason: string;
  toolCallId: string; approvedBy?: string; note?: string; at: string; pid: number;
}
export interface Db { customers: Customer[]; orders: Order[]; refunds: Refund[] }

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.SUPPORT_DATA_DIR ?? join(HERE, 'data');
export const DB_PATH = join(DATA_DIR, 'db.json');

export const SEED: Db = {
  customers: [
    { id: 'C100', name: 'Alice Moreno', email: 'alice@example.com', token: 'tok-alice' },
    { id: 'C200', name: 'Bob Okafor', email: 'bob@example.com', token: 'tok-bob' },
  ],
  orders: [
    { id: 'A-1001', customerId: 'C100', items: ['Trail running shoes'], totalUsd: 129.0, status: 'delivered', carrier: 'UPS', tracking: '1Z999AA10123456784', eta: '2026-10-01' },
    { id: 'A-1002', customerId: 'C100', items: ['Water bottle'], totalUsd: 24.5, status: 'shipped', carrier: 'USPS', tracking: '9400111899223856', eta: '2026-10-10' },
    { id: 'B-2001', customerId: 'C200', items: ['Espresso machine'], totalUsd: 489.0, status: 'processing' },
  ],
  refunds: [],
};

export function readDb(): Db {
  if (!existsSync(DB_PATH)) return structuredClone(SEED);
  return JSON.parse(readFileSync(DB_PATH, 'utf8')) as Db;
}

export function writeDb(db: Db): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, DB_PATH);
}

export function resetDb(): void { writeDb(structuredClone(SEED)); }

export function refundedSoFar(db: Db, orderId: string): number {
  return db.refunds.filter((r) => r.orderId === orderId).reduce((sum, r) => sum + r.amountUsd, 0);
}
