import { createHash } from 'node:crypto';
import { ValidationError } from '../../execution/errors';
import type { RunLimits } from '../../execution/budget';
import type { ReasoningEffort } from '../../providers/reasoning';
import type { Attachment } from '../contracts/agentRefs';
import type { EffectiveHarness } from '../contracts/compose';
import type { MainHarness } from '../contracts/mainHarness';
import type { AgentOwned } from './agentDirView';
import type { ResolvedAttachment } from './resolveAgents';
import type { HarnessFiles } from './resolveHarness';
import type { SharedContext, SharedResource } from './sharedContext';

/** One section of an assembled prompt. */
export interface AssembledSection {
  /** `agent`, `shared`, `harness`, `role` or `engine` for an attachment; `agent`, `shared` or `routing` for the main agent. */
  id: string;
  /** The section's text with its heading; empty when the section has nothing to say. */
  text: string;
}

/** A section with where its text came from. */
export interface ExplainedSection extends AssembledSection {
  /** The layers and files the text came from. */
  provenance: string[];
}

/** An assembled prompt. */
export interface AssembledInstructions {
  /** The whole prompt: every non-empty section joined by a blank line. */
  text: string;
  /** The sections in their fixed order, empty ones included. */
  sections: AssembledSection[];
  /** sha256 hex of `text`. */
  hash: string;
  /** Sections 1 to 4 joined; the same for one attachment under every execution type. */
  harnessPart: string;
  /** sha256 hex of `harnessPart`; engine framing is never part of it. */
  harnessPartHash: string;
  /** The sections with where each came from, for the effective-context preview. */
  explain(): ExplainedSection[];
}

/** An assembled main-agent prompt. */
export interface AssembledMainInstructions {
  /** The whole prompt: every non-empty section joined by a blank line. */
  text: string;
  /** The sections in their fixed order. */
  sections: AssembledSection[];
  /** sha256 hex of `text`. */
  hash: string;
  /** The sections with where each came from. */
  explain(): ExplainedSection[];
}

/** The file an agent's instructions text came from: `instructions.md` or a config file's `instructions` field. */
export type InstructionsSource = 'instructions.md' | 'agent.json' | 'agent.yaml' | 'agent.yml';

/** What {@link assembleInstructions} reads. */
export interface AssembleInstructionsInput {
  /** What the agent owns; its instructions are section 1. */
  agent: AgentOwned;
  /** The agent's folder, for provenance; defaults to `agents/<name>`. */
  agentDir?: string;
  /** Where the instructions text came from: `instructions.md` (default) or the `instructions` field of the named config file. */
  instructionsSource?: InstructionsSource;
  /** The shared layer for the page; section 2, left out when absent or empty. */
  shared?: SharedContext;
  /** The page's effective harness; section 3. */
  harness: EffectiveHarness;
  /** The page's attachment of the agent; its role is section 4. */
  attachment: Attachment;
  /** The page the agent runs on. */
  page: { id: string; name: string };
  /** The real harness.json paths for the provenance labels; defaults to `harness/harness.json` and `pages/<id>/harness/harness.json`. */
  harnessFiles?: Partial<HarnessFiles>;
  /** The engine's own prompt text, section 5; empty for `single`. */
  engineFraming?: string;
}

/** A page as the main agent's prompt lists it. */
export interface MainPageInfo {
  /** The page id. */
  id: string;
  /** The page's display name. */
  name: string;
  /** What the page does. */
  description: string;
}

/** A main-agent harness with the text of the prose files it lists. */
export interface MainHarnessInput {
  /** The parsed `main-harness.json`. */
  harness: MainHarness;
  /** The main-agent harness folder, from `workspace.json` `mainAgent.harness`; defaults to `main-agent/harness`. */
  dir?: string;
  /** File text keyed by the full tree path (`main-agent/harness/<file>`), or by the name in `harness.instructions`; a listed file with no text is an error. */
  texts: Readonly<Record<string, string>>;
}

