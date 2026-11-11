import { SDKError, ValidationError } from '../../execution/errors';
import type { MemorySlot } from '../../memory/defineMemory';
import { skillFromText } from '../../skills/loadSkills';
import type { Skill } from '../../skills/defineSkill';
import { INHERITANCE_RULES, SHARED_PATH_PATTERNS, orderInstructionFiles, type SharedFolder } from '../contracts/shared';
import type { LoadedWorkspace } from './loadWorkspace';

const DEFAULT_MAX_RESOURCE_BYTES = 256 * 1024;
const RESOURCE_PATH = /^shared\/(?:knowledge|brand|resources)\/.+$/;
const encoder = new TextEncoder();

/** One shared instruction file. */
export interface SharedInstruction {
  /** The workspace-relative path. */
  file: string;
  /** The file's text. */
  text: string;
}

/** One skill and the file that defines it. */
export interface SharedSkill {
  /** The workspace-relative path of the skill's `SKILL.md`, or the label the caller gave it. */
  file: string;
  /** The parsed skill. */
  skill: Skill;
}

interface SharedMemoryFile {
  name: string;
  file: string;
  source: string;
}

/** One shared memory slot. */
export interface SharedMemorySlot extends SharedMemoryFile {
  /** The slot; the same object for every caller that passes the same run. */
  slot: MemorySlot;
}

/** A `shared:<path>` file as a read-only handle. */
export interface SharedResource {
  /** The `shared:<folder>/<path>` reference. */
  ref: string;
  /** The workspace-relative path. */
  path: string;
  /** The file's size in UTF-8 bytes. */
  bytes: number;
  /** Whether `text` is present; false when the file is over `maxResourceBytes`. */
  inlined: boolean;
  /** The file's text, only when it is inlined. */
  text?: string;
}

/** The shared layer that reaches one page or the main agent. */
export interface SharedContext {
  /** Shared instruction files in file-name order. */
  instructions: SharedInstruction[];
  /** The union of shared skills and the skills passed in. */
  skills: SharedSkill[];
  /** The shared slots; a page's private memory is its agents' own. */
  memorySlots: SharedMemorySlot[];
  /** Every file under `shared/knowledge`, `shared/brand` and `shared/resources`, by path. */
  resources: SharedResource[];
}

/** The state one workspace run shares between its pages: the shared memory instances. */
export interface SharedContextRun {
  /** Shared memory slots by file path. */
  readonly memory: Map<string, MemorySlot>;
}

/** Who the context is for: a page by id, or the main agent. */
type SharedAudience = { page: string } | 'main-agent';

/** Options of {@link resolveSharedContext}. */
export interface ResolveSharedContextOptions {
  /** Who the context is for; without it only the workspace-wide shared layer is returned. */
  audience?: SharedAudience;
  /** The run whose shared memory instances are reused; required when the workspace has shared memory files. */
  run?: SharedContextRun;
  /** Largest file text, in UTF-8 bytes, that is inlined; defaults to 256 KiB. */
  maxResourceBytes?: number;
  /** Lets a skill from `skills` replace a shared skill of the same name instead of failing. */
  override?: boolean;
  /** More skills (an agent's own) to union with the shared ones; they come after, so they can win with `override`. */
  skills?: readonly SharedSkill[];
  /** Builds the slot for a memory file; required when the workspace has shared memory files, because the core never runs them. */
  createMemory?: (file: SharedMemoryFile) => MemorySlot;
}

/** Makes the object that holds one workspace run's shared memory instances. */
export function createSharedContextRun(): SharedContextRun {
  return { memory: new Map() };
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
}

function pathsMatching(workspace: LoadedWorkspace, pattern: RegExp): string[] {
  return Object.keys(workspace.tree).filter((path) => pattern.test(path)).sort();
}

function checkOptions(workspace: LoadedWorkspace, options: ResolveSharedContextOptions): number {
  const max = options.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES;
  if (!Number.isInteger(max) || max < 0) throw new ValidationError('invalid maxResourceBytes', { maxResourceBytes: ['must be a non-negative integer'] });
  const audience = options.audience;
  if (audience !== undefined && audience !== 'main-agent' && !(audience.page in workspace.manifest.pages)) {
    throw new ValidationError(`unknown page ${JSON.stringify(audience.page)}`, { audience: ['must name a page of the workspace'] });
  }
  return max;
}

function instructionsOf(workspace: LoadedWorkspace): SharedInstruction[] {
  return orderInstructionFiles(Object.keys(workspace.tree)).map((file) => ({ file, text: textOf(workspace.tree[file]) }));
}

