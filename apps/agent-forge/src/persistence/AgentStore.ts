import type { AgentSpec, AgentSpecV2 } from '@linuxdevil/lousho';
import type { AgentListItem, AgentRecord, CanvasLayout } from '../../shared/wireTypes';

/**
 * One row of the legacy (`?view=legacy`) agents list: the agent id plus
 * its spec projected down to AgentSpec v1. Only the server's v1 facade
 * (`LegacyAgentStore`) still answers this shape.
 */
export interface LegacyAgentStoreEntry {
  id: string;
  spec: AgentSpec;
  updatedAt: string;
}

/**
 * Storage boundary for `AgentSpecV2` working copies plus their canvas
 * layout sidecars (PLAN §5 `GET/PUT /agents`, `PUT /agents/:id/layout`).
 *
 * `HttpAgentStore` is the browser app's implementation, reading and
 * writing `.lousho/agents/` over HTTP. The app's UI code only ever
 * depends on `AgentStore`, never on `localStorage` or `node:fs`.
 */
export interface AgentStore {
  /** `GET /agents` - the list rows (id, name, model, counts, lastRun). */
  list(): Promise<AgentListItem[]>;
  /** `GET /agents/:id` - the spec v2 working copy plus meta/layout, or undefined on a 404. */
  load(id: string): Promise<AgentRecord | undefined>;
  /** `PUT /agents/:id` `{ spec }` - the working-copy yaml. */
  save(id: string, spec: AgentSpecV2): Promise<void>;
  /** `PUT /agents/:id/layout` - node positions, notes, viewport. */
  saveLayout(id: string, layout: CanvasLayout): Promise<void>;
  /** `DELETE /agents/:id`. */
  remove(id: string): Promise<void>;
}

/**
 * The pre-v2 `AgentStore` shape, kept only for the server's
 * `?view=legacy` bridge (`fsAgentStore` + the still-v1 routes and
 * RunManager): `list`/`load`/`save` speak AgentSpec v1 and there is no
 * layout call. Nothing browser-side uses it - the canvas is on the v2
 * `AgentStore` above.
 */
export interface LegacyAgentStore {
  list(): Promise<LegacyAgentStoreEntry[]>;
  load(id: string): Promise<AgentSpec | undefined>;
  save(id: string, spec: AgentSpec): Promise<void>;
  remove(id: string): Promise<void>;
}