/** What {@link assembleMainInstructions} reads. */
export interface AssembleMainInput {
  /** The main agent's own files; its instructions are section 1. */
  mainAgent: Pick<AgentOwned, 'instructions'> & { instructionsSource?: InstructionsSource };
  /** The shared layer, resolved for `main-agent`; it is empty unless the manifest view's `inheritsShared` is true. */
  shared?: SharedContext;
  /** The main-agent harness; without it the prompt lists every page description. */
  mainHarness?: MainHarnessInput;
  /** Every page of the workspace. */
  pages: readonly MainPageInfo[];
}

/** The `createAgent` options an attachment's harness and limits map to. */
export interface AgentRunOptions {
  /** The model spec, when a level sets one. */
  model?: string;
  /** Reasoning effort from the harness model hints. */
  reasoning?: ReasoningEffort;
  /** Sampling settings from the harness model hints. */
  modelSettings?: { temperature: number };
  /** The smallest of the agent's, the attachment's and the harness's limits. */
  limits: RunLimits;
}

interface Part extends AssembledSection {
  provenance: string[];
}

const SHARED_HEADING = '## Workspace rules';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function join(parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join('\n\n');
}

function explainer(parts: readonly Part[]): () => ExplainedSection[] {
  return () => parts.map((part) => ({ id: part.id, text: part.text, provenance: [...part.provenance] }));
}

function resourceBlock(resource: SharedResource): string {
  return `### ${resource.ref}\n\n${resource.text ?? ''}`;
}

function notInlined(resources: readonly SharedResource[]): string {
  if (resources.length === 0) return '';
  return join(['### Available on request', resources.map((item) => `- ${item.ref} (${item.bytes} bytes, not inlined)`).join('\n')]);
}

function sharedPart(shared: SharedContext | undefined): Part {
  const instructions = shared?.instructions ?? [];
  const resources = shared?.resources ?? [];
  const inlined = resources.filter((item) => item.inlined);
  const body = join([...instructions.map((item) => item.text.trim()), ...inlined.map(resourceBlock), notInlined(resources.filter((item) => !item.inlined))]);
  if (body === '') return { id: 'shared', text: '', provenance: [] };
  return { id: 'shared', text: `${SHARED_HEADING}\n\n${body}`, provenance: [...instructions.map((item) => item.file), ...resources.map((item) => item.path)] };
}

function bullet(label: string, value: unknown): string {
  return `- ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
}

function audienceBlock(audience: EffectiveHarness['audience']): string {
  if (!audience) return '';
  const traits = Object.entries(audience.traits ?? {}).map(([key, value]) => bullet(key, value));
  return join(['### Audience', [audience.description, ...traits].join('\n')]);
}

function platformBlock(platform: EffectiveHarness['platform']): string {
  if (!platform) return '';
  const requirements = Object.entries(platform.requirements ?? {}).map(([key, value]) => bullet(key, value));
  return join(['### Platform', [platform.id, ...requirements].join('\n')]);
}

function constraintsBlock(constraints: EffectiveHarness['constraints']): string {
  if (!constraints || constraints.length === 0) return '';
  return join(['### Constraints', constraints.map((item) => `- ${item.text}`).join('\n')]);
}

function schemaSummary(schema: unknown): string {
  if (typeof schema === 'string') return `The result follows the schema in ${schema}.`;
  const record = (schema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
  const names = Object.keys(record.properties ?? {});
  if (names.length === 0) return 'The result follows a JSON schema.';
  const required = new Set(record.required ?? []);
  return `The result has these fields: ${names.map((name) => (required.has(name) ? `${name} (required)` : name)).join(', ')}.`;
}

function outputsBlock(outputs: EffectiveHarness['outputs']): string {
  if (!outputs) return '';
  const lines = [...(outputs.schema === undefined ? [] : [schemaSummary(outputs.schema)])];
  const artifacts = (outputs.artifacts ?? []).map((artifact) => `- ${artifact.name} (${artifact.mediaType}${artifact.required === true ? ', required' : ''})`);
  if (artifacts.length > 0) lines.push('Artifacts:', ...artifacts);
  return lines.length === 0 ? '' : join(['### Output contract', lines.join('\n')]);
}

function resourcesBlock(context: EffectiveHarness['context']): string {
  const resources = context?.resources ?? [];
  return resources.length === 0 ? '' : join(['### Resources', resources.map((item) => `- ${item}`).join('\n')]);
}

function harnessPart(harness: EffectiveHarness, page: { id: string; name: string }, files: Partial<HarnessFiles> | undefined): Part {
  const text = join([
    `## Task environment: ${page.name}`,
    harness.instructions.trim(),
    audienceBlock(harness.audience),
    platformBlock(harness.platform),
    constraintsBlock(harness.constraints),
    outputsBlock(harness.outputs),
    resourcesBlock(harness.context),
  ]);
  return { id: 'harness', text, provenance: harness.sources.map((label) => layerFile(label, page.id, files)) };
}