function clash(name: string, earlier: SharedSkill, later: SharedSkill): SDKError {
  return new SDKError(
    `skill '${name}' is defined in ${earlier.file} and ${later.file}. Rename one skill, or pass override: true to let the later file win.`,
    'LOUSHO_SKILL_INVALID'
  );
}

function sharedSkills(workspace: LoadedWorkspace): Map<string, SharedSkill> {
  const byName = new Map<string, SharedSkill>();
  for (const file of pathsMatching(workspace, SHARED_PATH_PATTERNS.skills)) {
    const defaultName = file.split('/')[2] ?? file;
    const item = { file, skill: skillFromText({ defaultName, file }, textOf(workspace.tree[file])) };
    const earlier = byName.get(item.skill.name);
    if (earlier) throw clash(item.skill.name, earlier, item);
    byName.set(item.skill.name, item);
  }
  return byName;
}

function skillsOf(workspace: LoadedWorkspace, options: ResolveSharedContextOptions): SharedSkill[] {
  const byName = sharedSkills(workspace);
  const shared = new Set(byName.keys());
  for (const item of options.skills ?? []) {
    const earlier = byName.get(item.skill.name);
    const mayReplace = options.override === true && shared.has(item.skill.name);
    if (earlier && !mayReplace) throw clash(item.skill.name, earlier, item);
    byName.set(item.skill.name, item);
    shared.delete(item.skill.name);
  }
  return [...byName.values()];
}

function memoryFile(workspace: LoadedWorkspace, file: string): SharedMemoryFile {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return { name: base.slice(0, -'.ts'.length), file, source: textOf(workspace.tree[file]) };
}

function memoryOf(workspace: LoadedWorkspace, options: ResolveSharedContextOptions): SharedMemorySlot[] {
  const files = pathsMatching(workspace, SHARED_PATH_PATTERNS.memory).map((file) => memoryFile(workspace, file));
  if (files.length === 0) return [];
  const { createMemory, run } = options;
  if (!createMemory) {
    throw new SDKError(`${files[0]?.file} is a memory file the core cannot run. Pass createMemory(file) to build its slot.`, 'LOUSHO_MEMORY_INVALID');
  }
  if (!run) throw new ValidationError('shared memory needs a run', { run: ['pass the createSharedContextRun() object of this workspace run'] });
  return files.map((file) => {
    if (!run.memory.has(file.file)) run.memory.set(file.file, createMemory(file));
    return { ...file, slot: run.memory.get(file.file) as MemorySlot };
  });
}

function resourceOf(workspace: LoadedWorkspace, path: string, max: number): SharedResource {
  const text = textOf(workspace.tree[path]);
  const bytes = encoder.encode(text).length;
  const base = { ref: `shared:${path.slice('shared/'.length)}`, path, bytes };
  return Object.freeze(bytes <= max ? { ...base, inlined: true, text } : { ...base, inlined: false });
}

function resourcesOf(workspace: LoadedWorkspace, max: number): SharedResource[] {
  return pathsMatching(workspace, RESOURCE_PATH).map((path) => resourceOf(workspace, path, max));
}

function inheritedFolders(workspace: LoadedWorkspace, audience: SharedAudience | undefined): ReadonlySet<SharedFolder> {
  if (audience === 'main-agent' && !workspace.manifest.inheritsShared) return new Set();
  const context = INHERITANCE_RULES.filter((row) => row.item !== 'policies' && row.item !== 'main agent');
  return new Set(context.flatMap((row) => row.folders));
}

/** Resolves the shared layer for one page or the main agent from a loaded workspace; the main agent gets none of it unless `mainAgent.inheritsShared` is true (policy is applied elsewhere). */
export function resolveSharedContext(workspace: LoadedWorkspace, options: ResolveSharedContextOptions = {}): SharedContext {
  const max = checkOptions(workspace, options);
  const folders = inheritedFolders(workspace, options.audience);
  const resourceFolders = ['knowledge', 'brand', 'resources'] as const;
  return {
    instructions: folders.has('instructions') ? instructionsOf(workspace) : [],
    skills: folders.has('skills') ? skillsOf(workspace, options) : [...(options.skills ?? [])],
    memorySlots: folders.has('memory') ? memoryOf(workspace, options) : [],
    resources: resourceFolders.some((folder) => folders.has(folder)) ? resourcesOf(workspace, max) : [],
  };
}
