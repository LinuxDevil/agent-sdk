// approvals.md:87
import { allow, ask, createAgent, defineTool, deny, type PermissionRule } from '@lousho/build-ai-agent';
import { z } from 'zod';

const shell = defineTool({
  name: 'shell',
  description: 'Run a shell command',
  input: z.object({ command: z.string() }),
  execute: async ({ command }) => `ran ${command}`,
});

const noDeletes: PermissionRule = {
  tool: 'shell',
  when: (args) => /\brm\b/.test(String(args.command)),
  action: 'deny',
  reason: 'Deleting files is not allowed',
};

const agent = createAgent({
  provider,
  instructions: 'You are a coding assistant.',
  tools: [shell],
  permissions: [
    noDeletes, // first match wins: this beats the `ask` below
    allow(/^read_/), // read-only tools never pause
    deny('delete_file', 'Use the trash tool instead'),
    ask(['shell', 'write_file']),
  ],
  onPermissionDecision: (entry) => console.log(entry.at, entry.toolName, entry.decision, entry.rule?.reason),
});
export {};
