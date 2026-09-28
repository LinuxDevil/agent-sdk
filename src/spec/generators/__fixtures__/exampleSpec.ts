/**
 * Shared fixture AgentSpec reused by every cross-harness generator's tests
 * (LOU-J1/J2/J3), so the generators are all verified against the exact same
 * input.
 */
import { AgentSpec } from '../../schema';

export const exampleAgentSpec: AgentSpec = {
  name: 'ops-fixer',
  prompt:
    'You are an on-call fixer agent. Diagnose the root cause from the provided logs and ' +
    'produce a minimal unified diff that fixes it. Never invent files that were not shown to you.',
  provider: {
    type: 'mock',
    model: 'mock-model-1',
  },
  tools: ['http', 'current-date', 'day-name'],
  policy: {
    requiresApproval: true,
    guardrails: ['secret-scan', 'diff-size-cap'],
  },
  triggers: [
    {
      type: 'webhook',
      path: '/webhook',
    },
  ],
};
