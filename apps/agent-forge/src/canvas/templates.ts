import type { AgentSpecV2 } from '@linuxdevil/lousho';
import { specToGraph } from '../graph/v2/specToGraph';
import type { Graph } from '../graph/v2/types';

export type TemplateId = 'blank' | 'support-bot';

export interface AgentTemplate {
  id: TemplateId;
  name: string;
  description: string;
  spec: AgentSpecV2;
}

/**
 * Seed templates for the "New agent" flow (spec v2). `support-bot` mirrors
 * the prompt of this SDK's own examples/support-bot/index.ts, extended with
 * a trigger and a tool so the canvas shows a non-trivial agent.
 */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'blank',
    name: 'Blank agent',
    description: 'A single agent with the mock model - the minimum AgentSpec needs.',
    spec: {
      version: 2,
      name: 'new-agent',
      model: 'mock/mock-1',
      instructions: 'You are a helpful agent.',
    },
  },
  {
    id: 'support-bot',
    name: 'Support bot',
    description: 'Chat trigger, one tool and the support prompt, seeded from examples/support-bot.',
    spec: {
      version: 2,
      name: 'support-bot',
      model: 'mock/mock-1',
      instructions:
        'You are a friendly customer support agent. Be concise, empathetic, and always ask for ' +
        'an order number when a customer reports a problem with an order.',
      tools: [{ builtin: 'http_request' }],
      triggers: [{ id: 't1', type: 'chat' }],
    },
  },
];

/** `name` (the id typed in "New agent") replaces the template's own spec name. */
export function graphFromTemplate(id: TemplateId, name?: string): Graph {
  const template = AGENT_TEMPLATES.find((t) => t.id === id) ?? AGENT_TEMPLATES[0];
  return specToGraph(name ? { ...template.spec, name } : template.spec);
}
