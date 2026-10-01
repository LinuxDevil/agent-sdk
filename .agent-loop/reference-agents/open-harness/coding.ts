// (b) Coding agent: fs + bash tools, approval on destructive commands.
// Approval is an in-process async callback (apps/docs/tools/permissions.mdx):
// the run blocks while the human answers; nothing is persisted.
import { createInterface } from "node:readline/promises";
import { Agent, createBashTool, createFsTools, NodeFsProvider, NodeShellProvider } from "@openharness/core";
import { openai } from "@ai-sdk/openai";

const DESTRUCTIVE = /\b(rm|mv|chmod|chown|git\s+(push|reset|clean|checkout))\b|>/;
const rl = createInterface({ input: process.stdin, output: process.stdout });

const agent = new Agent({
  name: "coder",
  model: openai("gpt-5.4"),
  systemPrompt: "You are a careful coding agent. Read before you edit; run the tests after every change.",
  tools: { ...createFsTools(new NodeFsProvider()), ...createBashTool(new NodeShellProvider()) },
  maxSteps: 30,
  approve: async ({ toolName, input }) => {
    const command = (input as { command?: string }).command ?? "";
    const risky = ["writeFile", "editFile", "deleteFile"].includes(toolName) || DESTRUCTIVE.test(command);
    if (!risky) return true;
    return (await rl.question(`\nAllow ${toolName} ${JSON.stringify(input)}? [y/N] `)).trim() === "y";
  },
});

for await (const event of agent.run([], process.argv[2] ?? "Run the tests and fix what fails.")) {
  if (event.type === "text.delta") process.stdout.write(event.text);
  if (event.type === "tool.start") console.log(`\n> ${event.toolName} ${JSON.stringify(event.input)}`);
}
process.stdout.write("\n");
rl.close();
