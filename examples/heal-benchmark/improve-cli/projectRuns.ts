import { defineTool, type AgentHook, type DefinedTool, type Message } from '@linuxdevil/lousho';
import { codingAgent } from '../codingAgent.ts';

type CodingProject = ReturnType<typeof codingAgent>;

export interface ProjectRun {
  readonly project: CodingProject;
  readonly input: string;
  simulated: boolean;
}

const LATEST = Symbol.for('lousho.examples.heal-benchmark.latestProjectRun');
const TEMPLATE = codingAgent();

const PROJECT_TOOLS: readonly string[] = TEMPLATE.tools.map((tool) => tool.name);

type Holder = { [LATEST]?: ProjectRun };

export function latestProjectRun(): ProjectRun | undefined {
  return (globalThis as Holder)[LATEST];
}

function startProjectRun(input: string): ProjectRun {
  const run: ProjectRun = { project: codingAgent(), input, simulated: false };
  (globalThis as Holder)[LATEST] = run;
  return run;
}

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function currentTool(name: string): DefinedTool {
  const run = latestProjectRun() ?? startProjectRun('');
  const tool = run.project.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No project tool ${name}.`);
  return tool;
}

function delegate(tool: DefinedTool): DefinedTool {
  return defineTool({ name: tool.name, description: tool.description, input: tool.input, execute: (args, context) => currentTool(tool.name).execute(args, context) });
}

const isSimulated = (result: unknown): boolean => typeof result === 'object' && result !== null && (result as { simulated?: unknown }).simulated === true;

export const freshProjectHook: AgentHook = {
  name: 'fresh-project',
  preGenerate(ctx) {
    if (ctx.messages.some((message) => message.role === 'assistant')) return;
    const first = ctx.messages.find((message) => message.role === 'user');
    startProjectRun(first ? textOf(first).trim() : '');
  },
  postToolCall(ctx, outcome) {
    const run = latestProjectRun();
    if (run && PROJECT_TOOLS.includes(ctx.toolName) && isSimulated(outcome.result)) run.simulated = true;
  },
};

export const projectTools: DefinedTool[] = TEMPLATE.tools.map(delegate);

export const codingInstructions = TEMPLATE.instructions;

export const codingTasks: readonly { id: string; input: string }[] = TEMPLATE.tasks.map(({ id, input }) => ({ id, input }));
