import { useEffect, useRef, useState, type Dispatch, type JSX, type SetStateAction } from 'react';
import { Copy } from 'lucide-react';

import { errorMessage } from '../../components/errorMessage';
import { runtimeClient, RuntimeApiError } from '../../runtime/runtimeClient';
import { Card } from '../../ui/Card';
import { Field } from '../../ui/Field';
import { SkeletonRows } from '../../ui/Skeleton';
import { Switch, Textarea } from '../../ui/controls';
import { useToast } from '../../ui/Toast';
import type { McpServeStatus, ServeStatus } from '../../../shared/wireTypes';
import { useMcpServeStatus, useServeStatus } from './useServeStatus';
import './serveCard.css';

/** How long a revealed token stays on screen before it hides itself. */
const REVEAL_MS = 30_000;
/** The success toast's on-screen time - shorter than the default so "Copied" does not linger. */
const COPIED_MS = 2_000;

/** `PUT /agents/:id/serve`'s 400 surfaces here as the Field's error text. */
function originsError(err: unknown): string {
  return err instanceof RuntimeApiError ? err.message : errorMessage(err);
}

/** The curl example: the real token is never inlined - the caller exports `$LOUSHO_SERVE_TOKEN`. */
function curlSnippet(endpoint: string): string {
  return [
    `curl -N ${endpoint} \\`,
    '  -H "Authorization: Bearer $LOUSHO_SERVE_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"sessionId":"demo","input":"Hello"}\'',
  ].join('\n');
}

interface ServeFactsProps {
  status: ServeStatus;
  /** The full token while revealed, `null` while masked. */
  revealed: string | null;
  rotating: boolean;
  onReveal(): void;
  onHide(): void;
  onRotate(): void;
  onCopyEndpoint(text: string): void;
  onCopyToken(): void;
}

/** The endpoint + token rows: masked by default, Reveal shows the raw bearer for 30 s. */
function ServeFacts({ status, revealed, rotating, onReveal, onHide, onRotate, onCopyEndpoint, onCopyToken }: ServeFactsProps): JSX.Element {
  const endpoint = `${location.origin}${status.baseUrl}/chat`;
  const tokenText = revealed ?? status.tokenMasked;
  return (
    <dl className="serve-card-facts" data-disabled={status.enabled ? undefined : 'true'}>
      <div className="serve-card-fact">
        <dt>Endpoint</dt>
        <dd>
          <code className="serve-card-code">{endpoint}</code>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Copy endpoint" onClick={() => onCopyEndpoint(endpoint)}>
            <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </dd>
      </div>
      <div className="serve-card-fact">
        <dt>Token</dt>
        <dd>
          <code className="serve-card-code">{tokenText}</code>
          {revealed === null ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onReveal}>
              Reveal
            </button>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onHide}>
              Hide
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Copy token" onClick={onCopyToken}>
            <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={rotating} onClick={onRotate}>
            {rotating ? 'Rotating…' : 'Rotate'}
          </button>
        </dd>
      </div>
    </dl>
  );
}

interface OriginsEditorProps {
  agentId: string;
  allowedOrigins: string[];
  onSaved(status: ServeStatus): void;
}

/** The allowed-origins textarea + Save: one origin per line, empty lines dropped. */
function OriginsEditor({ agentId, allowedOrigins, onSaved }: OriginsEditorProps): JSX.Element {
  const [draft, setDraft] = useState(() => allowedOrigins.join('\n'));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  // Re-sync the draft when the server's list changes underneath it (a
  // rotate or a Studio event refetch), but never while the user has
  // unsaved edits in the textarea.
  useEffect(() => {
    if (!dirty) setDraft(allowedOrigins.join('\n'));
  }, [allowedOrigins, dirty]);

  const save = async () => {
    const origins = draft
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    setSaving(true);
    setError(undefined);
    try {
      onSaved(await runtimeClient.putServe(agentId, { allowedOrigins: origins }));
      setDirty(false);
    } catch (err) {
      setError(originsError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Field
      label="Allowed origins"
      hint="Browser apps that may call this endpoint, one per line, e.g. http://localhost:3000. Leave empty for server-side callers only."
      error={error}
    >
      <Textarea
        className="serve-card-origins"
        rows={3}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setDirty(true);
        }}
      />
      <button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save origins'}
      </button>
    </Field>
  );
}

interface CurlSnippetProps {
  endpoint: string;
  onCopy(text: string): void;
}

