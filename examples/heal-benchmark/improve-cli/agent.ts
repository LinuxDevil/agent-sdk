import type { CreateAgentConfig } from 'lousho';
import { DEFAULT_MODEL, refuseUnsharedModels } from './modelRule.ts';
import { codingInstructions, freshProjectHook, projectTools } from './projectRuns.ts';

if (process.argv.includes('improve')) refuseUnsharedModels(process.argv);

export default {
  name: 'coding-agent',
  model: `openrouter/${DEFAULT_MODEL}`,
  instructions: codingInstructions,
  tools: projectTools,
  hooks: [freshProjectHook],
  maxSteps: 15,
} satisfies CreateAgentConfig;
