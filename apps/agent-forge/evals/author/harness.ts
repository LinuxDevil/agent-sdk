/**
 * The Author eval harness (AA21): runs one scenario's scripted
 * conversation through the production server path - the same stores,
 * `AuthorTurnRunner`, tool surface and Apply write path `createApp` builds
 * via `createAuthorServices` - over a throwaway workspace (`mkdtemp`), so
 * nothing the Author writes can touch a real project.
 *
 * Turn index of a tool call is its assistant message's ordinal (one turn
 * produces one assistant message; a continuation turn counts as its own
 * turn). `pressApplyAfterTurn` presses the card's Apply button through the
 * same `applyStoredProposal` `POST /assistant/sessions/:id/save` uses.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { agentSpecV2Schema, upgradeSpec, VERSION, type LLMProvider } from '@linuxdevil/lousho';
import { envCollector } from '../../server/host/hostSelector';
import { mockModel, type MockRequest, type MockStaticTurn, type MockToolCall } from '@linuxdevil/lousho/testing';
import type { AuthorMessage, AuthorServerEvent } from '../../shared/authorWire';
import { SecretsStore } from '../../server/secretsStore';
import { SettingsStore } from '../../server/settingsStore';
import { AuthorSessionStore } from '../../server/author/sessionStore';
import { createAuthorServices, type AuthorServices } from '../../server/author/services';
import { openProposalCards } from '../../server/author/proposal/gate';
import type { ReviewDraft } from '../../server/author/proposal/review';
import { TemplateCatalog } from '../../server/templates/templateCatalog';
import { AgentRepo } from '../../server/storage/agentRepo';
import { sdkRootDir } from '../../server/sdkRoot';
import { createWorkspaceContext, singleWorkspace, type WorkspaceContext } from '../../server/workspace/context';
import { workspaceRefFor } from '../../server/workspace/workspaceId';
import { studioPathsFor } from '../../server/workspace/studioPaths';
import { PassRunner } from '../../server/passes/passRunner';
import { SpendLog } from '../../server/passes/spendLog';
import { AlertStore } from '../../server/inbox/alertStore';
import { collectParts, type CollectedTranscript } from './checks';
import type { AuthorScenario } from './scenario';

/** Longest one turn may run before the harness counts it as a turn error. */
const TURN_TIMEOUT_MS = 180_000;

/** What the harness needs besides the scenario itself. */
export interface EvalHarnessOptions {
  /** The turn provider seam - mock mode passes the scripted mock here; real mode leaves it unset. */
  providerFor?: (model: string) => LLMProvider;
  /** The draft review seam (`--no-review` passes the always-approve one). */
  reviewDraft?: ReviewDraft;
  /** Per-turn deadline; defaults to {@link TURN_TIMEOUT_MS}. */
  turnTimeoutMs?: number;
  /** The bundled SDK docs folder `searchDocs` indexes; defaults to the repo's `docs/`. */
  docsDir?: string;
  /** Where `seed.agents` fixture yamls live (`evals/author/fixtures`). */
  fixturesDir: string;
  /**
   * Studio home for the GLOBAL stores (settings + secrets): real mode
   * uses the repo's `.lousho` so the configured Author key/model apply;
   * sessions and the workspace are always per-scenario temp dirs.
   * Defaults to the temp workspace's own `.lousho`.
   */
  globalHome?: string;
  /** Test seam: run inside this baseDir instead of a fresh mkdtemp. */
  baseDir?: string;
  /** Test seam: keep the baseDir on disk after the run. */
  keepDir?: boolean;
}

/** One scenario's run: the collected transcript facts, or why it could not run. */
export interface ScenarioRunOutcome {
  collected: CollectedTranscript;
  /** Tool names in call order (the results file's `toolCalls`). */
  toolCallNames: string[];
  /** The final transcript (the judge reads it). */
  transcript: AuthorMessage[];
  createdAgentIds: string[];
  durationMs: number;
  /** A plumbing failure (turn error/timeout, a refused send, an Apply with no card) - not a check failure. */
  error?: string;
}

