/**
 * `useCatalog(kind)` reads the Studio's `GET /catalog/*` routes
 * (server/routes/catalogRoutes.ts) through the RuntimeClient and caches
 * each kind's promise module-wide, so every inspector field on the page
 * shares one request per kind per page load. `refreshCatalog` drops the
 * cached entry so a Retry button can refetch.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { runtimeClient } from '../runtime/runtimeClient';
import { errorMessage } from '../components/errorMessage';
import type {
  CatalogGuardrail,
  CatalogKit,
  CatalogModel,
  CatalogSkill,
  CatalogTool,
  CatalogTriggerType,
} from '../../shared/wireTypes';

/** The `GET /catalog/<kind>` routes the SDK catalogs answer. */
export type CatalogKind = 'models' | 'tools' | 'guardrails' | 'triggers' | 'skills' | 'kits';

/** The payload each `GET /catalog/<kind>` answers - the SDK catalog rows (shared/wireTypes.ts). */
export interface CatalogPayloads {
  models: CatalogModel[];
  tools: CatalogTool[];
  guardrails: CatalogGuardrail[];
  triggers: CatalogTriggerType[];
  skills: CatalogSkill[];
  kits: CatalogKit[];
}

/** What {@link useCatalog} answers: the payload, the failure message, or `loading` while the first fetch runs. */
export interface CatalogState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
}

const fetchers: { [K in CatalogKind]: () => Promise<CatalogPayloads[K]> } = {
  models: () => runtimeClient.catalogModels(),
  tools: () => runtimeClient.catalogTools(),
  guardrails: () => runtimeClient.catalogGuardrails(),
  triggers: () => runtimeClient.catalogTriggers(),
  skills: () => runtimeClient.catalogSkills(),
  kits: () => runtimeClient.catalogKits(),
};

/**
 * One in-flight (or settled) promise per kind - the "fetch once per page
 * load" cache every `useCatalog` caller shares, failures included, so a
 * failed kind shows its error everywhere until {@link refreshCatalog}.
 */
const catalogCache = new Map<CatalogKind, Promise<unknown>>();

/** Per-kind fetch generation, bumped by {@link refreshCatalog} so mounted hooks refetch. */
const versions = new Map<CatalogKind, number>();

/** Mounted {@link useCatalog} listeners, poked by {@link refreshCatalog}. */
const listeners = new Set<() => void>();

function catalogPromise(kind: CatalogKind): Promise<unknown> {
  let promise = catalogCache.get(kind);
  if (promise === undefined) {
    promise = fetchers[kind]();
    catalogCache.set(kind, promise);
  }
  return promise;
}

/** `kind`'s fetch generation — the `useSyncExternalStore` snapshot of {@link useCatalog}. */
function catalogVersion(kind: CatalogKind): number {
  return versions.get(kind) ?? 0;
}

/** Registers `notify` for every catalog refresh; answers the unsubscribe. */
function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/**
 * Drops `kind`'s cached entry and bumps its version so every mounted
 * {@link useCatalog} of that kind refetches — a Retry button's hook.
 */
export function refreshCatalog(kind: CatalogKind): void {
  catalogCache.delete(kind);
  versions.set(kind, catalogVersion(kind) + 1);
  for (const listener of listeners) listener();
}

/**
 * The `GET /catalog/<kind>` payload, fetched once per page load and shared
 * by every caller. Errors surface as `error` (via `errorMessage`) rather
 * than throwing; `refreshCatalog(kind)` re-arms the fetch.
 */
export function useCatalog<K extends CatalogKind>(kind: K): CatalogState<CatalogPayloads[K]> {
  const [state, setState] = useState<CatalogState<CatalogPayloads[K]>>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const version = useSyncExternalStore(subscribe, () => catalogVersion(kind));
  useEffect(() => {
    let alive = true;
    setState({ data: undefined, error: undefined, loading: true });
    catalogPromise(kind).then(
      (data) => {
        if (alive) setState({ data: data as CatalogPayloads[K], error: undefined, loading: false });
      },
      (error) => {
        if (alive) setState({ data: undefined, error: errorMessage(error), loading: false });
      },
    );
    return () => {
      alive = false;
    };
  }, [kind, version]);
  return state;
}
