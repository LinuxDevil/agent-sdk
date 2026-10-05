/**
 * File contents for the generated project. Pure functions: a
 * {@link ProjectConfig} in, strings out, so every combination is snapshot-testable.
 */
import { AI_RANGES, listProviders, type AiMajor } from '../../providers/providerSpec';
import type { PackageManager, Template } from './options';
import type { SdkManifest } from './sdkDependency';
import { ConfigurationError } from '../../execution/errors';

export interface ProjectConfig {
  /** npm package name (also the directory's base name). */
  name: string;
  provider: string;
  template: Template;
  packageManager: PackageManager;
  /** `dependencies["@lousho/build-ai-agent"]`: a range, or `file:./<tarball>`. */
  sdkDependency: string;
  sdk: SdkManifest;
}

function providerInfo(provider: string) {
  const info = listProviders().find((candidate) => candidate.name === provider);
  if (!info) throw new ConfigurationError(`lousho init: unknown provider '${provider}'.`, 'provider', 'LOUSHO_PROVIDER_UNKNOWN');
  return info;
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The `ai` major a new project gets (LOU-D28d): the current one, 7, for the
 * providers CI runs on it (`@ai-sdk/openai` and `@ai-sdk/anthropic` 4); OpenRouter
 * is one of them since it asks `@ai-sdk/openai` for its Chat Completions model
 * (LOU-D28f). Ollama is on 7 too since LOU-M8: `ollama-ai-provider-v2` is installed and tested in CI
 * (`ai7-zod4`), and needs zod 4 (accepted since LOU-D29), so its scaffold narrows zod to `^4.0.0`.
 */
const SCAFFOLD_AI_MAJOR: Readonly<Record<string, AiMajor>> = { openai: 7, anthropic: 7, openrouter: 7, ollama: 7, pi: 7 };

/** `ai` and only the chosen provider's package (the SDK loads provider packages on first use), as one pairing. */
function aiPackages(provider: string): Record<string, string> {
  const major = SCAFFOLD_AI_MAJOR[provider] ?? 4;
  const { name, range } = providerInfo(provider).peers[major];
  return { ai: AI_RANGES[major], [name]: range };
}

/**
 * The SDK's zod range, narrowed to the one major the scaffolded provider packages peer on:
 * zod 3 for `ai` 4 (LOU-D29), zod 4 for Ollama's `ai` 6/7 package (LOU-M8).
 */
function zodRange(peerRange: string | undefined, provider: string): string {
  const range = peerRange ?? '^3.25.76';
  const alternatives = range.split('||').map((part) => part.trim());
  if ((SCAFFOLD_AI_MAJOR[provider] ?? 4) === 4) return alternatives[0]!;
  return provider === 'ollama' ? (alternatives.find((part) => part.startsWith('^4')) ?? '^4.0.0') : range;
}

function packageJson(config: ProjectConfig): string {
  const peers = config.sdk.peerDependencies ?? {};
  const yaml = config.template === 'yaml';
  const pkg = {
    name: config.name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: yaml ? 'lousho dev agent.yaml' : 'tsx --env-file-if-exists=.env src/index.ts',
      test: 'vitest run',
      typecheck: 'tsc --noEmit',
      doctor: yaml ? 'lousho doctor agent.yaml' : 'lousho doctor',
    },
    dependencies: sortKeys({
      '@lousho/build-ai-agent': config.sdkDependency,
      zod: zodRange(peers.zod, config.provider),
      ...aiPackages(config.provider),
    }),
    devDependencies: {
      '@types/node': '^22.0.0',
      tsx: '^4.19.0',
      typescript: '^5.6.0',
      vitest: '^3.2.4',
    },
    engines: { node: '>=22.19.0' },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function tsconfig(): string {
  const options = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2022'],
      strict: true,
      noUncheckedIndexedAccess: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      types: ['node'],
    },
    include: ['src'],
  };
  return JSON.stringify(options, null, 2) + '\n';
}

const TIME_TOOL = `/** An example tool: the model calls it when it needs the current date or time. */
export const currentTime = defineTool({
  name: 'current_time',
  description: 'Get the current date and time, optionally in an IANA time zone.',
  input: z.object({
    timeZone: z.string().optional().describe('IANA time zone, e.g. "Europe/Paris". Defaults to UTC.'),
  }),
  execute: async ({ timeZone }) => ({ now: new Date().toLocaleString('en-US', { timeZone: timeZone ?? 'UTC' }) }),
});`;

const EXTRA_TOOLS = `

/** Rolls an n-sided die. */
export const rollDie = defineTool({
  name: 'roll_die',
  description: 'Roll a die with the given number of sides and return the result.',
  input: z.object({ sides: z.number().int().min(2).max(1000).default(6) }),
  execute: async ({ sides }) => ({ sides, result: 1 + Math.floor(Math.random() * sides) }),
});

/** Counts the words in a piece of text. */
export const wordCount = defineTool({
  name: 'word_count',
  description: 'Count the words in a piece of text.',
  input: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ words: text.split(/\\s+/).filter(Boolean).length }),
});`;

function toolNames(template: Template): string[] {
  return template === 'tools' ? ['currentTime', 'rollDie', 'wordCount'] : ['currentTime'];
}

