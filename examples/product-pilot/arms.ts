import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createAgent, loadAgentDir, loadSkills, type AgentHook, type LLMProvider, type DefinedTool, type SimpleAgent } from 'lousho';
import { codingAgent } from '../heal-benchmark/codingAgent';
import { PILOT_PROJECT } from './cases';

const ARMS =['flat', 'flat-plus', 'product'] as const;
export type ArmName = (typeof ARMS)[number];

export const PRODUCT_DIR = path.join(__dirname, 'coding-product');
export const DEFAULT_MAX_STEPS = 40;

export const PAGE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  investigate: ['read_file', 'list_dir', 'grep', 'run_tests'],
  fix: ['read_file', 'list_dir', 'grep', 'edit_file', 'write_file', 'run_tests'],
  review: ['read_file', 'list_dir', 'grep', 'run_tests'],
};

export const LEAD_TOOLS: readonly string[] = ['read_file', 'list_dir', 'grep', 'run_tests'];

export interface ArmSettings {
  model: string;
  maxTokens: number;
  maxSteps: number;
  hooks: AgentHook[];
  provider?: () => LLMProvider;
}

export interface Built {
  agent: SimpleAgent;
  input: string;
  check: () => boolean;
  failure: () => string | undefined;
}

const pageDir = (page: string) => path.join(PRODUCT_DIR, 'subagents', page);

const pageText = (page: string) => readFileSync(path.join(pageDir(page), 'instructions.md'), 'utf8');

export function houseRules(page = 'fix'): string {
  const text = pageText(page);
  return text.slice(text.indexOf('## House rules')).trim();
}

export function pageGuidance(page: string): string {
  const text = pageText(page);
  return text.slice(text.indexOf('\n\n'), text.indexOf('## House rules')).trim();
}

export function flatPlusInstructions(flat: string): string {
  const steps = Object.keys(PAGE_TOOLS).map((page) => `### ${page[0].toUpperCase()}${page.slice(1)}\n\n${pageGuidance(page)}`);
  return [flat, 'Work in three steps: investigate, then fix, then review. If your review finds a problem, fix it and review again, at most twice.', ...steps, houseRules()].join('\n\n');
}

function pick(tools: readonly DefinedTool[], names: readonly string[]): DefinedTool[] {
  return tools.filter((tool) => names.includes(tool.name));
}

function modelOption(settings: ArmSettings): { provider: LLMProvider } | { model: string } {
  return settings.provider ? { provider: settings.provider() } : { model: `openrouter/${settings.model}` };
}

function description(page: string): string {
  return (JSON.parse(readFileSync(path.join(pageDir(page), 'agent.json'), 'utf8')) as { description: string }).description;
}

async function pageSkills() {
  return (await Promise.all(Object.keys(PAGE_TOOLS).map((page) => loadSkills(path.join(pageDir(page), 'skills'))))).flat();
}

async function buildProduct(tools: readonly DefinedTool[], settings: ArmSettings): Promise<SimpleAgent> {
  const model = modelOption(settings);
  const pages = Object.fromEntries(
    await Promise.all(Object.entries(PAGE_TOOLS).map(async ([page, names]) => [page, await loadAgentDir(pageDir(page), { ...model, tools: pick(tools, names), description: description(page), maxSteps: settings.maxSteps })] as const))
  );
  return loadAgentDir(PRODUCT_DIR, {
    ...model,
    name: 'coding-product',
    tools: pick(tools, LEAD_TOOLS),
    subagents: pages,
    subagentOptions: { background: false },
    maxSteps: settings.maxSteps,
    limits: { maxTokens: settings.maxTokens },
    hooks: settings.hooks,
  });
}

async function buildSingle(arm: ArmName, project: ReturnType<typeof codingAgent>, settings: ArmSettings): Promise<SimpleAgent> {
  const plus = arm === 'flat-plus';
  return createAgent({
    ...modelOption(settings),
    name: arm,
    instructions: plus ? flatPlusInstructions(project.instructions) : project.instructions,
    tools: project.tools,
    ...(plus && { skills: await pageSkills() }),
    maxSteps: settings.maxSteps,
    limits: { maxTokens: settings.maxTokens },
    hooks: settings.hooks,
  });
}

export async function buildArm(arm: ArmName, caseId: string, settings: ArmSettings, seed: Readonly<Record<string, string>> = {}): Promise<Built> {
  const project = codingAgent(seed, PILOT_PROJECT);
  const task = project.tasks.find((candidate) => candidate.id === caseId);
  if (!task) throw new Error(`Unknown case '${caseId}'.`);
  const agent = arm === 'product' ? await buildProduct(project.tools, settings) : await buildSingle(arm, project, settings);
  return { agent, input: task.input, check: () => task.check(''), failure: () => task.failure?.() };
}

export function parseArms(value: string): ArmName[] {
  return value.split(',').map((name) => {
    const arm = ARMS.find((candidate) => candidate === name.trim());
    if (!arm) throw new Error(`--arms takes ${ARMS.join(', ')}, not '${name}'.`);
    return arm;
  });
}
