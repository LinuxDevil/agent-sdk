/**
 * AgentRepo - the single storage boundary for everything under
 * `.lousho/agents/` of one workspace: the AgentSpec v2 working copy
 * `<id>.yaml`, the `working.json` Studio-write marker written after it,
 * and the `meta.json` / `layout.json` sidecars.
 *
 * Lock-free by design (the storage rule every `.lousho` store follows):
 * callers serialize each read-modify-write with `withAgentLock(id)`; this
 * class only does atomic file IO, so it can never deadlock or re-enter.
 *
 * Pending-section tolerance: spec sections whose tickets have not landed
 * yet (`tools`, `triggers`, `flow`, `skills`, ...) fail the v2 schema with
 * "not supported yet" placeholder issues, and an upgraded v1 spec can
 * legitimately carry them. When a document's ONLY validation problems are
 * those top-level placeholders, it is read and written verbatim - every
 * key preserved, no schema stripping. Any other problem fails as usual
 * (the strict gate for creating such specs lives in the routes and the
 * compiler, not in storage).
 */
import * as fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { agentSpecV2Schema, loadSpecV2, upgradeSpec, type AgentSpecV2 } from '@lousho/build-ai-agent';
import { isValidAgentId } from '../../shared/agentId';
import type { AgentMeta, CanvasLayout } from '../../shared/wireTypes';
import { readJsonFile, writeFileAtomic, writeJsonAtomic } from './atomic';
import { specHash } from './specHash';

/**
 * A spec that fails v2 validation for a reason other than pending
 * sections. `issues` is the flattened `{ path, message }` list the
 * `PUT /agents/:id` route returns as `details.issues`; `code` mirrors the
 * SDK's spec-validation code.
 */
export class InvalidSpecError extends Error {
  readonly code = 'LOUSHO_SPEC_INVALID';
  constructor(readonly issues: { path: string; message: string }[]) {
    super(`Invalid agent spec: ${issues[0].path}: ${issues[0].message}`);
    this.name = 'InvalidSpecError';
  }
}

/** One validation problem as `agentSpecV2Schema.safeParse` reports it (structural - the SDK's SchemaIssue is not public). */
interface SpecSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

/** The prefix every "not supported yet" placeholder issue carries - mirrors the SDK's `UNSUPPORTED_PREFIX` (not a public export). */
const UNSUPPORTED_PREFIX = 'not supported yet: ';

/**
 * Whether `issue` is a pending-section placeholder: it sits at the single
 * top-level key of the section it marks (value-level "not supported yet"
 * issues - e.g. a guardrail's `onTripped: 'warn'` or a permission's
 * `action: 'auto'` - nest deeper and are NOT tolerated).
 */
function isPendingSectionIssue(issue: SpecSchemaIssue): boolean {
  return (issue.path ?? []).length === 1 && issue.message.startsWith(UNSUPPORTED_PREFIX);
}

