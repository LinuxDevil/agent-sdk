/**
 * The catalog checks a propose tool runs between schema validation and
 * requirements (research §4.1 steps 4-8): every value the draft names that
 * must exist in Studio's catalogs - its models, builtin tools, guardrails,
 * trigger types and agent references - is verified against
 * {@link CatalogFacts}, and all problems come back in ONE failure so the
 * model can fix them in a single retry instead of one round-trip each.
 *
 * The schema already rejects malformed values (a `{ builtin }` the spec
 * grammar does not know never reaches here); these checks are about
 * membership in the live catalogs the `deps.catalog`/`deps.workspace`
 * seams report, which the prompt lists and the model copies ids from.
 *
 * {@link loadCatalogFacts} reads the catalogs once per turn (memoized in
 * `turn.state['catalogFacts']`): the model may propose several drafts in
 * a turn and the catalogs cannot change mid-turn.
 */
import type { AgentSpecV2 } from 'lousho';
import type { AuthorFailureCode, AuthorToolFailure } from '../../../shared/authorWire';
import type { AuthorTurn } from '../turnRunner';
import { toolFailure } from '../tools/failure';
import type { AuthorToolDeps } from '../tools/index';

/** The catalog membership sets the checks run against, loaded once per turn. */
export interface CatalogFacts {
  /** 'provider/model' ids the model catalog knows. */
  modelIds: ReadonlySet<string>;
  /** Builtin tool names `listTools` lists. */
  builtinTools: ReadonlySet<string>;
  /** Guardrail names `listGuardrails` lists. */
  guardrails: ReadonlySet<string>;
  /** Trigger types `listTriggerTypes` lists. */
  triggerTypes: ReadonlySet<string>;
  /** Agent ids in the session's workspace (`repo.listIds()`). */
  agentIds: ReadonlySet<string>;
}

/** The `turn.state` key the memoized {@link CatalogFacts} promise lives under. */
const CATALOG_FACTS_KEY = 'catalogFacts';

/**
 * The turn's {@link CatalogFacts}: read once and memoized in
 * `turn.state['catalogFacts']` (the promise itself is cached, so two
 * racing calls share the load). Models, tools, guardrails and trigger
 * types come from `deps.catalog`; agent ids from the session's workspace.
 */
export function loadCatalogFacts(turn: AuthorTurn, deps: AuthorToolDeps): Promise<CatalogFacts> {
  const existing = turn.state.get(CATALOG_FACTS_KEY) as Promise<CatalogFacts> | undefined;
  if (existing !== undefined) return existing;
  const promise = (async (): Promise<CatalogFacts> => {
    const [{ repo }, models, tools, guardrails, triggers] = await Promise.all([
      deps.workspace(),
      deps.catalog.listModels(),
      deps.catalog.listTools(),
      deps.catalog.listGuardrails(),
      deps.catalog.listTriggerTypes(),
    ]);
    return {
      modelIds: new Set(models.map((model) => model.id)),
      builtinTools: new Set(tools.map((tool) => tool.name)),
      guardrails: new Set(guardrails.map((guardrail) => guardrail.name)),
      triggerTypes: new Set(triggers.map((trigger) => trigger.type)),
      agentIds: new Set(repo.listIds()),
    };
  })();
  turn.state.set(CATALOG_FACTS_KEY, promise);
  return promise;
}

/** One catalog problem: the failure code it picks when it is the first found, and its model-facing text. */
interface CatalogProblem {
  code: AuthorFailureCode;
  text: string;
}

/** `model` and each `fallbackModels[i]` must be ids the model catalog knows. */
function modelProblems(spec: AgentSpecV2, facts: CatalogFacts): CatalogProblem[] {
  return [spec.model, ...(spec.fallbackModels ?? [])]
    .filter((model) => !facts.modelIds.has(model))
    .map((model) => ({ code: 'UNKNOWN_MODEL' as const, text: `model "${model}" is not in the catalog` }));
}

/** Each `tools[i].builtin` must be a builtin the tool catalog knows. */
function toolProblems(spec: AgentSpecV2, facts: CatalogFacts): CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  (spec.tools ?? []).forEach((ref, i) => {
    if ('builtin' in ref && !facts.builtinTools.has(ref.builtin)) {
      problems.push({ code: 'UNKNOWN_TOOL', text: `tools[${i}] builtin "${ref.builtin}" does not exist` });
    }
  });
  return problems;
}

/** Each `guardrails[i].name` must be a guardrail the catalog knows. */
function guardrailProblems(spec: AgentSpecV2, facts: CatalogFacts): CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  (spec.guardrails ?? []).forEach((entry, i) => {
    if (!facts.guardrails.has(entry.name)) {
      problems.push({ code: 'UNKNOWN_GUARDRAIL', text: `guardrails[${i}] name "${entry.name}" does not exist` });
    }
  });
  return problems;
}

/** Each `triggers[i].type` must be a trigger type the catalog knows. */
function triggerProblems(spec: AgentSpecV2, facts: CatalogFacts): CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  (spec.triggers ?? []).forEach((entry, i) => {
    if (!facts.triggerTypes.has(entry.type)) {
      problems.push({ code: 'UNKNOWN_TRIGGER_TYPE', text: `triggers[${i}] type "${entry.type}" does not exist` });
    }
  });
  return problems;
}

/**
 * Agent references must name workspace agents: each `subagents.<key>.ref`,
 * and each `handoffs[i].agent` unless it names one of the spec's own
 * `subagents` keys (a handoff to an inline subagent is legal).
 */
function agentRefProblems(spec: AgentSpecV2, facts: CatalogFacts): CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  const subagentKeys = new Set(Object.keys(spec.subagents ?? {}));
  for (const [key, entry] of Object.entries(spec.subagents ?? {})) {
    if ('ref' in entry && !facts.agentIds.has(entry.ref)) {
      problems.push({ code: 'UNKNOWN_AGENT_REF', text: `subagents.${key}.ref agent "${entry.ref}" does not exist` });
    }
  }
  (spec.handoffs ?? []).forEach((entry, i) => {
    if (!subagentKeys.has(entry.agent) && !facts.agentIds.has(entry.agent)) {
      problems.push({ code: 'UNKNOWN_AGENT_REF', text: `handoffs[${i}].agent agent "${entry.agent}" does not exist` });
    }
  });
  return problems;
}

/** The most problems one failure lists; the code is still the first problem's. */
const MAX_LISTED_PROBLEMS = 10;

/**
 * All of `spec`'s catalog problems in one {@link AuthorToolFailure}, or
 * `null` when every value is known. Problems are collected in check order
 * (models, tools, guardrails, triggers, agent refs); the first problem's
 * code is the failure's code and at most ten problem texts are listed.
 */
export function checkCatalogs(spec: AgentSpecV2, facts: CatalogFacts, toolName: string): AuthorToolFailure | null {
  const problems = [
    ...modelProblems(spec, facts),
    ...toolProblems(spec, facts),
    ...guardrailProblems(spec, facts),
    ...triggerProblems(spec, facts),
    ...agentRefProblems(spec, facts),
  ];
  if (problems.length === 0) return null;
  const listed = problems.slice(0, MAX_LISTED_PROBLEMS).map((problem) => problem.text).join('; ');
  return toolFailure(
    problems[0].code,
    `Some values are not in Studio's catalogs: ${listed}.`,
    "The draft referred to something Studio doesn't have. The Author is fixing it.",
    `Call listModels, listTools, listGuardrails, listTriggerTypes or listAgents and copy exact values, then call ${toolName} again.`
  );
}