/** The collapsible curl example - `$LOUSHO_SERVE_TOKEN`, never the real bearer. */
function CurlSnippet({ endpoint, onCopy }: CurlSnippetProps): JSX.Element {
  const snippet = curlSnippet(endpoint);
  return (
    <details className="serve-card-snippet">
      <summary>curl example</summary>
      <pre className="serve-card-pre">{snippet}</pre>
      <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Copy curl example" onClick={() => onCopy(snippet)}>
        <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </details>
  );
}

/** The `<script>` + `<forge-chat>` embed lines (X04b); `key` is `YOUR_WIDGET_KEY` or the real `fwk_` key. */
function embedSnippet(origin: string, baseUrl: string, agentId: string, key: string): string {
  return [
    `<script src="${origin}${baseUrl}/widget.js" defer></script>`,
    `<forge-chat endpoint="${origin}${baseUrl}/chat" token="${key}" title="${agentId}"></forge-chat>`,
  ].join('\n');
}

interface ServeToggleRowProps {
  published: boolean;
  publishedVersion: number | null;
  enabled: boolean;
  toggling: boolean;
  onToggle(enabled: boolean): void;
}

/** The enable switch + publish state (X02b): disabled with a title until a version is published. */
function ServeToggleRow({ published, publishedVersion, enabled, toggling, onToggle }: ServeToggleRowProps): JSX.Element {
  return (
    <div className="serve-card-row serve-card-toggle">
      <Switch
        id="serve-enabled"
        checked={enabled}
        disabled={!published || toggling}
        title={published ? undefined : 'Publish a version first'}
        label="Serve the published version"
        onChange={(next) => onToggle(next)}
      />
      <label className="serve-card-switch-label" htmlFor="serve-enabled">
        Serve the published version
      </label>
      <span className="serve-card-version">{published ? `v${publishedVersion}` : 'Not published'}</span>
    </div>
  );
}

interface WidgetEmbedProps {
  agentId: string;
  status: ServeStatus;
  onCopy(text: string): void;
  onChanged(): Promise<void>;
}

interface EmbedCreateProps {
  canCreate: boolean;
  busy: boolean;
  onCreate(): void;
}

/** The no-key state: one button, disabled with the reason until an origin exists. */
function EmbedCreate({ canCreate, busy, onCreate }: EmbedCreateProps): JSX.Element {
  return (
    <div className="serve-card-row">
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={!canCreate || busy}
        title={canCreate ? undefined : 'Add an allowed origin first'}
        onClick={onCreate}
      >
        {busy ? 'Creating…' : 'Create widget key'}
      </button>
    </div>
  );
}

interface EmbedWithKeyProps {
  placeholder: string;
  hasRawKey: boolean;
  busy: 'create' | 'revoke' | null;
  onCopyWithKey(): void;
  onMint(): void;
  onRevoke(): void;
}

