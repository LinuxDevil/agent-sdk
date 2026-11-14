import { SDKError } from '../../../utils/sdkError';
import { singleEngine } from './single';
import type { EngineRegistry, PageEngineFactory } from './types';

/** The built-in engines by execution type; the other types land with their engines. */
export const ENGINES: EngineRegistry = Object.freeze({ single: singleEngine });

/** The engine factory for an execution type; throws `LOUSHO_WORKSPACE_ENGINE_UNKNOWN` when the registry has none. */
export function engineFor(type: string, registry: EngineRegistry = ENGINES): PageEngineFactory {
  const factory = Object.hasOwn(registry, type) ? registry[type as keyof EngineRegistry] : undefined;
  if (!factory) {
    const known = Object.keys(registry).map((name) => `'${name}'`).join(', ');
    throw new SDKError(`engine-unknown: no engine runs execution type '${type}'; this runtime has ${known || 'none'}.`, 'LOUSHO_WORKSPACE_ENGINE_UNKNOWN');
  }
  return factory;
}

export { singleEngine } from './single';
export type { EngineRegistry, PageAttachment, PageEngineFactory, PageEngineSetup, PageRuntimeHost, PageToolScope } from './types';
