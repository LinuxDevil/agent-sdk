/** N10b: the principal's types in tools, approval policies, permission rules, hooks and approvals. */
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  createAgent,
  defineTool,
  type AgentHook,
  type ApprovalCheckContext,
  type ApproveToolCall,
  type PendingApproval,
  type PermissionAuditContext,
  type PermissionContext,
  type PermissionRule,
  type Principal,
  type ResolveApprovalOptions,
  type ToolExecutionContext,
} from '../index';
import { createMockProvider } from '../providers/mock';

describe('Principal types in tools and approvals (N10b)', () => {
  it('a tool reads ctx.principal and ctx.approval.by, read-only', () => {
    expectTypeOf<ToolExecutionContext['principal']>().toEqualTypeOf<Readonly<Principal> | undefined>();
    expectTypeOf<NonNullable<ToolExecutionContext['approval']>['by']>().toEqualTypeOf<Readonly<Principal> | undefined>();
    defineTool({
      name: 'whoami',
      description: 'Says who is calling',
      input: z.object({}),
      execute: (_args, ctx) => expectTypeOf(ctx).toEqualTypeOf<ToolExecutionContext>(),
    });
    expectTypeOf<NonNullable<ToolExecutionContext['principal']>['claims']>().toEqualTypeOf<Readonly<Record<string, unknown>> | undefined>();
    const change = (principal: NonNullable<ToolExecutionContext['principal']>) => {
      // @ts-expect-error - a tool cannot change who the run acts for
      principal.id = 'someone-else';
    };
    void change;
  });

  it('needsApproval policies, permission rules, hooks and the audit callback see it', () => {
    expectTypeOf<ApprovalCheckContext['principal']>().toEqualTypeOf<Readonly<Principal> | undefined>();
    expectTypeOf<PermissionContext['principal']>().toEqualTypeOf<Readonly<Principal> | undefined>();
    expectTypeOf<PermissionAuditContext['principal']>().toEqualTypeOf<Readonly<Principal> | undefined>();
    defineTool({
      name: 'deploy',
      description: 'Deploys',
      input: z.object({ env: z.string() }),
      needsApproval: (_args, ctx) => ctx.principal?.claims?.admin !== true,
      execute: () => 'deployed',
    });
    const rule: PermissionRule = { tool: 'deploy', when: (_args, ctx) => ctx.principal?.type === 'service', action: 'deny' };
    const hook: AgentHook = {
      name: 'audit',
      preToolCall: (ctx) => {
        expectTypeOf(ctx.principal).toEqualTypeOf<Readonly<Principal> | undefined>();
      },
    };
    createAgent({
      provider: createMockProvider(),
      permissions: [rule],
      hooks: [hook],
      onPermissionDecision: (entry, { principal }) => {
        expectTypeOf(principal).toEqualTypeOf<Readonly<Principal> | undefined>();
        // The entry (also streamed as an event) carries no principal.
        // @ts-expect-error - not on the entry
        void entry.principal;
      },
    });
  });

  it('approvals record whose call it is and accept the approver', () => {
    expectTypeOf<PendingApproval['principal']>().toEqualTypeOf<Principal | undefined>();
    expectTypeOf<ResolveApprovalOptions['principal']>().toEqualTypeOf<Principal | undefined>();
    const approve: ApproveToolCall = (request) => request.principal?.claims?.admin === true;
    const agent = createAgent({ provider: createMockProvider(), approve });
    const approver: Principal = { id: 'ops', type: 'user', authenticator: 'jwt' };
    expectTypeOf(agent.approvals.resolve).toBeCallableWith({ id: 'a1', approved: true }, { principal: approver });
    expectTypeOf(agent.approvals.answer).toBeCallableWith({ id: 'a1', answer: 'yes' }, { principal: approver });
    expectTypeOf(agent.approvals.streamResolve).toBeCallableWith({ id: 'a1', approved: true }, { principal: approver });
    expectTypeOf(agent.approvals.streamAnswer).toBeCallableWith({ id: 'a1', answer: 'yes' }, { principal: approver });
  });
});
