import type { AuthoringOp } from './authoringOps';
import type { PageExecution } from './page';

const workflow = {
  code: 'instagram-videos',
  name: 'Instagram videos',
  flow: {
    type: 'sequence',
    id: 'build',
    steps: [
      { type: 'agent', id: 'write-script', agent: 'script' },
      { type: 'agent', id: 'make-video', agent: 'video' },
      { type: 'agent', id: 'make-voice', agent: 'voice' },
      { type: 'end', id: 'done' },
    ],
  },
};

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

const inputs = { schema: { type: 'object', properties: { topic: { type: 'string' }, durationSeconds: { type: 'number' }, tone: { type: 'string' } }, required: ['topic'] } };

const outputs = { schema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] }, artifacts: [{ name: 'video', mediaType: 'video/mp4', required: true }] };

function pageOps(page: string, name: string, execution: PageExecution, profile: string): AuthoringOp[] {
  return [
    { op: 'create_page', page, name, description: `Makes a ${name} video from a topic.`, execution },
    ...attachments.map((attachment): AuthoringOp => ({ op: 'attach_agent', page, attachment })),
    { op: 'add_extends', page, ref: profile },
    { op: 'write_harness_prose', target: { kind: 'page', page }, file: 'task.md', text: `Make a ${name} video that teaches the topic in plain words.` },
    { op: 'set_harness_field', page, field: 'audience', value: { description: 'People who follow the brand and want a quick lesson.' } },
    { op: 'set_harness_field', page, field: 'inputs', value: inputs },
    { op: 'set_harness_field', page, field: 'outputs', value: outputs },
    { op: 'add_criterion', target: { kind: 'page', page }, criterion: { id: 'script-present', description: 'The output has a non-empty script.', check: 'output.script.length > 0' } },
    { op: 'write_page_ui', page, ui: { schema: 'lousho.page-ui/1', root: { type: 'stack', children: [{ type: 'text-input', bind: 'inputs.topic' }, { type: 'video', bind: 'outputs.video' }] } } },
  ];
}

export const MARKETING_BUILD_OPS: readonly AuthoringOp[] = [
  { op: 'create_workspace', id: 'marketing', name: 'Marketing', description: 'Short videos for social channels.', domain: 'marketing', mainAgent: { dir: './main-agent' } },
  { op: 'write_shared_instruction', file: '00-brand-voice.md', text: 'Friendly, plain and confident.' },
  { op: 'set_base_harness_field', field: 'constraints', value: [{ id: 'brand-voice', text: 'Follow the brand voice.' }] },
  { op: 'write_harness_prose', target: { kind: 'base' }, file: 'voice.md', text: 'Write the way the brand speaks.' },
  ...agents.map((agent): AuthoringOp => ({ op: 'create_agent', ...agent })),
  ...pageOps('instagram-videos', 'Instagram', { type: 'workflow', workflow: { workflow: './workflow.json' } }, 'platforms/instagram'),
  { op: 'write_workflow', page: 'instagram-videos', workflow },
  ...pageOps('facebook-videos', 'Facebook', { type: 'multi-agent', multiAgent: { lead: 'script', delegates: ['video', 'voice'] } }, 'platforms/facebook'),
  { op: 'set_main_harness_field', field: 'presentation', value: { style: 'Short and friendly.', followUps: 'Offer one next step.', revisions: 'Ask what to change.' } },
  { op: 'set_main_harness_field', field: 'routes', value: [{ page: 'instagram-videos', when: 'The user wants an Instagram video.' }, { page: 'facebook-videos', when: 'The user wants a Facebook video.' }] },
  { op: 'write_harness_prose', target: { kind: 'main' }, file: 'routing.md', text: 'Route to the page that matches the channel.' },
  { op: 'reorder_pages', pages: ['facebook-videos', 'instagram-videos'] },
];
