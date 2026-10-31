import { apiToken } from 'lousho/auth';
import type { ApprovalAccessRequest, SessionAccessRequest } from 'lousho';

// One token per user; the principal's id is the user.
export default [apiToken('alice-token', { id: 'alice' }), apiToken('bob-token', { id: 'bob' }), apiToken('manager-token', { id: 'manager' })];

// Session ids are `<user>-<suffix without '-'>`; the manager may open any of them.
const ownerOf = (sessionId: string) => sessionId.slice(0, Math.max(sessionId.lastIndexOf('-'), 0));

export function authorizeSession({ principal, sessionId }: SessionAccessRequest): boolean {
  return principal?.id === 'manager' || (principal !== undefined && ownerOf(sessionId) === principal.id);
}

// Only the manager decides a claim, and never one of their own.
export function authorizeApproval({ principal, approval }: ApprovalAccessRequest): boolean {
  return principal?.id === 'manager' && approval.principal?.id !== 'manager';
}
