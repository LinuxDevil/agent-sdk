// configuration.md:346
import { createAgent, type CreateAgentBase } from '@lousho/build-ai-agent';

const shared: CreateAgentBase = { maxSteps: 8, modelSettings: { temperature: 0 } };

function triageAgent(overrides: Partial<CreateAgentBase> = {}) {
  return createAgent({ model: 'openai/gpt-4o-mini', instructions: 'Triage the incident.', ...shared, ...overrides });
}
export {};
