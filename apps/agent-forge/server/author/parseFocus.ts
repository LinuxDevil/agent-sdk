import type { AuthorFocus } from '../../shared/authorWire';
import { isValidAgentId } from '../../shared/agentId';

export type ParsedFocus = { ok: true; focus?: AuthorFocus } | { ok: false };

export function parseFocus(value: unknown): ParsedFocus {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
  const candidate = value as { mode?: unknown; agentId?: unknown };
  if (candidate.mode === 'create') return { ok: true, focus: { mode: 'create' } };
  if (candidate.mode === 'edit' && typeof candidate.agentId === 'string' && isValidAgentId(candidate.agentId)) {
    return { ok: true, focus: { mode: 'edit', agentId: candidate.agentId } };
  }
  return { ok: false };
}
