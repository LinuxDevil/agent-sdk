import type { AgentSpec } from '@loushy/build-ai-agent';
import { specToGraph } from '../graph/specToGraph';
import type { AgentGraphSpec } from '../graph/types';

export type TemplateId = 'blank' | 'support-bot';

export interface AgentTemplate {
  id: TemplateId;
  name: string;
  description: string;
  spec: AgentSpec;
}

/**
 * Seed templates for the "New agent" flow (LOU-M3). `support-bot` mirrors
 * the shape (and prompt) of this SDK's own examples/support-bot/index.ts,
 * extended with a trigger and a tool node so it demonstrates the full
 * trigger -> llm -> tool -> output pipeline shape on the canvas - the
 * example itself is a minimal `createAgent()` call with no triggers/tools,
 * since those are graph-editor-only concepts layered on top of the same
 * flat `AgentSpec`.
 */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'blank',
    name: 'Blank graph',
    description: 'A single LLM node with the mock provider - the minimum AgentSpec needs.',
    spec: {
      name: 'new-agent',
      prompt: 'You are a helpful agent.',
      provider: { type: 'mock', model: 'mock-1' },
    },
  },
  {
    id: 'support-bot',
    name: 'Support bot',
    description: 'trigger → llm → tool → output, seeded from examples/support-bot.',
    spec: {
      name: 'support-bot',
      prompt:
        'You are a friendly customer support agent. Be concise, empathetic, and always ask for ' +
        'an order number when a customer reports a problem with an order.',
      provider: { type: 'mock', model: 'mock-1' },
      tools: ['http'],
      triggers: [{ type: 'input' }],
    },
  },
];

export function graphFromTemplate(id: TemplateId): AgentGraphSpec {
  const template = AGENT_TEMPLATES.find((t) => t.id === id) ?? AGENT_TEMPLATES[0];
  return specToGraph(template.spec);
}