/** An issue's path joined with dots (object segments carry their `key`). */
function issueDotPath(path: SpecSchemaIssue['path']): string {
  return (path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.');
}

/**
 * The default `meta.json` content for an agent that has none yet: enabled,
 * no disable history, no streak, no labels, unpublished.
 */
function defaultMeta(now: string): AgentMeta {
  return {
    schemaVersion: 1,
    enabled: true,
    disabledAt: null,
    disabledReason: null,
    failureStreak: 0,
    labels: [],
    publishedVersion: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** The default `layout.json` content for an agent that has none yet: no positioned nodes, no notes. */
function defaultLayout(): CanvasLayout {
  return { schemaVersion: 1, nodes: {}, notes: [] };
}

/**
 * The spec file as a v2 document, before schema validation - the same
 * first half `loadSpecV2` runs (parse by extension, upgrade v1), minus its
 * strict parse, so `readSpec` can return the document verbatim when its
 * only problems are pending sections.
 */
function readSpecDocument(filePath: string): AgentSpecV2 {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data: unknown = filePath.toLowerCase().endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  return upgradeSpec(data);
}

/**
 * One workspace's `.lousho/agents` tree. `baseDir` is always a workspace
 * root (`ws.ref.root`), never `.lousho/` itself.
 */
export class AgentRepo {
  constructor(private readonly baseDir: string) {}

  /** `<baseDir>/.lousho/agents` - the folder every agent file lives under. */
  agentsDir(): string {
    return path.join(this.baseDir, '.lousho', 'agents');
  }

  /** `<agentsDir>/<id>.yaml` - the agent's spec v2 working copy. */
  specPath(id: string): string {
    return path.join(this.agentsDir(), `${id}.yaml`);
  }

  /** `<agentsDir>/<id>` - the agent's sidecar folder (meta/layout/working/versions/traces/...). */
  sidecarDir(id: string): string {
    return path.join(this.agentsDir(), id);
  }

  private workingPath(id: string): string {
    return path.join(this.sidecarDir(id), 'working.json');
  }

  private metaPath(id: string): string {
    return path.join(this.sidecarDir(id), 'meta.json');
  }

  private layoutPath(id: string): string {
    return path.join(this.sidecarDir(id), 'layout.json');
  }

  /** Agent ids with a spec file: `*.yaml`/`*.yml` basenames that pass the agent-id rule, sorted. */
  listIds(): string[] {
    const dir = this.agentsDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
      .map((file) => file.replace(/\.ya?ml$/, ''))
      .filter(isValidAgentId)
      .sort((a, b) => a.localeCompare(b));
  }

  /** Whether the agent's spec file exists. */
  exists(id: string): boolean {
    return fs.existsSync(this.specPath(id));
  }

  /**
   * The agent's spec as AgentSpecV2 (a v1 file on disk is upgraded on the
   * way in), or `undefined` when the file does not exist. A document whose
   * only schema problems are pending sections is returned verbatim; every
   * other read/validation problem throws with `loadSpecV2`'s own errors
   * (LOUSHO_SPEC_INVALID, LOUSHO_SPEC_UNSUPPORTED, ...).
   */
  async readSpec(id: string): Promise<AgentSpecV2 | undefined> {
    const filePath = this.specPath(id);
    if (!fs.existsSync(filePath)) return undefined;
    let doc: AgentSpecV2;
    try {
      doc = readSpecDocument(filePath);
    } catch {
      // The document itself failed to parse - let loadSpecV2 re-run the
      // same steps so the error carries its canonical message and code.
      return loadSpecV2(filePath);
    }
    const result = agentSpecV2Schema.safeParse(doc);
    if (result.success) return result.data;
    if (result.error.issues.every(isPendingSectionIssue)) return doc;
    // Real validation problems: throw the error loadSpecV2 produces for
    // the same document (its message names the file).
    return loadSpecV2(filePath);
  }

  /**
   * Validates and writes `<id>.yaml`, then records `working.json` with the
   * spec's content hash (the "Studio wrote this" marker). Writes the
   * schema-parsed document when it validates; when the only problems are
   * pending sections, writes the input verbatim instead. Throws
   * {@link InvalidSpecError} for any other validation problem - nothing is
   * written in that case.
   */
  async writeSpec(id: string, spec: AgentSpecV2): Promise<void> {
    const result = agentSpecV2Schema.safeParse(spec);
    let doc: AgentSpecV2;
    if (result.success) {
      doc = result.data;
    } else if (result.error.issues.every(isPendingSectionIssue)) {
      doc = spec;
    } else {
      throw new InvalidSpecError(
        result.error.issues.map((issue) => ({ path: issueDotPath(issue.path), message: issue.message }))
      );
    }
    await writeFileAtomic(this.specPath(id), stringifyYaml(doc));
    await writeJsonAtomic(this.workingPath(id), {
      schemaVersion: 1,
      specHash: specHash(doc),
      writtenAt: new Date().toISOString(),
    });
  }

  /** The `specHash` `writeSpec` last recorded, or `undefined` when no `working.json` exists. */
  async readWorkingHash(id: string): Promise<string | undefined> {
    const working = await readJsonFile<{ specHash?: string }>(this.workingPath(id));
    return working?.specHash;
  }

  /** The agent's `meta.json`, or {@link defaultMeta} stamped with the spec file's mtime when it is missing. */
  async readMeta(id: string): Promise<AgentMeta> {
    const meta = await readJsonFile<AgentMeta>(this.metaPath(id));
    if (meta !== undefined) return meta;
    return defaultMeta(this.exists(id) ? this.updatedAt(id) : new Date().toISOString());
  }

  /** Writes `meta.json` atomically. */
  async writeMeta(id: string, meta: AgentMeta): Promise<void> {
    await writeJsonAtomic(this.metaPath(id), meta);
  }

  /** The agent's `layout.json`, or {@link defaultLayout} when it is missing. */
  async readLayout(id: string): Promise<CanvasLayout> {
    return (await readJsonFile<CanvasLayout>(this.layoutPath(id))) ?? defaultLayout();
  }

  /** Writes `layout.json` atomically. */
  async writeLayout(id: string, layout: CanvasLayout): Promise<void> {
    await writeJsonAtomic(this.layoutPath(id), layout);
  }

  /** The spec file's mtime as an ISO string (what list() reports per agent). */
  updatedAt(id: string): string {
    return fs.statSync(this.specPath(id)).mtime.toISOString();
  }

  /**
   * Deletes the four files this repo owns - `<id>.yaml`, `meta.json`,
   * `layout.json`, `working.json` - and nothing else: the `<id>/` folder's
   * other contents (versions/, traces/, checkpoints/, chats/, ...) belong
   * to their own stores and survive.
   */
  async remove(id: string): Promise<void> {
    await Promise.all([
      fsPromises.rm(this.specPath(id), { force: true }),
      fsPromises.rm(this.metaPath(id), { force: true }),
      fsPromises.rm(this.layoutPath(id), { force: true }),
      fsPromises.rm(this.workingPath(id), { force: true }),
    ]);
  }
}
