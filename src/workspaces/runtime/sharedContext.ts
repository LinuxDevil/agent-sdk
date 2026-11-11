import { SDKError, ValidationError } from '../../execution/errors';
import { defineMemory, type MemorySlot } from '../../memory/defineMemory';
import { inMemoryMemory } from '../../memory/providers';
import { skillFromText } from '../../skills/loadSkills';
import type { Skill } from '../../skills/defineSkill';
import { SHARED_PATH_PATTERNS, orderInstructionFiles } from '../contracts/shared';
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

/** A memory file as the host sees it when it builds the slot. */
export interface SharedMemoryFile {
  /** The slot name, the file name without `.ts`. */
  name: string;
  /** The workspace-relative path of the memory file. */
  file: string;
  /** The file's text; the core never runs it. */
  source: string;
  /** `shared` for `shared/memory`, `page` for `pages/<id>/memory`. */
  scope: 'shared' | 'page';
}

/** One memory slot a run can use. */
export interface SharedMemorySlot extends SharedMemoryFile {
  /** The slot; shared slots are the same object for every caller that passes the same run. */
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
  /** Shared slots, then the page's private slots. */
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
export type SharedAudience = { page: string } | 'main-agent';

/** Options of {@link resolveSharedContext}. */
export interface ResolveSharedContextOptions {
  /** Who the context is for; without it only the workspace-wide shared layer is returned. */
  audience?: SharedAudience;
  /** The run whose shared memory instances are reused; without it every call builds new ones. */
  run?: SharedContextRun;
  /** Largest file text, in UTF-8 bytes, that is inlined; defaults to 256 KiB. */
  maxResourceBytes?: number;
  /** Lets a later skill replace an earlier one of the same name instead of failing. */
  override?: boolean;
  /** More skills (an agent's own) to union with the shared ones; they come after, so they win with `override`. */
  skills?: readonly SharedSkill[];
  /** Builds the slot for a memory file; the default is an in-process slot with the file's name. */
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

function inheritsShared(workspace: LoadedWorkspace): boolean {
  const raw = workspace.tree['workspace.json'];
  const manifest = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { mainAgent?: { inheritsShared?: boolean } | null } | undefined;
  return manifest?.mainAgent?.inheritsShared === true;
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

function skillsOf(workspace: LoadedWorkspace, options: ResolveSharedContextOptions): SharedSkill[] {
  const shared = pathsMatching(workspace, SHARED_PATH_PATTERNS.skills).map((file) => {
    const defaultName = file.split('/')[2] ?? file;
    return { file, skill: skillFromText({ defaultName, file }, textOf(workspace.tree[file])) };
  });
  const byName = new Map<string, SharedSkill>();
  for (const item of [...shared, ...(options.skills ?? [])]) {
    const earlier = byName.get(item.skill.name);
    if (earlier && options.override !== true) throw clash(item.skill.name, earlier, item);
    byName.set(item.skill.name, item);
  }
  return [...byName.values()];
}

function defaultMemory(file: SharedMemoryFile): MemorySlot {
  return defineMemory({ name: file.name, scope: 'global', provider: inMemoryMemory() });
}

function memoryFile(workspace: LoadedWorkspace, file: string, scope: SharedMemoryFile['scope']): SharedMemoryFile {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return { name: base.slice(0, -'.ts'.length), file, source: textOf(workspace.tree[file]), scope };
}

function slotFor(file: SharedMemoryFile, options: ResolveSharedContextOptions): MemorySlot {
  const create = options.createMemory ?? defaultMemory;
  const cache = file.scope === 'shared' ? options.run?.memory : undefined;
  if (!cache) return create(file);
  if (!cache.has(file.file)) cache.set(file.file, create(file));
  return cache.get(file.file) as MemorySlot;
}

function memoryOf(workspace: LoadedWorkspace, options: ResolveSharedContextOptions): SharedMemorySlot[] {
  const audience = options.audience;
  const files = pathsMatching(workspace, SHARED_PATH_PATTERNS.memory).map((file) => memoryFile(workspace, file, 'shared'));
  if (audience !== undefined && audience !== 'main-agent') {
    const own = new RegExp(`^pages/${audience.page.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/memory/[^/]+\\.ts$`);
    files.push(...pathsMatching(workspace, own).map((file) => memoryFile(workspace, file, 'page')));
  }
  return files.map((file) => ({ ...file, slot: slotFor(file, options) }));
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

/** Resolves the shared layer for one page or the main agent from a loaded workspace; the main agent gets nothing unless `mainAgent.inheritsShared` is true (policy is applied elsewhere). */
export function resolveSharedContext(workspace: LoadedWorkspace, options: ResolveSharedContextOptions = {}): SharedContext {
  const max = checkOptions(workspace, options);
  if (options.audience === 'main-agent' && !inheritsShared(workspace)) return { instructions: [], skills: [...(options.skills ?? [])], memorySlots: [], resources: [] };
  return { instructions: instructionsOf(workspace), skills: skillsOf(workspace, options), memorySlots: memoryOf(workspace, options), resources: resourcesOf(workspace, max) };
}
