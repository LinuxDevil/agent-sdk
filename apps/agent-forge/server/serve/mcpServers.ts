/**
 * MCP serve manager (X03) - exposes an agent's PINNED published version as
 * an MCP server (`serveMcp` over loopback HTTP with the serve bearer) so
 * Claude Code / Cursor can call it. One manager per Studio app; running
 * servers live in memory only - a Studio restart means "not running".
 *
 * Lifecycle:
 * - `start` is idempotent: already running on the current published
 *   version returns the status unchanged.
 * - `refresh(agentId)` (called on `agent.changed` version/meta and after a
 *   token rotation) restarts a running server whose published version
 *   moved, and stops one whose agent lost its publish pointer.
 * - `closeAll` runs on Studio shutdown.
 */
import type { AgentSpecV2, SimpleAgent } from 'lousho';
import { serveMcp, type ServeMcpHandle, type ServeMcpOptions } from 'lousho/mcp';
import type { McpServeStatus } from '../../shared/wireTypes';
import type { AgentRepo } from '../storage/agentRepo';
import type { VersionStore } from '../storage/versionStore';
import { readPublishedSpec } from '../lifecycle/publish';
import type { ServeConfigStore } from './serveConfigStore';

/** A running entry: the published version it serves plus the live handle. */
interface RunningEntry {
  version: number;
  handle: ServeMcpHandle;
}

export interface McpServerManagerDeps {
  repo: AgentRepo;
  versions: VersionStore;
  serveConfig: ServeConfigStore;
  /** Builds the `SimpleAgent` for a published spec - the same builder the HTTP serve surface uses. */
  buildAgent: (spec: AgentSpecV2, agentId: string) => Promise<SimpleAgent>;
  /** Test seam - defaults to the SDK's real `serveMcp`. */
  serve?: (options: ServeMcpOptions) => Promise<ServeMcpHandle>;
}

/** Thrown by `start` when the agent has no published version. */
export class McpNotPublishedError extends Error {
  // fallow-ignore-next-line unused-class-member -- read as `error.code` by serveRoutes' 409 mapping; fallow's import graph misses the cross-module member access
  readonly code = 'LOUSHO_NOT_PUBLISHED';
  constructor(agentId: string) {
    super(`Agent '${agentId}' has no published version`);
  }
}

/** The surface the serve routes + app wiring need - `McpServerManager` implements it, tests stub it. */
export interface McpServeManager {
  status(agentId: string): McpServeStatus;
  start(agentId: string): Promise<McpServeStatus>;
  stop(agentId: string): Promise<McpServeStatus>;
  restart(agentId: string): Promise<void>;
  refresh(agentId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export class McpServerManager implements McpServeManager {
  private readonly running = new Map<string, RunningEntry>();
  private readonly serve: (options: ServeMcpOptions) => Promise<ServeMcpHandle>;

  constructor(private readonly deps: McpServerManagerDeps) {
    this.serve = deps.serve ?? serveMcp;
  }

  /** The agent's MCP serve state for `GET /agents/:id/serve/mcp`. */
  status(agentId: string): McpServeStatus {
    const entry = this.running.get(agentId);
    if (entry === undefined) {
      return { running: false, url: null, port: null, version: null, toolName: null };
    }
    return {
      running: true,
      url: entry.handle.url ?? null,
      port: entry.handle.port ?? null,
      version: entry.version,
      toolName: entry.handle.agentToolName,
    };
  }

  /**
   * Starts the MCP server for the published version. Idempotent: running
   * on the current published version returns the status unchanged; a
   * moved publish pointer restarts it. Throws {@link McpNotPublishedError}
   * when nothing is published, and the SDK's `ConfigurationError` when the
   * optional MCP peer is missing.
   */
  async start(agentId: string): Promise<McpServeStatus> {
    const published = await readPublishedSpec(agentId, { repo: this.deps.repo, versions: this.deps.versions });
    if (published === undefined) throw new McpNotPublishedError(agentId);
    const existing = this.running.get(agentId);
    if (existing !== undefined && existing.version === published.version) return this.status(agentId);
    if (existing !== undefined) await this.stopHandle(agentId, existing);
    const agent = await this.deps.buildAgent(published.spec, agentId);
    const entry = await this.deps.serveConfig.get(agentId);
    const spec = published.spec;
    const handle = await this.serve({
      agent,
      name: agentId,
      description: spec.description ?? `Ask the ${spec.name} agent.`,
      transport: {
        type: 'http',
        host: '127.0.0.1',
        port: 0,
        path: '/mcp',
        auth: { type: 'bearer', token: entry.token },
      },
      warn: (message) => console.warn(`[mcp ${agentId}] ${message}`),
    });
    this.running.set(agentId, { version: published.version, handle });
    return this.status(agentId);
  }

  /** Stops the agent's MCP server; a no-op when it is not running. */
  async stop(agentId: string): Promise<McpServeStatus> {
    const existing = this.running.get(agentId);
    if (existing !== undefined) await this.stopHandle(agentId, existing);
    return this.status(agentId);
  }

  /**
   * Restarts a running server so it picks up the current token (and
   * version). A no-op when the agent is not running - the next `start`
   * reads the rotated token anyway.
   */
  async restart(agentId: string): Promise<void> {
    const existing = this.running.get(agentId);
    if (existing === undefined) return;
    await this.stopHandle(agentId, existing);
    await this.start(agentId);
  }

  /**
   * Called on `agent.changed` (version/meta): restarts a running server
   * whose published version moved and stops one whose agent is no longer
   * published. A failed restart is logged and retried on the next event -
   * the server keeps its last good state in `running` only when the stop
   * succeeded; a `start` failure after a successful stop leaves it stopped.
   */
  async refresh(agentId: string): Promise<void> {
    const existing = this.running.get(agentId);
    if (existing === undefined) return;
    const published = await readPublishedSpec(agentId, { repo: this.deps.repo, versions: this.deps.versions });
    if (published === undefined || published.version !== existing.version) {
      await this.stop(agentId);
      if (published !== undefined) await this.start(agentId);
    }
  }

  /** Stops every running MCP server (Studio shutdown). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((agentId) => this.stop(agentId)));
  }

  private async stopHandle(agentId: string, entry: RunningEntry): Promise<void> {
    this.running.delete(agentId);
    try {
      await entry.handle.close();
    } catch (error) {
      console.warn(`[mcp ${agentId}] close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
