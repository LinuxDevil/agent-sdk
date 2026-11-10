import { z } from 'zod';
import { KEBAB_CASE, SEMVER } from './common';
import { parseAgentRef } from './agentRefs';
import { globalRefKeySchema } from './globalRefKey';
import type { WorkspaceManifest } from './workspace';
import { satisfiesRange } from './versionRange';

/** One pinned `global:` agent or profile in `workspace.lock.json`. */
export interface LockEntry {
  /** Exact resolved version, `x.y.z`. */
  version: string;
  /** Lowercase hex SHA-256 of the resolved content. */
  sha256: string;
  /** Where the content came from: the Forge project or the workspace's vendored copy. */
  source: 'project' | 'vendor';
}

/** The contents of `workspace.lock.json` (`lousho.lock/1`). */
export interface WorkspaceLock {
  /** Schema marker, always `lousho.lock/1`. */
  schema: 'lousho.lock/1';
  /** The workspace this lock belongs to. */
  workspace: {
    /** Workspace id, kebab-case. */
    id: string;
    /** Workspace version, semver. */
    version: string;
  };
  /** Pinned entries keyed by `global:<name>`; `workspace:` and `local:` refs never appear. */
  resolved: Record<string, LockEntry>;
  /** ISO 8601 timestamp of when the lock was written. */
  generatedAt: string;
}

/** A reference to check against the lock, with the content hash found at resolution time when known. */
export interface LockRef {
  /** Agent or profile reference, such as `global:copy-editor@^1.2.0` or `workspace:writer`. */
  ref: string;
  /** SHA-256 of the content that resolved for this ref; compared with the lock when present. */
  sha256?: string;
}

/** `dev` floats ranges and only warns; `strict` (installed or published) turns every problem into an error. */
export type LockMode = 'dev' | 'strict';

/** The outcome of {@link checkLock}. */
export interface LockCheckResult {
  /** True when there are no errors; warnings do not fail the check. */
  ok: boolean;
  /** Problems that fail the check (strict mode only). */
  errors: string[];
  /** Problems that are reported but do not fail the check (dev mode only). */
  warnings: string[];
}

const lockEntrySchema = z
  .object({
    version: z.string().regex(SEMVER, 'must be an exact semver version, e.g. 1.2.3'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters'),
    source: z.enum(['project', 'vendor']),
  })
  .strict();

export const workspaceLockObjectSchema = z
  .object({
    schema: z.literal('lousho.lock/1'),
    workspace: z
      .object({
        id: z.string().regex(KEBAB_CASE, 'must be kebab-case'),
        version: z.string().regex(SEMVER, 'must be a semver version, e.g. 1.0.0'),
      })
      .strict(),
    resolved: z.record(globalRefKeySchema, lockEntrySchema),
    generatedAt: z.string().datetime({ message: 'must be an ISO 8601 timestamp' }),
  })
  .strict();

/** Zod schema for `workspace.lock.json` (`lousho.lock/1`); keys of `resolved` must be `global:<name>`, so `workspace:` and `local:` refs are rejected. */
export const workspaceLockSchema: z.ZodType<WorkspaceLock> = workspaceLockObjectSchema;

interface Requirement {
  ranges: Set<string>;
  sha256?: string;
}

function addRequirement(required: Map<string, Requirement>, key: string, range: string, sha256?: string): void {
  const current = required.get(key) ?? { ranges: new Set<string>() };
  current.ranges.add(range);
  if (sha256 !== undefined) current.sha256 = sha256;
  required.set(key, current);
}

function collectRequirements(manifest: WorkspaceManifest, refs: LockRef[], report: (message: string) => void): Map<string, Requirement> {
  const required = new Map<string, Requirement>();
  for (const group of [manifest.dependencies?.agents, manifest.dependencies?.profiles]) {
    for (const [key, range] of Object.entries(group ?? {})) addRequirement(required, key, range);
  }
  for (const { ref, sha256 } of refs) {
    const parsed = parseAgentRef(ref);
    if (!parsed.ok) report(parsed.error);
    else if (parsed.ref.kind === 'global') addRequirement(required, `global:${parsed.ref.name}`, parsed.ref.range, sha256);
  }
  return required;
}

function checkEntry(key: string, need: Requirement, entry: LockEntry | undefined, report: (message: string) => void): void {
  if (entry === undefined) {
    report(`'${key}' has no entry in workspace.lock.json`);
    return;
  }
  for (const range of need.ranges) {
    if (!satisfiesRange(entry.version, range)) report(`'${key}' is pinned to ${entry.version}, which is outside the range ${range}`);
  }
  if (need.sha256 !== undefined && need.sha256 !== entry.sha256) {
    report(`'${key}' hash mismatch: lock has ${entry.sha256}, resolved content is ${need.sha256}`);
  }
}

function checkWorkspace(manifest: WorkspaceManifest, lock: WorkspaceLock, report: (message: string) => void): void {
  if (lock.workspace.id !== manifest.id) report(`workspace.lock.json is for workspace '${lock.workspace.id}', not '${manifest.id}'`);
  if (lock.workspace.version !== manifest.version) report(`workspace.lock.json was written for version ${lock.workspace.version}, the workspace is ${manifest.version}`);
}

/** Checks `global:` refs and `dependencies` against the lock; `dev` mode (floating ranges) turns a missing lock, missing entry, pinned version outside its range or hash mismatch into warnings, `strict` mode (installed or published) turns them into errors; `workspace:` and `local:` refs are versioned by the workspace revision and ignored. */
export function checkLock(manifest: WorkspaceManifest, refs: LockRef[], lock: WorkspaceLock | undefined, mode: LockMode): LockCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const report = (message: string): void => {
    (mode === 'strict' ? errors : warnings).push(message);
  };
  const required = collectRequirements(manifest, refs, report);
  if (lock === undefined) {
    if (required.size > 0 || mode === 'strict') report('workspace.lock.json is missing');
  } else {
    checkWorkspace(manifest, lock, report);
    for (const [key, need] of required) checkEntry(key, need, lock.resolved[key], report);
  }
  return { ok: errors.length === 0, errors, warnings };
}
