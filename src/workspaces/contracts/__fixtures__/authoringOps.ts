import type { AuthoringOp } from '../authoringOps';
import type { PageExecution } from '../page';

const agents = [
  { name: 'script-maker', description: 'Writes the script for a short video.', instructions: 'Write a script that fits the requested length.' },
  { name: 'video-maker', description: 'Renders the video from a script.', instructions: 'Render the video the script describes.' },
  { name: 'voice-maker', description: 'Records the voice-over.', instructions: 'Read the script in the requested tone.' },
];

const attachments = [
  { as: 'script', ref: 'workspace:script-maker', role: 'Writes the script.' },
  { as: 'video', ref: 'workspace:video-maker', role: 'Renders the video.' },
  { as: 'voice', ref: 'workspace:voice-maker', role: 'Records the voice-over.' },
];

const inputs = {
  schema: {
    type: 'object',
    properties: { topic: { type: 'string' }, durationSeconds: { type: 'number' }, tone: { type: 'string', enum: ['friendly', 'formal', 'playful'] } },
    required: ['topic'],
  },
};

const outputs = {
  schema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] },
  artifacts: [{ name: 'video', mediaType: 'video/mp4', required: true }],
};

const videoUi = {
  schema: 'lousho.ui/1',
  layout: {
    type: 'stack',
    children: [
      { type: 'text', bind: 'inputs.topic', label: 'Topic' },
      { type: 'number', bind: 'inputs.durationSeconds', label: 'Duration in seconds', min: 5, max: 90 },
      { type: 'select', bind: 'inputs.tone', label: 'Tone' },
      { type: 'runButton' },
      { type: 'runStatus' },
      { type: 'markdown', source: 'outputs.script', label: 'Script' },
      { type: 'artifact', artifact: 'video', label: 'Video' },
    ],
  },
};

function videoPageOps(page: string, name: string, article: string, execution: PageExecution, profile: string, audience: string): AuthoringOp[] {
  return [
    { op: 'create_page', page, name, description: `Makes ${article} ${name} video from a topic.`, execution },
    ...attachments.map((attachment): AuthoringOp => ({ op: 'attach_agent', page, attachment })),
    ...[`workspace:${profile}`, 'workspace:content-types/educational', `workspace:audiences/${audience}`].map((ref): AuthoringOp => ({ op: 'add_extends', page, ref })),
    { op: 'write_harness_prose', target: { kind: 'page', page }, file: 'task.md', text: `Make ${article} ${name} video that teaches the topic in plain words.` },
    { op: 'set_harness_field', page, field: 'audience', value: { description: 'People who follow the brand and want a quick lesson.' } },
    { op: 'set_harness_field', page, field: 'inputs', value: inputs },
    { op: 'set_harness_field', page, field: 'outputs', value: outputs },
    { op: 'set_harness_field', page, field: 'context', value: { resources: ['resources/channel-notes.md'] } },
    { op: 'add_criterion', target: { kind: 'page', page }, criterion: { id: 'script-present', description: 'The output has a non-empty script.', check: 'harness/checks/script-present.ts' } },
    { op: 'write_page_ui', page, ui: videoUi },
  ];
}

const instagramExecution: PageExecution = {
  type: 'workflow',
  workflow: { workflow: 'workspace:video-production' },
  multiAgent: { lead: 'script', delegates: ['video', 'voice'] },
  goal: { lead: 'script', delegates: ['video', 'voice'], goal: './goal.json' },
  onFailure: 'return-to-main',
};

const researchGoal = {
  schema: 'lousho.goal/1',
  goal: 'Find facts that answer the question, each with a source.',
  checks: [{ criterion: 'findings-present' }],
  stop: { maxIterations: 5, maxDurationMs: 600000, maxCostUsd: 2, onStall: 'stop' },
};

