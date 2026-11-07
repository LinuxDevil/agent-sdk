/**
 * SuggestionStore - one workspace's suggestion records under
 * `.lousho/agents/<id>/suggestions/<id>.json` (Contract B).
 *
 * Two record kinds share the folder, discriminated on `kind`:
 * `PromptSuggestion` (the prompt optimizer's anchored instructions
 * edits, CAS-guarded by `expectedPromptHash`) and `PortabilityAnalysis`
 * (the portability check's findings, cached by `specHash`). Both are
 * produced by passes and consumed by routes - the store only persists
 * and looks them up.
 *
 * A portability record's file name is derived from its spec hash
 * (`portability-<first 16 hex of the hash>`), so a spec edit changes the
 * cache key and `findPortability` misses until the pass re-runs.
 *
 * Lock-free like AgentRepo, VersionStore and DraftStore: callers
 * serialize read-modify-write with `withAgentLock(id)`; the store only
 * does atomic file IO. Ids become file names, so every read/write first
 * checks {@link SUGGESTION_ID_RE} - an invalid id never reaches a path.
 */
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  PortabilityAnalysis,
  PromptSuggestion,
  StoredSuggestion,
  SuggestionStatus,
} from '../../shared/wireTypes';
import type { AgentRepo } from './agentRepo';
import { readJsonFile, writeJsonAtomic } from './atomic';

/**
 * The only characters a suggestion id may contain (`<id>` becomes
 * `<id>.json` on disk): letters, digits, `-` and `_`, 1-64 chars.
 * Anything else - path separators, dots, empty, over-long - is rejected
 * before a path is ever built.
 */
export const SUGGESTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `'sha256:' + hex(sha256(utf8 instructions))` - the CAS key prompt-edit
 * suggestions carry (`expectedPromptHash`/`proposedPromptHash`). The
 * raw string is hashed with no normalization, so any edit - whitespace
 * included - changes the key.
 */
export function promptHash(instructions: string): string {
  return `sha256:${createHash('sha256').update(instructions, 'utf8').digest('hex')}`;
}

/**
 * The file name a `specHash`'s portability analysis lives under:
 * `'portability-' + specHash.slice('sha256:'.length, 'sha256:'.length + 16)`
 * (64 bits of the digest - collision-safe per agent, readable in a
 * listing).
 */
function portabilityId(specHash: string): string {
  return `portability-${specHash.slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

/**
 * The suggestion store over `repo`'s `.lousho/agents/<id>/suggestions/`
 * trees. `clock` is injectable for tests; it only stamps `updatedAt` on
 * `setStatus`.
 */
export class SuggestionStore {
  constructor(
    private readonly repo: AgentRepo,
    private readonly clock: () => Date = () => new Date()
  ) {}

  private suggestionsDir(id: string): string {
    return path.join(this.repo.sidecarDir(id), 'suggestions');
  }

  private suggestionPath(id: string, suggestionId: string): string {
    return path.join(this.suggestionsDir(id), `${suggestionId}.json`);
  }

  /**
   * Every suggestion record for the agent, newest `createdAt` first.
   * A `*.json` file that no longer parses is warned about and skipped
   * rather than failing the whole list; `[]` when the agent has none.
   */
  async list(agentId: string): Promise<StoredSuggestion[]> {
    let files: string[];
    try {
      files = await fsPromises.readdir(this.suggestionsDir(agentId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const items: StoredSuggestion[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(this.suggestionsDir(agentId), file);
      try {
        items.push(JSON.parse(await fsPromises.readFile(filePath, 'utf8')) as StoredSuggestion);
      } catch {
        console.warn(`[agent-forge] skipping unparsable suggestion file ${filePath}`);
      }
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return items;
  }

  /**
   * The record stored under `id`, or `undefined` when absent. An `id`
   * failing {@link SUGGESTION_ID_RE} returns `undefined` without ever
   * touching the filesystem - ids become file names, so nothing with
   * separators or dots may reach a path.
   */
  async get(agentId: string, id: string): Promise<StoredSuggestion | undefined> {
    if (!SUGGESTION_ID_RE.test(id)) return undefined;
    return readJsonFile<StoredSuggestion>(this.suggestionPath(agentId, id));
  }

  /**
   * Writes `item` atomically to `suggestions/<item.id>.json`. Throws
   * when `item.id` fails {@link SUGGESTION_ID_RE} - nothing is written.
   */
  async save(agentId: string, item: StoredSuggestion): Promise<void> {
    if (!SUGGESTION_ID_RE.test(item.id)) {
      throw new Error(`Invalid suggestion id '${item.id}'`);
    }
    await writeJsonAtomic(this.suggestionPath(agentId, item.id), item);
  }

  /**
   * Stamps `status` + `updatedAt` on a `prompt_edit` record and returns
   * the updated record. `undefined` - nothing written - when the record
   * is missing, the id is invalid, or the record is a portability
   * analysis (statuses belong to the suggestion lifecycle only).
   */
  async setStatus(
    agentId: string,
    id: string,
    status: SuggestionStatus
  ): Promise<PromptSuggestion | undefined> {
    const item = await this.get(agentId, id);
    if (item === undefined || item.kind !== 'prompt_edit') return undefined;
    const updated: PromptSuggestion = { ...item, status, updatedAt: this.clock().toISOString() };
    await writeJsonAtomic(this.suggestionPath(agentId, id), updated);
    return updated;
  }

  /**
   * The cached portability analysis for `specHash` - the record at the
   * hash-derived `portability-*` name, returned only when it is a
   * portability record whose own `specHash` still matches. A spec edit
   * changes the hash, hence the derived name, so this misses until the
   * check re-runs.
   */
  async findPortability(agentId: string, specHash: string): Promise<PortabilityAnalysis | undefined> {
    const item = await this.get(agentId, portabilityId(specHash));
    if (item === undefined || item.kind !== 'portability' || item.specHash !== specHash) {
      return undefined;
    }
    return item;
  }
}
