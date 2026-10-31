import type { AgentHook } from '../../../../execution/hooks';

const spy: AgentHook = {
  name: 'spy',
  preToolCall() {},
};

export default spy;
