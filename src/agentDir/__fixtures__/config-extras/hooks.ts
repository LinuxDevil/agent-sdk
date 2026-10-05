import type { AgentHook } from '../../../execution/hooks';

export const seen: string[] = [];

const spy: AgentHook = {
  name: 'spy',
  preToolCall(ctx) {
    seen.push(ctx.toolName);
  },
};

export default spy;