/** The keyed state: placeholder snippet + Copy with key / Rotate / Revoke. */
function EmbedWithKey({ placeholder, hasRawKey, busy, onCopyWithKey, onMint, onRevoke }: EmbedWithKeyProps): JSX.Element {
  return (
    <>
      <pre className="serve-card-pre">{placeholder}</pre>
      <div className="serve-card-row">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!hasRawKey}
          title={hasRawKey ? undefined : 'Rotate the key to copy it'}
          onClick={onCopyWithKey}
        >
          Copy with key
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={onMint}>
          {busy === 'create' ? 'Rotating…' : 'Rotate key'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={onRevoke}>
          {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
        </button>
      </div>
    </>
  );
}

/**
 * The "Embed on a page" details (X04b): the widget key is the only
 * credential the snippet ever carries - the serve token stays
 * server-to-server. The raw key lives in component state only, returned
 * once by create/rotate; the masked form comes from `ServeStatus`.
 */
function WidgetEmbed({ agentId, status, onCopy, onChanged }: WidgetEmbedProps): JSX.Element {
  const toast = useToast();
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'revoke' | null>(null);
  const hasKey = status.widgetKeyMasked !== null;
  const canCreate = status.allowedOrigins.length > 0;
  const placeholder = embedSnippet(location.origin, status.baseUrl, agentId, 'YOUR_WIDGET_KEY');

  const act = async (kind: 'create' | 'revoke', call: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await call();
      await onChanged();
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  /** Create-or-rotate: the endpoint mints a fresh `fwk_` key either way. */
  const mint = () =>
    act('create', async () => {
      const { widgetKey } = await runtimeClient.createWidgetKey(agentId);
      setRawKey(widgetKey);
    });
  const revoke = () =>
    act('revoke', async () => {
      await runtimeClient.revokeWidgetKey(agentId);
      setRawKey(null);
    });
  const copyWithKey = () => {
    if (rawKey !== null) onCopy(embedSnippet(location.origin, status.baseUrl, agentId, rawKey));
  };

  return (
    <details className="serve-card-snippet serve-card-embed">
      <summary>Embed on a page</summary>
      {hasKey ? (
        <EmbedWithKey
          placeholder={placeholder}
          hasRawKey={rawKey !== null}
          busy={busy}
          onCopyWithKey={copyWithKey}
          onMint={() => void mint()}
          onRevoke={() => void revoke()}
        />
      ) : (
        <EmbedCreate canCreate={canCreate} busy={busy === 'create'} onCreate={() => void mint()} />
      )}
      <p className="serve-card-note">
        The widget key can only chat with this agent, and only from the allowed origins. Rotate or revoke it here at any time.
      </p>
    </details>
  );
}

interface ServeActionsDeps {
  agentId: string;
  refresh(): Promise<void>;
  setStatus: Dispatch<SetStateAction<ServeStatus | undefined>>;
}

interface ServeActions {
  revealed: string | null;
  rotating: boolean;
  toggling: boolean;
  reveal(): Promise<void>;
  hideRevealed(): void;
  rotate(): Promise<void>;
  toggle(enabled: boolean): Promise<void>;
  copy(text: string): Promise<void>;
  copyToken(): Promise<void>;
}

/**
 * The card's actions (X02b): clipboard copies, the 30 s token reveal and
 * the rotate/toggle PUTs. The revealed token lives only in this hook's
 * state - never persisted - and every timer is cleared on unmount.
 */
function useServeActions({ agentId, refresh, setStatus }: ServeActionsDeps): ServeActions {
  const toast = useToast();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [toggling, setToggling] = useState(false);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const hideRevealed = () => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    setRevealed(null);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      const id = toast.show({ message: 'Copied', tone: 'success' });
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => toast.dismiss(id), COPIED_MS);
    } catch {
      toast.show({ message: 'Copy failed', tone: 'error' });
    }
  };

  /** Copy wants the real bearer: fetch it (the masked text is useless) then write it. */
  const copyToken = async () => {
    try {
      const { token } = await runtimeClient.serveToken(agentId);
      await copy(token);
    } catch {
      toast.show({ message: 'Copy failed', tone: 'error' });
    }
  };

  const reveal = async () => {
    try {
      const { token } = await runtimeClient.serveToken(agentId);
      setRevealed(token);
      if (revealTimer.current) clearTimeout(revealTimer.current);
      revealTimer.current = setTimeout(() => setRevealed(null), REVEAL_MS);
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    }
  };

  const rotate = async () => {
    setRotating(true);
    try {
      await runtimeClient.rotateServeToken(agentId);
      hideRevealed();
      toast.show({ message: 'Token rotated. Update any app that used the old one.', tone: 'warning' });
      await refresh();
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    } finally {
      setRotating(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      setStatus(await runtimeClient.putServe(agentId, { enabled }));
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    } finally {
      setToggling(false);
    }
  };

  return { revealed, rotating, toggling, reveal, hideRevealed, rotate, toggle, copy, copyToken };
}

interface McpServeRowsProps {
  agentId: string;
  published: boolean;
  mcp: ReturnType<typeof useMcpServeStatus>;
  onCopy(text: string): void;
}

