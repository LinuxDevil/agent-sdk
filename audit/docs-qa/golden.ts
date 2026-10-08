/** Golden questions about the SDK with the doc file(s) a correct answer cites. */
export interface GoldenCase {
  label: string;
  input: string;
  /** Any of these files counts as a correct citation. */
  expectFiles: string[];
  /** Words a correct answer should contain (case-insensitive, any one). */
  expectAny: string[];
}

export const GOLDEN: GoldenCase[] = [
  {
    label: 'record-replay',
    input: 'How do I record real model calls once and replay them in CI without an API key?',
    expectFiles: ['docs/testing.md', 'docs/evals.md'],
    expectAny: ['recordReplay', 'cassette'],
  },
  {
    label: 'eval-exit-codes',
    input: 'What exit code does `lousho eval` return when vitest is not installed, and when a gate fails?',
    expectFiles: ['docs/evals.md', 'docs/cli.md'],
    expectAny: ['2'],
  },
  {
    label: 'structured-output',
    input: 'How do I make an agent return a typed object validated by a zod schema, and what happens if the reply is invalid?',
    expectFiles: ['docs/structured-output.md'],
    expectAny: ['output-invalid', 'repair'],
  },
  {
    label: 'approvals',
    input: 'How do I require a human to approve a tool call before it runs?',
    expectFiles: ['docs/approvals.md', 'docs/permission-modes.md'],
    expectAny: ['approv'],
  },
  {
    label: 'semantic-memory',
    input: 'How can an agent recall stored memories by meaning instead of by keyword?',
    expectFiles: ['docs/memory.md'],
    expectAny: ['embed', 'vector'],
  },
  {
    label: 'mcp',
    input: 'How do I connect an MCP server to an agent?',
    expectFiles: ['docs/mcp.md'],
    expectAny: ['mcpServers', 'MCP'],
  },
  {
    label: 'reasoning-effort',
    input: 'How do I control how much the model reasons before it answers?',
    expectFiles: ['docs/reasoning.md'],
    expectAny: ['reasoning'],
  },
  {
    label: 'compaction',
    input: 'How do I keep a long conversation from overflowing the context window?',
    expectFiles: ['docs/compaction.md'],
    expectAny: ['compact'],
  },
];
