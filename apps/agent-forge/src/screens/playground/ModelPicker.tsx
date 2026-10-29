import { useEffect, useState } from 'react';
import { FlaskConical, Plug, Server, Sparkles, type LucideIcon } from 'lucide-react';

import type { ProviderKeyStatus } from '../../../shared/wireTypes';
import { runtimeClient } from '../../runtime/runtimeClient';
import { MOCK_PROVIDER, defaultProvider, providerOptions } from './request';

/** The picker's value; `provider: null` means "not chosen yet" (the default is used). */
export interface ModelChoice {
  provider: string | null;
  model: string;
}

/** The Studio's provider keys (`GET /settings/providers`); empty until they load, or when the server cannot say. */
export function useProviderKeys(): ProviderKeyStatus[] {
  const [keys, setKeys] = useState<ProviderKeyStatus[]>([]);
  useEffect(() => {
    let live = true;
    runtimeClient.listProviderKeys().then(
      (list) => {
        if (live) setKeys(list);
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, []);
  return keys;
}

/** The provider to use: the chosen one, else the first with a key, else `mock`. */
export function effectiveProvider(choice: ModelChoice, keys: readonly ProviderKeyStatus[]): string {
  return choice.provider ?? defaultProvider(keys);
}

interface ModelPickerProps {
  choice: ModelChoice;
  keys: ProviderKeyStatus[];
  onChange: (choice: ModelChoice) => void;
}

function placeholderFor(provider: string): string {
  if (provider === MOCK_PROVIDER) return 'mock needs no model';
  return provider === '' ? 'provider/model' : 'model name';
}

/** The provider select's leading icon: the mock model, a local server, a custom string, or a hosted provider. */
function providerIcon(provider: string): LucideIcon {
  if (provider === MOCK_PROVIDER) return FlaskConical;
  if (provider === 'ollama') return Server;
  return provider === '' ? Plug : Sparkles;
}

/** Provider select (keyed providers, `ollama`, `mock`, or custom) plus a model-name input. */
export function ModelPicker({ choice, keys, onChange }: ModelPickerProps) {
  const provider = effectiveProvider(choice, keys);
  const options = providerOptions(keys);
  if (provider !== '' && !options.includes(provider)) options.unshift(provider);
  const isMock = provider === MOCK_PROVIDER;
  const Icon = providerIcon(provider);
  return (
    <div className="pg-model">
      <label className="pg-field">
        <span className="pg-field-label">Provider</span>
        <span className="pg-select-icon">
          <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
          <select className="select" value={provider} onChange={(e) => onChange({ ...choice, provider: e.target.value })}>
            {options.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            <option value="">custom (provider/model)</option>
          </select>
        </span>
      </label>
      <label className="pg-field">
        <span className="pg-field-label">Model</span>
        <input
          type="text"
          className="input pg-model-name"
          value={isMock ? '' : choice.model}
          disabled={isMock}
          placeholder={placeholderFor(provider)}
          onChange={(e) => onChange({ provider, model: e.target.value })}
        />
      </label>
    </div>
  );
}
