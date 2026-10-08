/** Direct, read-only inspection of the SDK's SQLite file and the JSON db. */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR, readDb } from './db.js';

export function sqlite<T = any>(sql: string, ...params: any[]): T[] {
  const db = new DatabaseSync(join(DATA_DIR, 'agent.db'), { readOnly: true });
  try { return db.prepare(sql).all(...params) as T[]; } finally { db.close(); }
}

export const refunds = () => readDb().refunds;

export function transcript(sessionId: string): any[] {
  const row = sqlite<{ payload: string }>('SELECT payload FROM sessions WHERE id = ?', sessionId)[0];
  if (!row) return [];
  const parsed = JSON.parse(row.payload);
  return Array.isArray(parsed) ? parsed : parsed.messages ?? parsed;
}

export const checkpoints = (prefix: string) =>
  sqlite<{ session_id: string; payload: string }>('SELECT session_id, payload FROM checkpoints WHERE session_id LIKE ?', `${prefix}%`)
    .map((r) => ({ id: r.session_id, status: JSON.parse(r.payload).status }));

export const approvals = () =>
  sqlite<{ id: string; resolved_at: number | null; payload: string }>('SELECT id, resolved_at, payload FROM approvals')
    .map((r) => ({ id: r.id, resolved: r.resolved_at !== null, tool: JSON.parse(r.payload).pending?.toolName }));

export const memoryRows = () =>
  sqlite<{ scope_key: string; payload: string }>('SELECT scope_key, payload FROM memory_items')
    .map((r) => ({ scope: r.scope_key, items: (JSON.parse(r.payload) as any[]).map((i) => i.text) }));

export const brief = (messages: any[]) =>
  messages.map((m) => `${m.role}${m.metadata?.handoff ? `[handoff ${m.metadata.handoff.from}->${m.metadata.handoff.to}]` : ''}: ${
    typeof m.content === 'string' ? m.content.slice(0, 90).replace(/\n/g, ' ') : JSON.stringify(m.content).slice(0, 90)}${m.toolCalls ? ` calls=${m.toolCalls.map((c: any) => c.function?.name ?? c.name).join(',')}` : ''}`);