function instructionsFile(dir: string, source: InstructionsSource | undefined): string {
  return source === undefined || source === 'instructions.md' ? `${dir}/instructions.md` : `${dir}/${source}#instructions`;
}

function layerFile(label: string, pageId: string, files: Partial<HarnessFiles> | undefined): string {
  if (label === 'workspace base') return files?.base ?? 'harness/harness.json';
  return label === 'page' ? (files?.page ?? `pages/${pageId}/harness/harness.json`) : label;
}

function agentPart(input: AssembleInstructionsInput): Part {
  const text = input.agent.instructions?.trim() ?? '';
  const dir = input.agentDir ?? `agents/${input.agent.name}`;
  return { id: 'agent', text, provenance: text === '' ? [] : [instructionsFile(dir, input.instructionsSource)] };
}

function rolePart(attachment: Attachment, pageId: string): Part {
  const role = attachment.role?.trim() ?? '';
  if (role === '') return { id: 'role', text: '', provenance: [] };
  return { id: 'role', text: `## Your role on this page\n\n${role}`, provenance: [`pages/${pageId}/agents.json#${attachment.as}.role`] };
}

function enginePart(framing: string | undefined): Part {
  const text = framing?.trim() ?? '';
  return text === '' ? { id: 'engine', text: '', provenance: [] } : { id: 'engine', text: `## How this page runs\n\n${text}`, provenance: ['engine'] };
}

function strip(part: Part): AssembledSection {
  return { id: part.id, text: part.text };
}

/** Assembles an attachment's instructions in a fixed order: the agent's own, `## Workspace rules`, `## Task environment: <page name>`, `## Your role on this page`, then the engine's `## How this page runs`. Sections 1 to 4 are the `harnessPart`, which the engine never changes. Pure: it reads its inputs and writes nothing. */
export function assembleInstructions(input: AssembleInstructionsInput): AssembledInstructions {
  const harnessSide = [agentPart(input), sharedPart(input.shared), harnessPart(input.harness, input.page, input.harnessFiles), rolePart(input.attachment, input.page.id)];
  const parts = [...harnessSide, enginePart(input.engineFraming)];
  const harnessText = join(harnessSide.map((part) => part.text));
  const text = join(parts.map((part) => part.text));
  return { text, sections: parts.map(strip), hash: sha256(text), harnessPart: harnessText, harnessPartHash: sha256(harnessText), explain: explainer(parts) };
}

function routesBlock(harness: MainHarness | undefined, pages: readonly MainPageInfo[]): string {
  if (harness?.routes === undefined) return pages.length === 0 ? '' : join(['### Pages', pages.map((page) => `- ${page.id}: ${page.description}`).join('\n')]);
  if (harness.routes.length === 0) return '';
  return join(['### Routes', harness.routes.map((route) => `- ${route.page}: ${route.when}`).join('\n')]);
}

function clarifyBlock(clarify: MainHarness['clarify']): string {
  if (!clarify) return '';
  const lines = [...clarify.askWhen.map((item) => `- Ask first when: ${item}`), ...clarify.runImmediatelyWhen.map((item) => `- Run at once when: ${item}`)];
  return lines.length === 0 ? '' : join(['### Clarifying', lines.join('\n')]);
}

function presentationBlock(presentation: MainHarness['presentation']): string {
  if (!presentation) return '';
  return join(['### Presenting results', [`- Style: ${presentation.style}`, `- Follow-ups: ${presentation.followUps}`, `- Revisions: ${presentation.revisions}`].join('\n')]);
}

