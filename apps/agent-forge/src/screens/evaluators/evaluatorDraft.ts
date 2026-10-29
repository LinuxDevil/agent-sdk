/**
 * The evaluator form's state as typed (every field a string or flag), and the
 * conversions to what the daemon takes: a create body and, for the edit view,
 * a partial `PUT` holding only the fields that changed.
 */
import type { ProviderKeyStatus } from '../../../shared/wireTypes';
import type { EvaluatorPatch, NewEvaluator, ObserveEvaluator, ObserveEvaluatorFilter } from '../../observe/types';
import { MOCK_PROVIDER, defaultProvider, modelString } from '../playground/request';
import { SAMPLE_CODE } from './evaluatorsUrl';

/** One evaluator as the form edits it. */
export interface EvaluatorDraft {
  name: string;
  kind: 'code' | 'judge';
  source: string;
  /** Judge: the provider select (`''` = custom, the whole `provider/model` typed in `model`). */
  provider: string;
  model: string;
  rubric: string;
  agentId: string;
  status: '' | 'ok' | 'error';
  nameContains: string;
  sampleRate: string;
  enabled: boolean;
}

/** A new rule's starting draft: a code rule with the sample source, every trace, always run. */
export function blankDraft(keys: readonly ProviderKeyStatus[]): EvaluatorDraft {
  return {
    name: '',
    kind: 'code',
    source: SAMPLE_CODE,
    provider: defaultProvider(keys),
    model: '',
    rubric: '',
    agentId: '',
    status: '',
    nameContains: '',
    sampleRate: '1',
    enabled: true,
  };
}

/** A judge `model` string split for the provider select: `mock`, `provider/model`, or a bare provider. */
function splitModel(model: string): { provider: string; model: string } {
  if (model === MOCK_PROVIDER) return { provider: MOCK_PROVIDER, model: '' };
  const slash = model.indexOf('/');
  return slash < 0 ? { provider: model, model: '' } : { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

/** The draft of an existing rule (the edit view). */
export function draftFrom(rule: ObserveEvaluator, keys: readonly ProviderKeyStatus[]): EvaluatorDraft {
  const base: EvaluatorDraft = {
    ...blankDraft(keys),
    name: rule.name,
    kind: rule.kind,
    agentId: rule.filter.agent_id ?? '',
    status: rule.filter.status ?? '',
    nameContains: rule.filter.name_contains ?? '',
    sampleRate: String(rule.sample_rate),
    enabled: rule.enabled,
  };
  if (rule.kind === 'code') return { ...base, source: rule.config.source };
  return { ...base, ...splitModel(rule.config.model), rubric: rule.config.rubric };
}

/** The sample rate as a number, `undefined` unless it is in [0, 1]. */
function sampleRateOf(draft: EvaluatorDraft): number | undefined {
  const text = draft.sampleRate.trim();
  const rate = Number(text);
  return text !== '' && Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : undefined;
}

/** Why the draft can't be saved yet, or `undefined` when it can. */
export function draftProblem(draft: EvaluatorDraft): string | undefined {
  if (draft.name.trim() === '') return 'Give the evaluator a name.';
  if (sampleRateOf(draft) === undefined) return 'Sample rate is a number from 0 to 1.';
  if (draft.kind === 'code') return draft.source.trim() === '' ? 'Write the evaluator function.' : undefined;
  return draft.rubric.trim() === '' ? 'Write the rubric the judge grades by.' : undefined;
}

function filterOf(draft: EvaluatorDraft): ObserveEvaluatorFilter {
  const filter: ObserveEvaluatorFilter = {};
  if (draft.agentId) filter.agent_id = draft.agentId;
  if (draft.status) filter.status = draft.status;
  const contains = draft.nameContains.trim();
  if (contains) filter.name_contains = contains;
  return filter;
}

/** The create body (`POST /api/v1/evaluators`). Call only when {@link draftProblem} is `undefined`. */
export function toNewEvaluator(draft: EvaluatorDraft): NewEvaluator {
  const common = { name: draft.name.trim(), enabled: draft.enabled, filter: filterOf(draft), sample_rate: sampleRateOf(draft) ?? 1 };
  if (draft.kind === 'code') return { ...common, kind: 'code', config: { source: draft.source } };
  return { ...common, kind: 'judge', config: { model: modelString(draft.provider, draft.model), rubric: draft.rubric } };
}

/** Shallow equality over string-valued records, key order ignored. */
function same(a: object, b: object): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((key) => x[key] === y[key]);
}

/**
 * The partial `PUT` from `rule` to `next`: only the changed fields. A changed
 * `kind` carries its `config` (the daemon checks the merged rule as a whole).
 */
export function evaluatorPatch(rule: ObserveEvaluator, next: NewEvaluator): EvaluatorPatch {
  const patch: EvaluatorPatch = {};
  if (next.name !== rule.name) patch.name = next.name;
  if (next.enabled !== rule.enabled) patch.enabled = next.enabled;
  if (next.sample_rate !== rule.sample_rate) patch.sample_rate = next.sample_rate;
  if (!same(next.filter ?? {}, rule.filter)) patch.filter = next.filter;
  if (next.kind !== rule.kind) patch.kind = next.kind;
  if (next.kind !== rule.kind || !same(next.config, rule.config)) patch.config = next.config;
  return patch;
}
