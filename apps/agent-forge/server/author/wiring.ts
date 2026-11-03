/**
 * The production wiring of the app's one `AuthorTurnRunner`: byte-stable
 * system prompt (AA05) + AA06's tool surface over the per-turn workspace
 * resolution (PLAN 19.3: the session's stored `workspaceId` through the
 * app's `WorkspaceResolver`, never a closed-over store).
 *
 * Shared by `createApp` (its default when `options.authorRunner` is
 * absent) and by `startStudioServer`, which needs the same runner
 * instance for `WS /assistant/stream` as the REST routes consult - a
 * second runner would have its own turn slots and the one-running-turn-
 * per-session rule (and the DELETE 409) would stop holding.
 */
import { listBuiltinTools, listGuardrails, listModels, listTriggerTypes, type LLMProvider } from 'lousho';
import type { connectMcp } from 'lousho/mcp';
import type { SettingsStore } from '../settingsStore';
import type { SecretsStore } from '../secretsStore';
import type { TemplateCatalog } from '../templates/templateCatalog';
import type { WorkspaceContext, WorkspaceResolver } from '../workspace/context';
import { probeMcpServer, type McpProbeDeps } from '../routes/mcpProbe';
import { AuthorTurnRunner, type AuthorTurn } from './turnRunner';
import type { AuthorSessionStore } from './sessionStore';
import { buildAuthorSystemPrompt, type AuthorPromptCatalogs } from './prompt/index';
import { buildAuthorTools, type AuthorToolDeps } from './tools/index';
import { createAuthorCatalogService } from './tools/catalogService';
import { passReview } from './proposal/review';
import { computeRequirements, requirementDeps } from './requirements';

/**
 * The D09 catalog functions (`/catalog/*` reads the same SDK calls)
 * projected onto the prompt's env-free {@link AuthorPromptCatalogs} shape:
 * a model's `available` flag and everything else that depends on keys or
 * the environment stays out of the byte-stable system prompt.
 */
function authorPromptCatalogs(): AuthorPromptCatalogs {
  return {
    models: listModels().map((model) => ({
      id: model.id,
      capabilities: {
        tools: model.capabilities.tools,
        vision: model.capabilities.vision,
        reasoning: model.capabilities.reasoning,
        structuredOutput: model.capabilities.structuredOutput,
      },
    })),
    tools: listBuiltinTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      needsCredentials: tool.needsCredentials,
      mutating: tool.mutating,
    })),
    guardrails: listGuardrails().map((guardrail) => ({
      name: guardrail.name,
      description: guardrail.description,
      on: [...guardrail.on],
    })),
    triggers: listTriggerTypes().map((trigger) => ({ type: trigger.type, description: trigger.description })),
  };
}

/** Everything {@link createAuthorRunner} needs that callers already hold at wiring time. */
export interface CreateAuthorRunnerDeps {
  sessions: AuthorSessionStore;
  settings: SettingsStore;
  secrets: SecretsStore;
  /** The app's one template catalog (`GET /templates*` and `POST /agents` share it too). */
  templates: TemplateCatalog;
  /** The bundled SDK docs folder `searchDocs` indexes (`server/index.ts` resolves it). */
  docsDir: string;
  /** Session `workspaceId` -> the workspace its turns edit agents in. */
  workspaceResolver: WorkspaceResolver;
  /** Test seam for the `probeMcpServer` tool; defaults to the SDK's `connectMcp`. */
  mcpConnect?: typeof connectMcp;
  /** Test seam: resolves the turn provider without the stored/env key lookup. */
  providerFor?: (model: string) => LLMProvider;
}

/**
 * Builds the `AuthorTurnRunner` with the real system prompt and tool
 * surface. The prompt renders once here (it is byte-stable), the tools
 * build per turn so they close over that turn's `AuthorTurn`.
 */
export function createAuthorRunner(deps: CreateAuthorRunnerDeps): AuthorTurnRunner {
  const authorPrompt = buildAuthorSystemPrompt(authorPromptCatalogs());
  const probeDeps: McpProbeDeps = {
    resolveSecret: (name: string) => deps.secrets.getSecret(name),
    ...(deps.mcpConnect ? { connect: deps.mcpConnect } : {}),
  };
  // `workspace` (and `requirements`, which reads under the workspace
  // root) is bound per turn below. `reviewDraft` is AA12's seam;
  // passReview is the always-approve default until it lands.
  const toolDeps: Omit<AuthorToolDeps, 'workspace' | 'requirements'> = {
    catalog: createAuthorCatalogService({ secretsStore: deps.secrets }),
    templates: deps.templates,
    probeMcp: (server) => probeMcpServer(server, probeDeps),
    docsDir: deps.docsDir,
    reviewDraft: passReview,
  };
  const workspaceForTurn = async (turn: AuthorTurn): Promise<WorkspaceContext> => {
    const session = await deps.sessions.get(turn.sessionId);
    const ctx = await deps.workspaceResolver.resolve(session?.workspaceId);
    if (ctx === undefined) {
      throw new Error(`Workspace '${session?.workspaceId ?? 'unknown'}' is not available.`);
    }
    return ctx;
  };
  return new AuthorTurnRunner({
    sessions: deps.sessions,
    settings: deps.settings,
    secrets: deps.secrets,
    systemPrompt: () => authorPrompt,
    buildTools: (turn) =>
      buildAuthorTools(turn, {
        ...toolDeps,
        workspace: () => workspaceForTurn(turn),
        // AA13's readiness rows, resolved against the session's workspace
        // root per call (fileExist checks stay inside that root).
        requirements: async (spec) =>
          computeRequirements(spec, requirementDeps((await workspaceForTurn(turn)).ref.root, deps.secrets)),
      }),
    // Stand-in until AA07 lands the real turnContextInput.
    turnContextInput: async (s, now) => ({ focus: s.focus, openProposals: [], now }),
    ...(deps.providerFor ? { providerFor: deps.providerFor } : {}),
  });
}
