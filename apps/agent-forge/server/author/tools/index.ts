/**
 * The Author's tool surface (PLAN §8.2), built per turn: AA06's 13 read
 * tools live in {@link AUTHOR_TOOL_FACTORIES}, the one sorted factory
 * list every later tool ticket appends to. {@link buildAuthorTools}
 * builds them for a turn and returns them sorted by name so the model's
 * request prefix is stable across turns (and the tool list never
 * changes mid-session: factories register unconditionally, even when a
 * dependency has nothing to return).
 *
 * The deps are the tools' only window on the world: `workspace` resolves
 * the session's stores per call (PLAN §19.3 - `session.workspaceId`
 * through the app's WorkspaceResolver, never a closed-over singleton),
 * `catalog` is the D09 catalog data as an injectable seam, `templates`
 * is D17's catalog, `probeMcp` is D11's probe as a function, and
 * `docsDir` is the bundled SDK docs folder `searchDocs` reads.
 */
import type { AgentSpecV2, ToolDescriptor } from 'lousho';
import type { Requirement } from '../../../shared/authorWire';
import type {
  CatalogGuardrail,
  CatalogKit,
  CatalogModel,
  CatalogSkill,
  CatalogTool,
  CatalogTriggerType,
  McpServerSpecV2,
  TemplateSummary,
} from '../../../shared/wireTypes';
import type { McpProbeResult } from '../../routes/mcpProbe';
import type { SecretsStore } from '../../secretsStore';
import type { WorkspaceContext } from '../../workspace/context';
import type { ReviewDraft } from '../proposal/review';
import type { AuthorSessionStore } from '../sessionStore';
import type { AuthorTurn } from '../turnRunner';
import { readToolFactories } from './readTools';
import { probeMcpServerTool } from './mcpProbeTool';
import { searchDocsTool } from './searchDocsTool';
import { openPageTool } from './openPageTool';
import { proposeAgentTool } from './proposeAgentTool';
import { proposeAgentUpdateTool } from './proposeAgentUpdateTool';
import { saveAgentTool, saveAgentUpdateTool } from './saveTools';
import { requestSecretTool } from './requestSecretTool';
import { discardPendingChangesTool, setAgentEnabledTool } from './stateTools';
import { runDraftTool } from './runDraftTool';
import { getTraceTool } from './getTraceTool';

/**
 * A registry-index item that names an MCP server (`type: 'mcp'`,
 * carrying `command` and/or `url` like a spec's `mcpServers` entry).
 * No registry item is one today; `listMcpServers` lists them under
 * `source: 'registry'` when a registry starts shipping them.
 */
export interface RegistryMcpServer {
  key: string;
  command?: string;
  url?: string;
}

/**
 * The SDK/registry catalogs the read tools list from - D09's data
 * (`/catalog/*` routes and the SDK functions behind them) as an
 * injectable seam so tests fake it in memory.
 */
export interface CatalogService {
  /** `listModels` with a model's `available` also true when Studio holds a stored key for the provider. */
  listModels(provider?: string): CatalogModel[];
  /** `listBuiltinTools` rows, full `inputJsonSchema` included (the tool decides what to expose). */
  listTools(): CatalogTool[];
  listGuardrails(): CatalogGuardrail[];
  listTriggerTypes(): CatalogTriggerType[];
  listSkills(): Promise<CatalogSkill[]>;
  listKits(): Promise<CatalogKit[]>;
  /** Registry index items of `type: 'mcp'` - `listMcpServers`' `source: 'registry'` rows. */
  listRegistryMcpServers(): Promise<RegistryMcpServer[]>;
}

/** The template catalog `listTemplates` reads - D17's `TemplateCatalog` satisfies this shape. */
export interface TemplateService {
  list(): Promise<TemplateSummary[]>;
}

/** Everything the tools close over besides the turn itself. */
export interface AuthorToolDeps {
  /**
   * The session's workspace, resolved per call from
   * `session.workspaceId` through the app's `WorkspaceResolver`
   * (the PLAN §19.3 seam - until W02a it always resolves to the
   * launch context). Per-agent stores come off the context
   * (`(await deps.workspace()).repo`), never a closed-over singleton.
   */
  workspace: () => Promise<WorkspaceContext>;
  catalog: CatalogService;
  templates: TemplateService;
  /** `POST /catalog/mcp/probe`'s probe as a function - secret refs resolved, 10 s deadline. */
  probeMcp: (server: McpServerSpecV2) => Promise<McpProbeResult>;
  /** The bundled SDK docs folder `searchDocs` indexes (`<package root>/docs`, resolved in server/index.ts). */
  docsDir: string;
  /**
   * The draft review a propose tool runs before showing its card (PLAN
   * §8.4): AA12's `createReviewDraft` judge pass; tests wire `passReview`
   * (the always-approve double).
   */
  reviewDraft: ReviewDraft;
  /**
   * The spec's readiness rows for the proposal card (AA13's
   * `computeRequirements`, wired per turn to the session's workspace
   * root). Advisory - the propose tools degrade a throwing dep to `[]`.
   */
  requirements: (spec: AgentSpecV2) => Promise<Requirement[]>;
  /**
   * The Studio-global Author session store (files under
   * `studioPaths().sessions`): the save tools update
   * `createdAgentIds` through it after a create lands (AA10b).
   */
  sessions: AuthorSessionStore;
  /**
   * The Studio-global named-secrets store (D13). `requestSecret` only
   * ever reads masked status (`secretStatus`) to answer `'exists'` -
   * values are written by `POST /assistant/sessions/:id/secret`, never
   * through a tool, and nothing here decrypts them.
   */
  secrets: Pick<SecretsStore, 'secretStatus'>;
}

/** Builds one tool for one turn - the factories close over `turn` (and `deps`). */
export type AuthorToolFactory = (turn: AuthorTurn, deps: AuthorToolDeps) => ToolDescriptor;

/**
 * The Author's tools in factory order. AA06 registers the 13 read
 * tools; the propose, save, secret, run and page tools of later tickets
 * append here - the list is registered unconditionally so the tool
 * surface never changes between turns of a session.
 */
export const AUTHOR_TOOL_FACTORIES: readonly AuthorToolFactory[] = [
  ...readToolFactories,
  probeMcpServerTool,
  searchDocsTool,
  openPageTool,
  proposeAgentTool,
  proposeAgentUpdateTool,
  saveAgentTool,
  saveAgentUpdateTool,
  requestSecretTool,
  discardPendingChangesTool,
  setAgentEnabledTool,
  runDraftTool,
  getTraceTool,
];

/** The call name a `ToolDescriptor` carries (`defineTool`/loader results), else its display name. */
function nameOf(tool: ToolDescriptor): string {
  return (tool as { name?: string }).name ?? tool.displayName;
}

/** Builds every tool for one turn, sorted by name (stable request prefix). */
export function buildAuthorTools(turn: AuthorTurn, deps: AuthorToolDeps): ToolDescriptor[] {
  return AUTHOR_TOOL_FACTORIES.map((factory) => factory(turn, deps)).sort((a, b) =>
    nameOf(a).localeCompare(nameOf(b))
  );
}