/** The stores/context one scenario's temp workspace gets - the same constructors `createApp` uses. */
interface EvalServices {
  services: AuthorServices;
  sessions: AuthorSessionStore;
  workspace: WorkspaceContext;
}

/**
 * Builds the stores, workspace and Author services for one scenario run:
 * Studio-global stores over `globalHome` (secrets/settings), the session
 * store under the temp baseDir, a real `WorkspaceContext` for it
 * (`createWorkspaceContext`, what `startStudioServer` calls) and the
 * shared `createAuthorServices` bundle.
 */
function createEvalServices(baseDir: string, opts: EvalHarnessOptions): EvalServices {
  const globalPaths = studioPathsFor(opts.globalHome ?? path.join(baseDir, '.lousho'));
  const secrets = new SecretsStore(globalPaths);
  const settings = new SettingsStore(globalPaths);
  const sessionsDir = path.join(baseDir, '.lousho', 'assistant', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessions = new AuthorSessionStore(sessionsDir);
  const evalSpendLog = new SpendLog(path.join(baseDir, '.lousho', 'passes', 'spend.jsonl'));
  const workspace = createWorkspaceContext(workspaceRefFor(baseDir), {
    secretsStore: secrets,
    settingsStore: settings,
    observe: false,
    // Evals never run real passes; the runner exists only to satisfy the
    // context shape, writing to a throwaway spend log under baseDir (one
    // instance shared with `spendLog` below so appends stay serialized).
    passRunner: new PassRunner({
      baseDir,
      spendLog: evalSpendLog,
      isEnabled: () => false,
    }),
    spendLog: evalSpendLog,
    // Evals never trigger runs; the store exists only to satisfy the
    // context shape, under the same throwaway `.lousho` as the spend log.
    alerts: new AlertStore(globalPaths.alerts),
    // Evals run in-process only; the collector/version exist for the
    // host selector's shape (a bridge candidate would still spawn - eval
    // baseDirs carry no SDK install, so selection lands in-process).
    collector: { url: () => envCollector().url, token: () => envCollector().token },
    studioVersion: VERSION,
  });
  const workspaceResolver = singleWorkspace(workspace);
  const services = createAuthorServices({
    sessions,
    settings,
    secrets,
    templates: new TemplateCatalog(),
    docsDir: opts.docsDir ?? path.join(sdkRootDir(), 'docs'),
    workspaceResolver,
    ...(opts.providerFor ? { providerFor: opts.providerFor } : {}),
    ...(opts.reviewDraft ? { reviewDraft: opts.reviewDraft } : {}),
  });
  return { services, sessions, workspace };
}

/** Seeds `seed.agents` fixtures through the workspace's AgentRepo (agent id = fixture name). */
async function seedFixtures(repo: AgentRepo, scenario: AuthorScenario, fixturesDir: string): Promise<void> {
  for (const name of scenario.seed?.agents ?? []) {
    const raw = fs.readFileSync(path.join(fixturesDir, `${name}.yaml`), 'utf8');
    const spec = agentSpecV2Schema.parse(upgradeSpec(parseYaml(raw)));
    await repo.writeSpec(name, spec);
  }
}

/** A turn-end wait that must be attached BEFORE `runner.start` so no terminal event is missed. */
interface TurnWait {
  promise: Promise<AuthorServerEvent>;
  /** Stops listening and the timeout (used when `start` refused, so nothing leaks or rejects unhandled). */
  cancel: () => void;
}

/** Waits for the turn's terminal event (`turn.finished`/`turn.error`) or rejects on timeout. */
function waitTurnEnd(
  services: AuthorServices,
  sessionId: string,
  requestId: string,
  timeoutMs: number
): TurnWait {
  let cancel: () => void = () => undefined;
  const promise = new Promise<AuthorServerEvent>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      services.runner.off('event', onEvent);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`turn timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = (sid: string, ev: AuthorServerEvent): void => {
      if (sid !== sessionId || ev.requestId !== requestId) return;
      if (ev.type === 'turn.finished' || ev.type === 'turn.error') {
        cleanup();
        resolve(ev);
      }
    };
    cancel = () => {
      cleanup();
      resolve({ type: 'turn.error', requestId, seq: -1, message: 'cancelled' });
    };
    services.runner.on('event', onEvent);
  });
  // The cancel-resolution above resolves rather than rejects, so an
  // abandoned wait can never crash the run as an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, cancel: () => cancel() };
}

/**
 * Runs one scenario: fresh temp workspace, seeded fixtures, one session,
 * the scripted turns (each awaited to `turn.finished`/`turn.error`), the
 * optional Apply press after its turn, then the collected facts for the
 * hard checks and the judge.
 */
export async function runAuthorScenario(
  scenario: AuthorScenario,
  opts: EvalHarnessOptions
): Promise<ScenarioRunOutcome> {
  const started = Date.now();
  const baseDir = opts.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lou-author-eval-'));
  const keepDir = opts.keepDir === true || opts.baseDir !== undefined;
  try {
    const { services, sessions, workspace } = createEvalServices(baseDir, opts);
    await seedFixtures(workspace.repo, scenario, opts.fixturesDir);
    const session = await sessions.create(scenario.focus ?? { mode: 'create' }, workspace.ref.id);
    const error = await runTurns(services, sessions, session.id, scenario, opts.turnTimeoutMs ?? TURN_TIMEOUT_MS);
    return await assembleOutcome(workspace.repo, sessions, session.id, error, Date.now() - started);
  } finally {
    if (!keepDir) fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

/** Reads the finished session and folds its transcript into the run's {@link ScenarioRunOutcome}. */
async function assembleOutcome(
  repo: AgentRepo,
  sessions: AuthorSessionStore,
  sessionId: string,
  error: string | undefined,
  durationMs: number
): Promise<ScenarioRunOutcome> {
  const stored = await sessions.get(sessionId);
  const transcript = stored?.transcript ?? [];
  const collected = await collectTranscript(repo, transcript, stored?.createdAgentIds ?? []);
  return {
    collected,
    toolCallNames: collected.toolCalls.map((call) => call.name),
    transcript,
    createdAgentIds: stored?.createdAgentIds ?? [],
    durationMs,
    ...(error !== undefined && { error }),
  };
}

/**
 * The scripted turns: each send awaited to `turn.finished`/`turn.error`
 * (or the per-turn timeout), with the Apply press after its turn.
 * Returns the first error line, or `undefined` when every turn ran.
 */
async function runTurns(
  services: AuthorServices,
  sessions: AuthorSessionStore,
  sessionId: string,
  scenario: AuthorScenario,
  timeoutMs: number
): Promise<string | undefined> {
  let error: string | undefined;
  for (const [i, text] of scenario.turns.entries()) {
    const requestId = `req_${i}_${randomBytes(6).toString('hex')}`;
    const waiting = waitTurnEnd(services, sessionId, requestId, timeoutMs);
    const start = await services.runner.start(sessionId, { requestId, text });
    if (!start.ok) {
      waiting.cancel();
      return `turn ${i} refused to start (${start.code}: ${start.message})`;
    }
    try {
      const terminal = await waiting.promise;
      if (terminal.type === 'turn.error') return `turn ${i} failed: ${terminal.message}`;
    } catch (turnError) {
      return turnError instanceof Error ? turnError.message : String(turnError);
    }
    if (scenario.pressApplyAfterTurn === i) {
      error = (await applyNewestCard(services, sessions, sessionId)) ?? error;
    }
  }
  return error;
}

/**
 * The Apply press: finds the newest still-open card in the stored
 * transcript and writes it through the production `applyStoredProposal`.
 * Returns an error line when there was no card to press or the write
 * refused - the hard checks then decide what that means.
 */
async function applyNewestCard(
  services: AuthorServices,
  sessions: AuthorSessionStore,
  sessionId: string
): Promise<string | undefined> {
  const session = await sessions.get(sessionId);
  if (session === undefined) return 'Apply press: session vanished';
  const newest = openProposalCards(session.transcript).at(-1);
  if (newest === undefined) return 'Apply press: no open proposal card';
  const outcome = await services.applyCard(session, newest.proposalId);
  return outcome.ok ? undefined : `Apply press refused (${outcome.code}: ${outcome.userMessage})`;
}

/**
 * Folds the finished transcript into {@link CollectedTranscript}: tool
 * calls and assistant texts via {@link collectParts}, plus the saved spec
 * of every agent a successful save (tool call or Apply `uiEvent`) wrote.
 */
async function collectTranscript(
  repo: AgentRepo,
  transcript: readonly AuthorMessage[],
  createdAgentIds: string[]
): Promise<CollectedTranscript> {
  const parts = collectParts(transcript);
  const savedSpecs: unknown[] = [];
  for (const agentId of savedAgentIds(transcript)) {
    const spec = await repo.readSpec(agentId);
    if (spec !== undefined) savedSpecs.push(spec);
  }
  return { ...parts, savedSpecs, createdAgentIds };
}

/** The agent id a successful save tool part wrote, if this part is one. */
function savedIdOf(part: { type: string; name?: string; state?: string; output?: unknown }): string | undefined {
  if (part.type !== 'tool' || (part.name !== 'saveAgent' && part.name !== 'saveAgentUpdate')) return undefined;
  const agentId = (part.output as { agentId?: unknown } | undefined)?.agentId;
  return part.state === 'done' && typeof agentId === 'string' ? agentId : undefined;
}

/** Every agent id a successful save wrote: save tool outputs plus the Apply `uiEvent` messages. */
function savedAgentIds(transcript: readonly AuthorMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of transcript) {
    if (message.role === 'user') {
      if (message.uiEvent?.kind === 'save') ids.add(message.uiEvent.agentId);
      continue;
    }
    for (const part of message.parts) {
      const id = savedIdOf(part);
      if (id !== undefined) ids.add(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// --mock: the scripted provider. Plumbing only - it calls the tools each
// scenario expects (in turn order, writes only after turn 0, never a save
// in the same turn as its propose) so the save gate, Apply path and hard
// checks all exercise real code.
// ---------------------------------------------------------------------------

/** Text content of a request message (content may be a string or parts). */
function messageText(message: { content?: unknown }): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
}

/** The 0-based scenario turn a model call belongs to: count of real user texts before it. */
function turnIndexOf(request: MockRequest): number {
  let count = 0;
  for (const message of request.messages) {
    if (message.role === 'user' && !messageText(message).startsWith('[UI event]')) count += 1;
  }
  return count - 1;
}

/** The toolCallId of the newest `toolName` call the transcript shows. */
function lastCallId(request: MockRequest, toolName: string): string | undefined {
  let found: string | undefined;
  for (const message of request.messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.function.name === toolName) found = call.id;
    }
  }
  return found;
}

/** The newest `agentId` the transcript mentions (a save output or an Apply `uiEvent`). */
function lastAgentId(request: MockRequest): string | undefined {
  let found: string | undefined;
  for (const message of request.messages) {
    const text = messageText(message);
    const saveMatch = /"agentId":\s*"([^"]+)"/.exec(text) ?? /\(id "([^"]+)"\)/.exec(text);
    if (saveMatch !== null) found = saveMatch[1];
  }
  return found;
}

/** The agent id an agent-scoped tool should name: the focused agent, else the last one saved. */
function agentArg(request: MockRequest, focusAgent: string | undefined): string {
  return focusAgent ?? lastAgentId(request) ?? 'support-triage';
}

type MockArgFn = (request: MockRequest, focusAgent: string | undefined) => Record<string, unknown> | undefined;

/** Canned inputs for the tools whose args depend on the conversation (ids, proposals). */
const DYNAMIC_MOCK_ARGS: Record<string, MockArgFn> = {
  getCurrentSpec: (request, focusAgent) => ({ agentId: agentArg(request, focusAgent) }),
  proposeAgentUpdate: (request, focusAgent) => ({
    agentId: agentArg(request, focusAgent),
    patch: { description: 'Updated by the eval mock.' },
  }),
  saveAgent: (request) => {
    const proposalId = lastCallId(request, 'proposeAgent');
    return proposalId === undefined ? undefined : { proposalId };
  },
  saveAgentUpdate: (request, focusAgent) => {
    const proposalId = lastCallId(request, 'proposeAgentUpdate');
    return proposalId === undefined ? undefined : { agentId: agentArg(request, focusAgent), proposalId };
  },
  setAgentEnabled: (request, focusAgent) => ({ agentId: agentArg(request, focusAgent), enabled: true }),
  discardPendingChanges: (_request, focusAgent) => (focusAgent === undefined ? {} : { agentId: focusAgent }),
  runDraft: (request, focusAgent) => ({ agentId: agentArg(request, focusAgent), input: 'Hello' }),
};

/** Canned constant inputs for the rest of the tool surface. */
const STATIC_MOCK_ARGS: Record<string, Record<string, unknown>> = {
  proposeAgent: {
    draft: {
      name: 'Eval draft agent',
      description: 'Answers questions briefly for the eval suite.',
      model: 'anthropic/claude-haiku-5-5',
      instructions: 'You answer questions briefly and clearly.',
      triggers: [{ id: 't1', type: 'chat' }],
    },
  },
  requestSecret: { name: 'EVAL_API_TOKEN', why: 'The agent needs this token to call the API.' },
  searchDocs: { query: 'handoffs versus subagents' },
  openPage: { path: '/agents' },
  getTrace: { traceId: 'tr_eval' },
};

/** Canned valid input for one tool name, or `undefined` to skip the call. */
function mockArgs(name: string, request: MockRequest, focusAgent: string | undefined): Record<string, unknown> | undefined {
  const dynamic = DYNAMIC_MOCK_ARGS[name];
  if (dynamic !== undefined) return dynamic(request, focusAgent);
  return STATIC_MOCK_ARGS[name] ?? {};
}

/** Whether `name` is a save write (never legal in turn 0 or beside its own propose). */
function isSaveTool(name: string): boolean {
  return name === 'saveAgent' || name === 'saveAgentUpdate';
}

/**
 * The `--mock` provider for one scenario: a function-turn `mockModel`
 * that calls the scenario's `expect.tools` in order across its turns -
 * writes only after turn 0 and never a save in the same turn as a
 * propose, so the mock exercises the real save gate without tripping the
 * safety checks the suite exists to enforce. Replays its one turn
 * forever (`repeat-last`), answering 'Done.' after any tool result.
 */
export function evalMockProvider(scenario: AuthorScenario): LLMProvider {
  const pending = [...(scenario.expect.tools ?? [])];
  const focusAgent = scenario.focus?.mode === 'edit' ? scenario.focus.agentId : undefined;
  const turn = (request: MockRequest): MockStaticTurn => {
    const last = request.messages.at(-1);
    if (last === undefined || last.role !== 'user') return { text: 'Done.' };
    const calls = plannedCalls(pending, request, focusAgent);
    return calls.length === 0 ? { text: 'Done.' } : { toolCalls: calls };
  };
  return mockModel([turn], { onExhausted: 'repeat-last' });
}

/**
 * The tool calls one mock turn emits: consumes `pending` in order,
 * writes only after turn 0 and never a save beside a propose or another
 * save in the same turn.
 */
function plannedCalls(
  pending: string[],
  request: MockRequest,
  focusAgent: string | undefined
): MockToolCall[] {
  const calls: MockToolCall[] = [];
  const turnIndex = turnIndexOf(request);
  while (pending.length > 0) {
    const name = pending[0];
    const proposes = calls.some((call) => (call.name as string).startsWith('propose'));
    if (isSaveTool(name) && (turnIndex === 0 || proposes)) break;
    const args = mockArgs(name, request, focusAgent);
    pending.shift();
    if (args !== undefined) calls.push({ name, args });
    const next = pending[0];
    if (isSaveTool(name) && next !== undefined && (isSaveTool(next) || next.startsWith('propose'))) break;
  }
  return calls;
}
