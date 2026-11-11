import { z } from 'zod';

const PROVIDER_NAME = /^[a-z][a-z0-9-]*$/;

const providerNameSchema = z
  .string()
  .regex(PROVIDER_NAME, "must be a provider name from the built-in provider list, e.g. 'pi'");

export const modelsObjectSchema = z.object({ provider: providerNameSchema.nullable().optional() }).strict();

/** Which level supplied a page's model. */
export type PageModelSource = 'attachment' | 'page' | 'agent' | 'workspace' | 'none';

/** Inputs to {@link resolvePageModel}; every field is optional. */
export interface PageModelInputs {
  /** The attachment's `model` in `agents.json`. */
  attachmentModel?: string;
  /** The page's `defaults.model`. */
  pageDefault?: string;
  /** The agent's own default model. */
  agentDefault?: string;
  /** The workspace's `defaults.model`. */
  workspaceDefault?: string;
  /** The page's `models.provider`; `null` opts the page out of the wrapper. */
  pageProvider?: string | null;
  /** The workspace's `models.provider`. */
  workspaceProvider?: string | null;
}

/** The model a page runs with and the level it came from. */
export interface ResolvedPageModel {
  /** The model spec after the provider wrapper, or `undefined` when no level sets one. */
  model: string | undefined;
  /** The level that won. */
  source: PageModelSource;
}

const PRECEDENCE: ReadonlyArray<readonly [Exclude<PageModelSource, 'none'>, keyof PageModelInputs]> = [
  ['attachment', 'attachmentModel'],
  ['page', 'pageDefault'],
  ['agent', 'agentDefault'],
  ['workspace', 'workspaceDefault'],
];

function effectiveProvider(inputs: PageModelInputs): string | null | undefined {
  return inputs.pageProvider !== undefined ? inputs.pageProvider : inputs.workspaceProvider;
}

function wrap(model: string, provider: string | null | undefined): string {
  if (!provider || model.startsWith(`${provider}/`)) return model;
  return `${provider}/${model}`;
}

/** Picks a page's model (attachment > page > agent > workspace) and applies `models.provider`; never use it for `improve.proposerModel` or a Determinator model (R8). */
export function resolvePageModel(inputs: PageModelInputs): ResolvedPageModel {
  for (const [source, key] of PRECEDENCE) {
    const model = inputs[key];
    if (typeof model === 'string' && model !== '') return { model: wrap(model, effectiveProvider(inputs)), source };
  }
  return { model: undefined, source: 'none' };
}
