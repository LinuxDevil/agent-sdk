import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { BookmarkPlus, FileText, Info } from 'lucide-react';

import { useRoute } from '../../router/useRoute';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { MessageEditor } from './MessageEditor';
import { ModelPicker, effectiveProvider, useProviderKeys, type ModelChoice } from './ModelPicker';
import { RunBar } from './RunBar';
import { RunOutput } from './RunOutput';
import { SaveDialog, useSaveDialog } from './SaveDialog';
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
  const canRun = !!body && !running;
  const runNow = () => {
    if (body && !running) start(body);
  };
  // Ctrl/Cmd+Enter anywhere in the composer runs it, like the Run button.
  const onComposerKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.repeat || e.nativeEvent.isComposing) return;
    e.preventDefault();
    runNow();
  };
  const save = useSaveDialog();

  return (
    <div className="pg-screen">
      <ScreenHeader
        description="Try messages against a model without editing an agent."
        status={
          prompt ? (
            <span className="chip pg-prompt-chip" title={prompt.promptRef}>
              <FileText aria-hidden="true" />
              {prompt.promptRef}
            </span>
          ) : null
        }
        actions={
          <button
            ref={save.triggerRef}
            type="button"
            className="btn pg-save-trigger"
            aria-haspopup="dialog"
            aria-expanded={save.open}
            aria-controls="pg-save-dialog"
            onClick={save.toggle}
          >
            <BookmarkPlus aria-hidden="true" />
            Save prompt
          </button>
        }
      />
      <SaveDialog id="pg-save-dialog" open={save.open} onClose={save.close} triggerRef={save.triggerRef}>
        <SavePrompt promptName={prompt?.name} systemText={systemText} />
      </SaveDialog>
      {notice && (
        <p className="pg-notice" role="status">
          <Info aria-hidden="true" size={16} strokeWidth={1.75} />
          <span>{notice}</span>
        </p>
      )}
      <div className="pg-layout">
        <aside className="card pg-card pg-config" aria-label="Run settings">
          <section className="pg-config-section" aria-labelledby="pg-settings-title">
            <h2 id="pg-settings-title" className="pg-section-title overline">
              Model
            </h2>
            <ModelPicker choice={choice} keys={keys} onChange={setChoice} />
          </section>
          <VariableInputs names={names} values={values} onChange={setValues} />
          <div className="pg-config-section">
            <ToolToggles tools={tools} onChange={setTools} />
          </div>
        </aside>
        <section className="card pg-card pg-composer" aria-labelledby="pg-messages-title" onKeyDown={onComposerKey}>
          <div className="pg-card-head">
            <h2 id="pg-messages-title" className="pg-card-title">
              Messages
            </h2>
            <span className="pg-card-meta tabular-nums">
              {messages.length} {messages.length === 1 ? 'message' : 'messages'}
            </span>
          </div>
          <div className="pg-card-body">
            <MessageEditor messages={messages} onChange={setMessages} />
          </div>
          <RunBar canRun={canRun} running={running} onRun={runNow} onStop={stop} />
        </section>
        <RunOutput run={run} />
      </div>
    </div>
  );
}
