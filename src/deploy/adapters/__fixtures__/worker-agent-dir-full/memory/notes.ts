import { defineMemory, kvMemory } from 'lousho';

// kvMemory() is bound to the Worker's KV namespace (env.AGENT_CHECKPOINTS) per request.
export default defineMemory({
  name: 'notes',
  scope: 'global',
  provider: kvMemory(),
});