const contentResearchOps: AuthoringOp[] = [
  {
    op: 'create_agent',
    name: 'research-lead',
    page: 'content-research',
    description: 'Plans the research and decides when it is done.',
    instructions: 'Plan the questions, delegate the facts, and stop when the findings answer the question.',
  },
  { op: 'attach_agent', page: 'content-research', attachment: { as: 'lead', ref: 'local:research-lead', role: 'Leads the research.' } },
  { op: 'attach_agent', page: 'content-research', attachment: { as: 'script', ref: 'workspace:script-maker', role: 'Looks up facts.' } },
  { op: 'add_extends', page: 'content-research', ref: 'workspace:content-types/educational' },
  { op: 'add_extends', page: 'content-research', ref: 'workspace:audiences/general' },
  { op: 'write_harness_prose', target: { kind: 'page', page: 'content-research' }, file: 'task.md', text: 'Answer the question with findings a video can use, and list the sources.' },
  { op: 'set_harness_field', page: 'content-research', field: 'audience', value: { description: 'Video makers who need facts they can cite.' } },
  { op: 'set_harness_field', page: 'content-research', field: 'inputs', value: { schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } },
  {
    op: 'set_harness_field',
    page: 'content-research',
    field: 'outputs',
    value: { schema: { type: 'object', properties: { findings: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } },
  },
  { op: 'set_harness_field', page: 'content-research', field: 'context', value: { resources: ['resources/research-notes.md'] } },
  {
    op: 'add_criterion',
    target: { kind: 'page', page: 'content-research' },
    criterion: { id: 'findings-present', description: 'The findings are not empty.', check: 'harness/checks/findings-present.ts' },
  },
  {
    op: 'write_page_ui',
    page: 'content-research',
    ui: {
      schema: 'lousho.ui/1',
      layout: {
        type: 'stack',
        children: [
          { type: 'textarea', bind: 'inputs.question', label: 'Question' },
          { type: 'runButton' },
          { type: 'progress' },
          { type: 'markdown', source: 'outputs.findings', label: 'Findings' },
        ],
      },
    },
  },
  { op: 'write_goal', page: 'content-research', goal: researchGoal },
];

export const MARKETING_BUILD_OPS: readonly AuthoringOp[] = [
  {
    op: 'create_workspace',
    id: 'marketing',
    name: 'Marketing',
    version: '1.0.0',
    description: 'Short videos for social channels.',
    domain: 'marketing',
    mainAgent: { dir: './main-agent', inheritsShared: true },
    mainInstructions: 'Route each request to the page that fits it, and ask when the channel is unclear.',
  },
  { op: 'set_workspace_field', field: 'defaults', value: { model: 'mock/mock-model', limits: { maxConcurrentPages: 3, maxCostUsdPerRun: 5 } } },
  { op: 'set_workspace_field', field: 'budget', value: { mode: 'shared' } },
  { op: 'set_workspace_field', field: 'improve', value: { enabled: true, healer: 'shared' } },
  { op: 'write_shared_instruction', file: '00-brand-voice.md', text: 'Friendly, plain and confident.' },
  { op: 'set_base_harness_field', field: 'constraints', value: [{ id: 'brand-voice', text: 'Follow the brand voice.' }] },
  {
    op: 'add_criterion',
    target: { kind: 'base' },
    criterion: { id: 'brand-voice-applied', description: 'The output follows the brand voice.', check: 'checks/brand-voice-applied.ts' },
  },
  { op: 'write_harness_prose', target: { kind: 'base' }, file: 'brand-voice.md', text: 'Write the way the brand speaks.' },
  ...agents.map((agent): AuthoringOp => ({ op: 'create_agent', ...agent })),
  ...videoPageOps('instagram-videos', 'Instagram', 'an', instagramExecution, 'platforms/instagram', 'general'),
  {
    op: 'write_goal',
    page: 'instagram-videos',
    goal: {
      schema: 'lousho.goal/1',
      goal: 'Produce a video the reviewer accepts.',
      checks: [{ criterion: 'script-present' }],
      stop: { maxIterations: 3, maxDurationMs: 600000, maxCostUsd: 2, onStall: 'stop' },
    },
  },
  ...videoPageOps('facebook-videos', 'Facebook', 'a', { type: 'multi-agent', multiAgent: { lead: 'script', delegates: ['video', 'voice'] } }, 'platforms/facebook', 'young-adults'),
  {
    op: 'create_page',
    page: 'content-research',
    name: 'Content research',
    description: 'Researches a topic and returns sourced findings for a video.',
    execution: {
      type: 'goal-oriented',
      goal: { lead: 'lead', delegates: ['script'], goal: './goal.json' },
      limits: { maxDurationMs: 600000, maxCostUsd: 2 },
    },
  },
  ...contentResearchOps,
  {
    op: 'set_main_harness_field',
    field: 'routes',
    value: [
      { page: 'instagram-videos', when: 'The user wants an Instagram video.' },
      { page: 'facebook-videos', when: 'The user wants a Facebook video.' },
      { page: 'content-research', when: 'The user wants research on a topic before making a video.' },
    ],
  },
  {
    op: 'set_main_harness_field',
    field: 'clarify',
    value: { askWhen: ['The channel is not named.', 'The topic is missing.'], runImmediatelyWhen: ['The channel and the topic are both clear.'] },
  },
  { op: 'set_main_harness_field', field: 'presentation', value: { style: 'Short and friendly.', followUps: 'Offer one next step.', revisions: 'Ask what to change.' } },
  { op: 'set_main_harness_field', field: 'limits', value: { maxConcurrentPages: 2 } },
  { op: 'set_main_harness_field', field: 'onPageFailure', value: 'ask' },
  { op: 'write_harness_prose', target: { kind: 'main' }, file: 'routing.md', text: 'Route to the page that matches the channel.' },
];

export const NOT_WRITABLE: readonly RegExp[] = [/^shared\/(brand|policies)\//, /^harness-profiles\//, /^workflows\//, /\/tools\/[^/]+\.ts$/, /\/checks\/[^/]+\.ts$/, /\/resources\/[^/]+\.md$/];

export const normal = (value: unknown): unknown => (typeof value === 'string' ? value.trimEnd() : value);