function failureBlock(onPageFailure: MainHarness['onPageFailure']): string {
  return onPageFailure === undefined ? '' : join(['### When a page fails', `Policy: ${onPageFailure}.`]);
}

const DEFAULT_MAIN_HARNESS_DIR = 'main-agent/harness';

const mainDir = (input: MainHarnessInput): string => input.dir?.replace(/\/+$/, '') ?? DEFAULT_MAIN_HARNESS_DIR;

function proseText(input: MainHarnessInput, file: string): string {
  const text = input.texts[`${mainDir(input)}/${file}`] ?? input.texts[file];
  if (text === undefined) throw new ValidationError(`main harness lists instruction '${file}', but no text was given for ${mainDir(input)}/${file}`, undefined, 'LOUSHO_WORKSPACE_MAIN_HARNESS_TEXT_MISSING');
  return text.trim();
}

function mainProse(input: MainHarnessInput | undefined): { text: string; files: string[] } {
  if (input === undefined) return { text: '', files: [] };
  const files = input.harness.instructions ?? [];
  return { text: join(files.map((file) => proseText(input, file))), files: files.map((file) => `${mainDir(input)}/${file}`) };
}

function routingPart(input: AssembleMainInput): Part {
  const harness = input.mainHarness?.harness;
  const prose = mainProse(input.mainHarness);
  const text = join([
    '## How to route and respond',
    prose.text,
    routesBlock(harness, input.pages),
    clarifyBlock(harness?.clarify),
    presentationBlock(harness?.presentation),
    failureBlock(harness?.onPageFailure),
  ]);
  const dir = input.mainHarness === undefined ? DEFAULT_MAIN_HARNESS_DIR : mainDir(input.mainHarness);
  const provenance = harness === undefined ? ['default routing prompt'] : [`${dir}/main-harness.json`, ...prose.files];
  return { id: 'routing', text, provenance };
}

function mainAgentPart(mainAgent: AssembleMainInput['mainAgent']): Part {
  const text = mainAgent.instructions?.trim() ?? '';
  return { id: 'agent', text, provenance: text === '' ? [] : [instructionsFile('main-agent', mainAgent.instructionsSource)] };
}

/** Assembles the main agent's prompt: its own instructions, the shared context when it inherits it, then the routing section built from the main-agent harness or, with none, from every page's description. */
export function assembleMainInstructions(input: AssembleMainInput): AssembledMainInstructions {
  const parts = [mainAgentPart(input.mainAgent), sharedPart(input.shared), routingPart(input)];
  const text = join(parts.map((part) => part.text));
  return { text, sections: parts.map(strip), hash: sha256(text), explain: explainer(parts) };
}

function smallest(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.min(...present);
}

function combinedLimits(own: RunLimits | undefined, attached: Attachment['limits'], hinted: NonNullable<EffectiveHarness['runtime']>['limits']): RunLimits {
  const limits: RunLimits = { ...own };
  const steps = smallest([own?.maxSteps, attached?.maxTurns, hinted?.maxTurns]);
  const duration = smallest([own?.maxDurationMs, attached?.maxDurationMs, hinted?.maxDurationMs]);
  const cost = smallest([own?.maxCostUsd, attached?.maxCostUsd, hinted?.maxCostUsd]);
  if (steps !== undefined) limits.maxSteps = steps;
  if (duration !== undefined) limits.maxDurationMs = duration;
  if (cost !== undefined) limits.maxCostUsd = cost;
  return limits;
}

/** Maps a resolved attachment and its effective harness to `createAgent` options: the resolved model, the harness model hints, and limits that take the smallest of the agent's, the attachment's and the harness's. */
export function agentRunOptions(attachment: ResolvedAttachment, harness: EffectiveHarness): AgentRunOptions {
  const hints = harness.runtime?.modelHints;
  return {
    ...(attachment.model.model !== undefined && { model: attachment.model.model }),
    ...(hints?.reasoning !== undefined && { reasoning: hints.reasoning }),
    ...(hints?.temperature !== undefined && { modelSettings: { temperature: hints.temperature } }),
    limits: combinedLimits(attachment.agentOwned.limits, attachment.pageOwned.limits, harness.runtime?.limits),
  };
}
