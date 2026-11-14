import type { Check } from '../../evals/checks';
import { SCRIPT_PATH } from '../contracts/validateModel';

/** Programmatic checks the host provides, by name; a criterion's `check` names one through {@link checkNameOf}. */
export interface WorkspaceCheckRegistry {
  /** The check registered under `name`, or `undefined`. */
  get(name: string): Check<unknown> | undefined;
}

/** A check registry over a plain map of names to checks. */
export function checkRegistry(checks: Readonly<Record<string, Check<unknown>>>): WorkspaceCheckRegistry {
  return { get: (name) => (Object.hasOwn(checks, name) ? checks[name] : undefined) };
}

/** The registry name of a criterion's `check`: a script path gives its base name without the extension (`harness/checks/script-present.ts` is `script-present`); a bare name or a `builtin:` ref is returned unchanged. A script file is never imported. */
export function checkNameOf(check: string): string {
  if (check.startsWith('builtin:') || !SCRIPT_PATH.test(check)) return check;
  return (check.split('/').pop() ?? check).replace(SCRIPT_PATH, '');
}

/** Resolves a criterion's `check` through the host registry by its {@link checkNameOf} name; `undefined` when the host has not registered it. */
export function resolveCheck(registry: WorkspaceCheckRegistry, check: string): Check<unknown> | undefined {
  return registry.get(checkNameOf(check));
}
