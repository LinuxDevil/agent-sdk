import { useCallback, useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { runtimeClient } from '../../runtime/runtimeClient';
import type { CollectorStatus, CollectorUpdate } from '../../../shared/wireTypes';
import { errorMessage } from '../errorMessage';
import { SettingsCard, SettingRow } from '../SettingsCard';
import { StatusDot } from '../../ui/StatusBadge';
import type { StatusKey } from '../../ui/status';
import './collectorCard.css';

/**
 * Settings → Collector (W12): which observe daemon Studio reads traces
 * from and where runs report. The server owns the semantics (collector.ts);
 * this card edits `collector.url` and the `LOUSHO_OBSERVE_TOKEN` named
 * secret through `PUT /settings/collector` - the token value itself never
 * comes back, so the field only ever shows a "Saved" placeholder.
 */

const STATUS_TEXT: Record<CollectorStatus['mode'], (status: CollectorStatus) => string> = {
  attached: (s) => `Attached to ${s.url}`,
  started: (s) => `Started by Studio on ${s.url}`,
  remote: (s) => `Remote collector at ${s.url}`,
  down: (s) => `Not reachable: ${s.error ?? 'unknown'}`,
};

const STATUS_DOT: Record<CollectorStatus['mode'], StatusKey> = {
  attached: 'done',
  started: 'running',
  remote: 'done',
  down: 'error',
};

function statusText(status: CollectorStatus): string {
  const base = STATUS_TEXT[status.mode](status);
  return status.daemonVersion ? `${base} · daemon v${status.daemonVersion}` : base;
}

function StatusLine({ status }: { status: CollectorStatus | undefined }) {
  return (
    <SettingRow label="Status">
      <span className="collector-status" role="status">
        {status ? (
          <>
            <StatusDot status={STATUS_DOT[status.mode]} title={statusText(status)} />
            <span className="collector-status-text">{statusText(status)}</span>
          </>
        ) : (
          <span className="collector-status-text">Checking…</span>
        )}
      </span>
    </SettingRow>
  );
}

interface FieldsProps {
  locked: boolean;
  lockedHint: string | undefined;
  urlDraft: string;
  tokenDraft: string;
  hasToken: boolean;
  tokenRemoved: boolean;
  onUrl: (value: string) => void;
  onToken: (value: string) => void;
  onRemoveToken: () => void;
}

function CollectorFields({ locked, lockedHint, urlDraft, tokenDraft, hasToken, tokenRemoved, onUrl, onToken, onRemoveToken }: FieldsProps) {
  return (
    <>
      <div className="field">
        <label htmlFor="collector-url">Collector URL</label>
        <input
          id="collector-url"
          className="input"
          type="text"
          placeholder="http://127.0.0.1:7777"
          value={urlDraft}
          disabled={locked}
          title={lockedHint}
          onChange={(e) => onUrl(e.target.value)}
        />
        <div className="hint">Leave empty to use the collector on this machine. Studio starts one when none is running.</div>
      </div>
      <div className="field">
        <label htmlFor="collector-token">Bearer token</label>
        <div className="collector-token-row">
          <input
            id="collector-token"
            className="input"
            type="password"
            placeholder={hasToken && !tokenRemoved ? 'Saved' : 'Token'}
            value={tokenDraft}
            disabled={locked}
            title={lockedHint}
            onChange={(e) => onToken(e.target.value)}
          />
          {hasToken && !tokenRemoved && (
            <button type="button" className="setting-link" onClick={onRemoveToken}>
              Remove token
            </button>
          )}
        </div>
        <div className="hint">Only for a collector that requires a token. Create one with lousho observe token create.</div>
      </div>
      {locked && <div className="hint">{lockedHint}</div>}
    </>
  );
}

export function CollectorCard() {
  const [status, setStatus] = useState<CollectorStatus | undefined>(undefined);
  const [urlDraft, setUrlDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenRemoved, setTokenRemoved] = useState(false);
  const [busy, setBusy] = useState<'save' | 'check' | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async (probe = false) => {
    setStatus(await runtimeClient.collectorStatus(probe));
  }, []);

  useEffect(() => {
    load().catch((e) => setError(errorMessage(e)));
  }, [load]);

  // Seed the URL draft from the configured value once the first status lands
  // (the effective URL may be the env/default one - the field edits the
  // configured one, so an env-locked or unset setting stays empty).
  useEffect(() => {
    if (status && urlDraft === '' && !status.lockedByEnv) setUrlDraft(status.configuredUrl ?? '');
  }, [status, urlDraft]);

  const locked = status?.lockedByEnv === true;
  const lockedHint = locked ? "Set by LOUSHO_OBSERVE_URL in Studio's environment." : undefined;

  async function run(action: () => Promise<void>, which: 'save' | 'check') {
    setBusy(which);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run(async () => {
      const update: CollectorUpdate = {
        url: urlDraft.trim() === '' ? null : urlDraft.trim(),
        ...(tokenRemoved ? { token: null } : tokenDraft.trim() ? { token: tokenDraft.trim() } : {}),
      };
      setStatus(await runtimeClient.updateCollector(update));
      setTokenDraft('');
      setTokenRemoved(false);
    }, 'save');

  const check = () => run(() => load(true), 'check');

  return (
    <SettingsCard Icon={Activity} title="Collector" description="Where Studio reads traces and where your project runs report them.">
      <StatusLine status={status} />
      <CollectorFields
        locked={locked}
        lockedHint={lockedHint}
        urlDraft={urlDraft}
        tokenDraft={tokenDraft}
        hasToken={status?.hasToken === true}
        tokenRemoved={tokenRemoved}
        onUrl={setUrlDraft}
        onToken={(value) => {
          setTokenDraft(value);
          setTokenRemoved(false);
        }}
        onRemoveToken={() => {
          setTokenRemoved(true);
          setTokenDraft('');
        }}
      />
      <div className="settings-actions">
        <button className="btn" onClick={() => void save()} disabled={busy !== null || locked}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn-ghost" onClick={() => void check()} disabled={busy !== null}>
          {busy === 'check' ? 'Checking…' : 'Check connection'}
        </button>
      </div>
      {error && (
        <div className="run-error" role="alert">
          {error}
        </div>
      )}
    </SettingsCard>
  );
}
