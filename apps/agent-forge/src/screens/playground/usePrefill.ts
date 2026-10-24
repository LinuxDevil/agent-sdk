/**
 * Loads what a Playground deep link names: `?trace=&fromObs=` (a trace's
 * generation) or `?prompt=name[@ref]` (a registry prompt). Both read the
 * observe daemon; when it is down, or the target is missing, the screen gets
 * a non-blocking notice and keeps its empty editor (and the URL).
 */
import { useEffect, useRef, useState } from 'react';

import { ObserveDaemonDownError, observeClient } from '../../observe/observeClient';
import { messagesFromObservation, modelFromObservation, parsePromptParam } from './prefill';
import type { PlaygroundMessage } from './types';

/** What a deep link fills in. */
export interface Prefill {
  messages?: PlaygroundMessage[];
  model?: { provider: string; model: string };
  /** The loaded prompt's name, and the `?prompt=` value the run records as `promptRef`. */
  prompt?: { name: string; promptRef: string };
}

/** The notice for a failed load. */
function failureNotice(error: unknown, what: string): string {
  if (error instanceof ObserveDaemonDownError) {
    return `The observe daemon is not reachable, so ${what} could not be loaded. Start it with \`lousho observe start\`; running still works.`;
  }
  return `Could not load ${what}: ${error instanceof Error ? error.message : String(error)}`;
}

async function fromObservation(traceId: string | null, obsId: string): Promise<Prefill | string> {
  if (!traceId) return `This link names generation '${obsId}' but no trace, so there is nothing to pre-fill.`;
  const detail = await observeClient.traceDetail(traceId);
  const row = detail?.observations.find((o) => o.obs_id === obsId);
  if (!row) return `Generation '${obsId}' was not found in trace '${traceId}'.`;
  const messages = messagesFromObservation(row);
  const model = modelFromObservation(row);
  return { ...(messages.length ? { messages } : {}), ...(model ? { model } : {}) };
}

async function fromPrompt(name: string, ref: string, promptRef: string): Promise<Prefill | string> {
  const prompt = await observeClient.getPrompt(name, ref);
  if (!prompt) return `Prompt '${name}@${ref}' was not found.`;
  return {
    messages: [
      { role: 'system', content: prompt.text },
      { role: 'user', content: '' },
    ],
    prompt: { name, promptRef },
  };
}

/** The load the query asks for, or `undefined` for a plain `#/playground`. */
function loaderFor(query: URLSearchParams): { what: string; load: () => Promise<Prefill | string> } | undefined {
  const obsId = query.get('fromObs');
  if (obsId) return { what: 'the generation', load: () => fromObservation(query.get('trace'), obsId) };
  const param = query.get('prompt');
  const prompt = parsePromptParam(param);
  if (prompt) return { what: `prompt '${prompt.name}'`, load: () => fromPrompt(prompt.name, prompt.ref, param!) };
  return undefined;
}

/** Runs the deep link's load once, on mount; `apply` receives the result. Returns the notice to show, if any. */
export function usePrefill(query: URLSearchParams, apply: (prefill: Prefill) => void): string | undefined {
  const [notice, setNotice] = useState<string | undefined>();
  const applyRef = useRef(apply);
  applyRef.current = apply;
  // The query at mount: later hash edits (none today) do not re-load.
  const [loader] = useState(() => loaderFor(query));

  useEffect(() => {
    if (!loader) return undefined;
    let live = true;
    loader.load().then(
      (result) => {
        if (!live) return;
        if (typeof result === 'string') setNotice(result);
        else applyRef.current(result);
      },
      (error: unknown) => {
        if (live) setNotice(failureNotice(error, loader.what));
      }
    );
    return () => {
      live = false;
    };
  }, [loader]);
  return notice;
}
