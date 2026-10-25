import { useEffect, useState } from 'react';

import { ObserveDaemonDownError, observeClient } from '../../observe/observeClient';
import { useToast } from '../../ui/Toast';
import { detectVariables } from './variables';

/** The toast text for a failed push. */
function failureMessage(error: unknown): string {
  if (error instanceof ObserveDaemonDownError) {
    return 'Could not save: the observe daemon is not reachable. Start it with `lousho observe start`.';
  }
  return `Could not save the prompt: ${error instanceof Error ? error.message : String(error)}`;
}

interface SavePromptProps {
  /** The loaded prompt's name, when the Playground came from one. */
  promptName?: string;
  /** The system message's content: the text a new version stores. */
  systemText: string;
}

/**
 * "Save as new prompt version": pushes the system message (and its
 * `{variables}`) to the registry under the loaded prompt's name, or a typed
 * one. Disabled, with a hint, while there is no system message.
 */
export function SavePrompt({ promptName, systemText }: SavePromptProps) {
  const toast = useToast();
  const [name, setName] = useState(promptName ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (promptName) setName(promptName);
  }, [promptName]);

  const hasSystem = systemText.trim() !== '';
  const save = () => {
    const target = name.trim();
    setSaving(true);
    observeClient
      .createPrompt({ name: target, text: systemText, variables: detectVariables([{ role: 'system', content: systemText }]) })
      .then(
        (result) =>
          toast.show({
            tone: 'success',
            message: result.unchanged
              ? `${target} unchanged (still v${result.version})`
              : `Saved ${target} v${result.version}`,
          }),
        (error: unknown) => toast.show({ tone: 'error', message: failureMessage(error) })
      )
      .finally(() => setSaving(false));
  };

  return (
    <div className="pg-save">
      <label className="pg-field">
        <span className="pg-field-label">Prompt name</span>
        <input type="text" value={name} placeholder="e.g. support-greeter" onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="button" className="btn" disabled={!hasSystem || !name.trim() || saving} onClick={save}>
        Save as new prompt version
      </button>
      {!hasSystem && <p className="pg-hint">Add a system message to save it as a prompt version.</p>}
    </div>
  );
}