function agentSource(config: ProjectConfig): string {
  const info = providerInfo(config.provider);
  const extra = config.template === 'tools' ? EXTRA_TOOLS : '';
  return `import { createAgent, defineTool, type LLMProvider } from '@lousho/build-ai-agent';
import { z } from 'zod';

${TIME_TOOL}${extra}

const instructions = 'You are a helpful assistant. Use your tools when they help.';
const tools = [${toolNames(config.template).join(', ')}];

/**
 * The agent. \`createAgent({ model, instructions })\` is the whole idea; the
 * optional \`provider\` lets tests swap in a scripted model (see agent.test.ts).
 */
export function buildAgent(provider?: LLMProvider) {
  return provider
    ? createAgent({ provider, instructions, tools })
    : createAgent({ model: '${config.provider}/${info.defaultModel}', instructions, tools });
}
`;
}

function indexSource(): string {
  return `import { createInterface } from 'node:readline/promises';
import { buildAgent } from './agent.js';

const agent = buildAgent();
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on('close', () => process.exit(0));

console.log('Chat with your agent. Press Ctrl+C to quit.');
for (;;) {
  const message = (await rl.question('you> ')).trim();
  if (message) console.log(\`agent> \${(await agent.send(message)).text}\`);
}
`;
}

function testSource(): string {
  return `import { describe, expect, it } from 'vitest';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { buildAgent } from './agent.js';

// mockModel scripts the model turn by turn: no network and no API key needed.
describe('agent', () => {
  it('replies with the scripted answer', async () => {
    const model = mockModel(['Hello from the mock model!']);

    const { text } = await buildAgent(model).send('Hi');

    expect(text).toBe('Hello from the mock model!');
    model.assertExhausted();
  });

  it('calls the current_time tool and answers with its result', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'current_time', args: { timeZone: 'UTC' } }] },
      { text: 'It is time for lunch.' },
    ]);

    const { text } = await buildAgent(model).send('What time is it?');

    expect(text).toBe('It is time for lunch.');
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
  });
});
`;
}

function yamlTestSource(config: ProjectConfig): string {
  return `import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSpec } from '@lousho/build-ai-agent';
import { ConfigurationError } from '../../execution/errors';

describe('agent.yaml', () => {
  it('is a valid agent spec', () => {
    const spec = loadSpec(fileURLToPath(new URL('../agent.yaml', import.meta.url)));

    expect(spec.name).toBe('${config.name}');
    expect(spec.provider.type).toBe('${config.provider}');
    expect(spec.tools).toContain('current-date');
  });
});
`;
}

function agentYaml(config: ProjectConfig): string {
  return `name: ${config.name}
prompt: You are a helpful assistant. Use your tools when they help.
provider:
  type: ${config.provider}
  model: ${providerInfo(config.provider).defaultModel}
tools:
  - current-date
`;
}

function envExample(config: ProjectConfig): string {
  const info = providerInfo(config.provider);
  const hint = info.envForInfoOnly
    ? 'credential of the nested provider you use (e.g. OPENROUTER_API_KEY for pi/openrouter/...)'
    : info.envRequired
      ? 'API key'
      : 'base URL (optional, defaults to http://localhost:11434)';
  return `# ${config.provider} ${hint}\n${info.envKey}=\n`;
}

const GITIGNORE = `node_modules
dist
.env
.env.*
!.env.example
*.log
.lousho/
`;

function run(pm: PackageManager, script: string): string {
  return `${pm} run ${script}`;
}

function readme(config: ProjectConfig): string {
  const pm = config.packageManager;
  const info = providerInfo(config.provider);
  const yaml = config.template === 'yaml';
  const files = yaml
    ? '- `agent.yaml` - the agent: prompt, provider and tools\n- `src/agent.test.ts` - checks the spec loads, offline'
    : '- `src/agent.ts` - the agent and an example tool\n- `src/agent.test.ts` - tests with a scripted model, offline\n- `src/index.ts` - a tiny terminal chat';
  return `# ${config.name}

An agent built with [@lousho/build-ai-agent](https://github.com/LinuxDevil/agent-sdk).

## Next 3 commands

\`\`\`bash
cp .env.example .env     # then put your ${info.envKey} in .env${yaml ? ' (or export it)' : ''}
${run(pm, 'dev')}${yaml ? '          # chat UI with hot reload' : '          # chat with the agent in your terminal'}
${run(pm, 'test')}         # offline tests, no API key needed
\`\`\`

Run \`${run(pm, 'doctor')}\` if something does not work: it checks Node, packages and API keys.

## What is here

${files}
- \`.env.example\` - the environment variable your provider needs

Docs: https://github.com/LinuxDevil/agent-sdk/blob/main/docs/quick-start.md
`;
}

/** Every file of the project, keyed by its path relative to the project directory. */
export function renderProject(config: ProjectConfig): Record<string, string> {
  const yaml = config.template === 'yaml';
  const files: Record<string, string> = {
    'package.json': packageJson(config),
    'tsconfig.json': tsconfig(),
    '.gitignore': GITIGNORE,
    '.env.example': envExample(config),
    'README.md': readme(config),
    'src/agent.test.ts': yaml ? yamlTestSource(config) : testSource(),
  };
  if (yaml) {
    files['agent.yaml'] = agentYaml(config);
  } else {
    files['src/agent.ts'] = agentSource(config);
    files['src/index.ts'] = indexSource();
  }
  return files;
}
