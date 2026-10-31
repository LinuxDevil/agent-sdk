import type { AgentHook } from '../../../../execution/hooks';

const hooks: AgentHook[] = [
  { name: 'a', preToolCall() {} },
  { name: 'b', postGenerate() {} },
];

export default hooks;
