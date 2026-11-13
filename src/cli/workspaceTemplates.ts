export const WORKSPACE_TEMPLATES = ['blank', 'marketing', 'coding'] as const;

export type WorkspaceTemplate = (typeof WORKSPACE_TEMPLATES)[number];

export const OUTPUT_CHECK_NAME = 'output-present';

interface PageSpec {
  id: string;
  name: string;
  description: string;
  agent: string;
  agentInstructions: string;
  input: string;
  output: string;
  task: string;
}

interface TemplateSpec {
  domain: string;
  description: string;
  shared: Record<string, string>;
  pages: PageSpec[];
}

const TEMPLATES: Record<WorkspaceTemplate, TemplateSpec> = {
  blank: {
    domain: 'general',
    description: 'A starting point with one page.',
    shared: {},
    pages: [
      {
        id: 'hello',
        name: 'Hello',
        description: 'Answers a request in a short reply.',
        agent: 'helper',
        agentInstructions: 'Answer the request in two or three sentences.',
        input: 'request',
        output: 'reply',
        task: 'Answer the request.',
      },
    ],
  },
  marketing: {
    domain: 'marketing',
    description: 'Research and scripts for short social videos.',
    shared: { 'shared/instructions/00-brand-voice.md': 'Write in a warm, direct voice. Short sentences. No jargon.\n' },
    pages: [
      {
        id: 'content-research',
        name: 'Content research',
        description: 'Researches a topic and returns findings for a video.',
        agent: 'researcher',
        agentInstructions: 'Find facts that answer the question and say where each came from.',
        input: 'question',
        output: 'findings',
        task: 'Answer the question with sourced findings.',
      },
      {
        id: 'video-script',
        name: 'Video script',
        description: 'Writes a short video script for a topic.',
        agent: 'script-maker',
        agentInstructions: 'Write a script of under 60 seconds with a hook, a body and a call to action.',
        input: 'topic',
        output: 'script',
        task: 'Write the script for the topic.',
      },
    ],
  },
  coding: {
    domain: 'coding',
    description: 'Investigate and review code changes.',
    shared: { 'shared/instructions/00-house-rules.md': 'Cite the file and line behind every claim. Say so when you are unsure.\n' },
    pages: [
      {
        id: 'investigate',
        name: 'Investigate',
        description: 'Finds the likely cause of a reported problem.',
        agent: 'investigator',
        agentInstructions: 'Read the report and name the most likely cause with the evidence for it.',
        input: 'report',
        output: 'cause',
        task: 'Find the likely cause of the report.',
      },
      {
        id: 'review',
        name: 'Review',
        description: 'Reviews a change and lists what to fix.',
        agent: 'reviewer',
        agentInstructions: 'Review the change and list each problem with a suggested fix.',
        input: 'change',
        output: 'review',
        task: 'Review the change.',
      },
    ],
  },
};

const OUTPUT_CHECK_SOURCE = `export default {
  evaluate: (output: Record<string, unknown>) => {
    const passed = Object.values(output).some((value) => typeof value === 'string' && value.trim().length > 0);
    return { score: passed ? 1 : 0, passed, threshold: 1, message: passed ? undefined : 'output has no non-empty text field' };
  },
};
`;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stringField(name: string): unknown {
  return { type: 'object', properties: { [name]: { type: 'string' } }, required: [name] };
}

function pageFiles(page: PageSpec): Record<string, string> {
  const dir = `pages/${page.id}`;
  return {
    [`${dir}/page.json`]: json({
      schema: 'lousho.page/1',
      id: page.id,
      name: page.name,
      description: page.description,
      harness: { extends: [] },
      execution: { type: 'single', single: { agent: 'agent' } },
    }),
    [`${dir}/agents.json`]: json({ schema: 'lousho.agents/1', agents: [{ as: 'agent', ref: `workspace:${page.agent}`, role: page.description }] }),
    [`${dir}/harness/harness.json`]: json({
      schema: 'lousho.harness/1',
      instructions: ['harness/task.md'],
      inputs: { schema: stringField(page.input) },
      outputs: { schema: stringField(page.output) },
      evaluation: { criteria: [{ id: OUTPUT_CHECK_NAME, description: `The ${page.output} is not empty.`, check: `harness/checks/${OUTPUT_CHECK_NAME}.ts` }] },
    }),
    [`${dir}/harness/task.md`]: `${page.task}\n`,
    [`${dir}/harness/checks/${OUTPUT_CHECK_NAME}.ts`]: OUTPUT_CHECK_SOURCE,
    [`agents/${page.agent}/agent.json`]: json({ name: page.agent, version: '1.0.0', description: page.description }),
    [`agents/${page.agent}/instructions.md`]: `${page.agentInstructions}\n`,
  };
}

/** The files of a new workspace from a template, keyed by workspace-relative path; it never includes a page UI file, so every page gets the default UI. */
export function workspaceTemplateFiles(template: WorkspaceTemplate, id: string, name: string): Record<string, string> {
  const spec = TEMPLATES[template];
  const routes = spec.pages.map((page) => `${page.id}: ${page.description}`).join('\n');
  return {
    'workspace.json': json({
      schema: 'lousho.workspace/1',
      id,
      name,
      version: '1.0.0',
      description: spec.description,
      domain: spec.domain,
      mainAgent: { dir: './main-agent' },
      pages: spec.pages.map((page) => page.id),
    }),
    'main-agent/agent.json': json({ name: 'main', version: '1.0.0', description: `Routes work in ${name}.` }),
    'main-agent/instructions.md': `Route each request to the page that fits it, or answer it yourself.\n${routes}\n`,
    ...spec.shared,
    ...Object.assign({}, ...spec.pages.map(pageFiles)),
  };
}
