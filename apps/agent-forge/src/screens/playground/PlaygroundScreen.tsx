import { useCallback, useMemo, useState } from 'react';

import { useRoute } from '../../router/useRoute';
import { MessageEditor } from './MessageEditor';
import { ModelPicker, effectiveProvider, useProviderKeys, type ModelChoice } from './ModelPicker';
import { RunOutput } from './RunOutput';
import { SavePrompt } from './SavePrompt';
import { ToolToggles } from './ToolToggles';
import { VariableInputs } from './VariableInputs';
import { buildRunBody, modelString } from './request';
import { usePrefill, type Prefill } from './usePrefill';
import { useRun } from './useRun';
import { detectVariables } from './variables';
import type { PlaygroundMessage } from './types';
import './playground.css';

const EMPTY_MESSAGES: PlaygroundMessage[] = [
  { role: 'system', content: '' },
  { role: 'user', content: '' },
];

/** The query keys that name a deep link; the screen remounts (and re-loads) when any of them changes. */
const DEEP_LINK_KEYS = ['trace', 'fromObs', 'prompt'];

/** `#/playground` keyed on its deep link, so back/forward between two links loads the second one. */
export function PlaygroundRoute() {
  const { query } = useRoute();
  return <PlaygroundScreen key={DEEP_LINK_KEYS.map((k) => query.get(k) ?? '').join('|')} />;
}

/**
 * `#/playground` - try messages against a model without editing an agent:
 * message rows, `{variable}` inputs, a model picker, tools borrowed from a
 * saved agent, the streamed reply, "Save as new prompt version" and "Open
 * trace". Deep links pre-fill it: `?trace=&fromObs=` (a trace's generation)
 * and `?prompt=name[@ref]` (a registry prompt). Runs go to the Studio server,
 * so they work with the observe daemon down; only the deep-link loads and
 * the save need the daemon.
 */
export function PlaygroundScreen() {
  const { query } = useRoute();
  const [messages, setMessages] = useState<PlaygroundMessage[]>(EMPTY_MESSAGES);
  const [values, setValues] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<ModelChoice>({ provider: null, model: '' });
  const [tools, setTools] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<Prefill['prompt']>();
  const keys = useProviderKeys();
  const { run, start, stop } = useRun();

  const apply = useCallback((prefill: Prefill) => {
    if (prefill.messages) setMessages(prefill.messages);
    if (prefill.model) setChoice(prefill.model);
    if (prefill.prompt) setPrompt(prefill.prompt);
  }, []);
  const notice = usePrefill(query, apply);

  const names = useMemo(() => detectVariables(messages), [messages]);
  const model = modelString(effectiveProvider(choice, keys), choice.model);
  const body = buildRunBody({ messages, values, model, tools, promptRef: prompt?.promptRef });
  const systemText = messages.find((m) => m.role === 'system')?.content ?? '';
  const running = run.status === 'running';

  return (
    <div className="pg-screen">
      <header className="pg-head">
        <h2>Playground</h2>
        {prompt && <span className="pg-prompt-chip">{prompt.promptRef}</span>}
      </header>
      {notice && (
        <p className="pg-notice" role="status">
          {notice}
        </p>
      )}
      <div className="pg-layout">
        <div className="pg-editor">
          <MessageEditor messages={messages} onChange={setMessages} />
          <VariableInputs names={names} values={values} onChange={setValues} />
        </div>
        <div className="pg-side">
          <section className="pg-panel pg-settings" aria-labelledby="pg-settings-title">
            <h3 id="pg-settings-title" className="pg-panel-title">
              Model
            </h3>
            <ModelPicker choice={choice} keys={keys} onChange={setChoice} />
            <ToolToggles tools={tools} onChange={setTools} />
            <div className="pg-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!body || running}
                onClick={() => body && start(body)}
              >
                Run
              </button>
              <button type="button" className="btn" disabled={!running} onClick={stop}>
                Stop
              </button>
            </div>
            <SavePrompt promptName={prompt?.name} systemText={systemText} />
          </section>
          <RunOutput run={run} />
        </div>
      </div>
    </div>
  );
}