/** Start/stop + the running facts and client snippets (X03). */
function McpServeRows({ agentId, published, mcp, onCopy }: McpServeRowsProps): JSX.Element {
  const toast = useToast();
  const [busy, setBusy] = useState<'starting' | 'stopping' | null>(null);
  const status = mcp.status;

  const act = async (kind: 'starting' | 'stopping', call: () => Promise<McpServeStatus>) => {
    setBusy(kind);
    try {
      mcp.setStatus(await call());
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const running = status?.running === true;
  const mcpUrl = status?.url ?? null;
  const addCommand = mcpUrl === null ? '' : `claude mcp add --transport http ${agentId} ${mcpUrl} --header "Authorization: Bearer $LOUSHO_SERVE_TOKEN"`;
  const stdioCommand = `lousho mcp .lousho/agents/${agentId}/published.yaml`;

  return (
    <div className="serve-card-mcp">
      <h3 className="serve-card-subhead">MCP</h3>
      <div className="serve-card-row">
        {running ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null}
            onClick={() => void act('stopping', () => runtimeClient.stopMcp(agentId))}
          >
            {busy === 'stopping' ? 'Stopping…' : 'Stop MCP server'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!published || busy !== null}
            title={published ? undefined : 'Publish a version first'}
            onClick={() => void act('starting', () => runtimeClient.startMcp(agentId))}
          >
            {busy === 'starting' ? 'Starting…' : 'Start MCP server'}
          </button>
        )}
      </div>
      {running && status !== undefined ? (
        <dl className="serve-card-facts">
          <div className="serve-card-fact">
            <dt>MCP URL</dt>
            <dd>
              <code className="serve-card-code">{status.url}</code>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                aria-label="Copy MCP URL"
                onClick={() => status.url !== null && onCopy(status.url)}
              >
                <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </dd>
          </div>
          <div className="serve-card-fact">
            <dt>Tool</dt>
            <dd>
              <code className="serve-card-code">{status.toolName}</code>
            </dd>
          </div>
        </dl>
      ) : null}
      {running ? (
        <>
          <details className="serve-card-snippet">
            <summary>Add to Claude Code</summary>
            <pre className="serve-card-pre">{addCommand}</pre>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-label="Copy Claude Code command"
              onClick={() => onCopy(addCommand)}
            >
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </details>
          <details className="serve-card-snippet">
            <summary>Run over stdio instead</summary>
            <pre className="serve-card-pre">{stdioCommand}</pre>
            <p className="serve-card-hint">Runs outside Studio. Run "Deploy" or publish once so the file exists.</p>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-label="Copy stdio command"
              onClick={() => onCopy(stdioCommand)}
            >
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </details>
          <p className="serve-card-hint">The port changes each time the server starts.</p>
        </>
      ) : null}
    </div>
  );
}

/**
 * The Serve card (X02b, PLAN §16.3): turns `/serve/<id>` on for the
 * published version, shows the endpoint + masked bearer, and edits the
 * allowed origins. The token is only ever held in memory - revealed for
 * 30 s or copied straight to the clipboard, never persisted.
 */
export function ServeCard({ agentId }: { agentId: string }): JSX.Element {
  const { status, loading, error, refresh, setStatus } = useServeStatus(agentId);
  const mcp = useMcpServeStatus(agentId);
  const { revealed, rotating, toggling, reveal, hideRevealed, rotate, toggle, copy, copyToken } = useServeActions({
    agentId,
    refresh,
    setStatus,
  });
  // Rotating restarts a running MCP server on a NEW ephemeral port (X03) -
  // refetch its status so the card shows the fresh URL.
  const rotateAndRefreshMcp = async () => {
    await rotate();
    await mcp.refresh();
  };

  if (loading && status === undefined) {
    return (
      <Card title="Serve" description="Call the published version from apps on this machine while Studio runs." className="serve-card">
        <SkeletonRows rows={3} />
      </Card>
    );
  }
  if (error !== undefined || status === undefined) {
    return (
      <Card title="Serve" description="Call the published version from apps on this machine while Studio runs." className="serve-card">
        <p className="value-missing">Could not load serve settings: {error ?? 'unknown error'}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>
          Retry
        </button>
      </Card>
    );
  }

  const published = status.publishedVersion !== null;
  const endpoint = `${location.origin}${status.baseUrl}/chat`;

  return (
    <Card title="Serve" description="Call the published version from apps on this machine while Studio runs." className="serve-card">
      <ServeToggleRow
        published={published}
        publishedVersion={status.publishedVersion}
        enabled={status.enabled}
        toggling={toggling}
        onToggle={(enabled) => void toggle(enabled)}
      />
      {published ? (
        <>
          <ServeFacts
            status={status}
            revealed={revealed}
            rotating={rotating}
            onReveal={() => void reveal()}
            onHide={hideRevealed}
            onRotate={() => void rotateAndRefreshMcp()}
            onCopyEndpoint={(text) => void copy(text)}
            onCopyToken={() => void copyToken()}
          />
          <OriginsEditor agentId={agentId} allowedOrigins={status.allowedOrigins} onSaved={setStatus} />
          {status.enabled ? <CurlSnippet endpoint={endpoint} onCopy={(text) => void copy(text)} /> : null}
          {status.enabled ? (
            <WidgetEmbed agentId={agentId} status={status} onCopy={(text) => void copy(text)} onChanged={refresh} />
          ) : null}
        </>
      ) : null}
      {/* The MCP section stays visible unpublished too: its Start button is
          the discoverable "publish first" affordance (X03). */}
      <McpServeRows agentId={agentId} published={published} mcp={mcp} onCopy={(text) => void copy(text)} />
    </Card>
  );
}
