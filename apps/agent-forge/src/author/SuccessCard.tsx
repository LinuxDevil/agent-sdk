/**
 * The card a save leaves behind (research §1.8): what was written, its
 * version, and - for a create that saved disabled - the "Enable agent"
 * button that flips the switch through `POST /assistant/sessions/:id/enable`
 * (`chat.enable`, AA11). After the switch lands, the card reports the
 * missing-requirements count the enable route answered with and lists
 * the rows still `missing` (`GET /agents/:id/requirements`), because an
 * enabled-but-not-runnable agent fails at run time, not at save time.
 *
 * "Open in canvas" deep-links to the agent's builder route
 * (`#/agents/:id` is the canvas screen) and hides itself while that
 * agent is already on screen.
 */
import { useState } from 'react';
import { CircleCheck } from 'lucide-react';
import type { Requirement, SetEnabledOutput } from '../../shared/authorWire';
import { matchRoute, navigate } from '../router/router';
import { useRoute } from '../router/useRoute';
import { runtimeClient } from '../runtime/runtimeClient';
import { useToast, type ToastApi } from '../ui/Toast';
import type { AuthorChat } from './AuthorChatContext';
import './authorCards.css';

/** Props for {@link SuccessCard}. */
export interface SuccessCardProps {
  /** `create` offers "Enable agent" (new agents save disabled); `update` only reports the version. */
  kind: 'create' | 'update';
  agentId: string;
  /** The saved agent's display name (the propose card's `spec.name`). */
  name: string;
  /** The version the save recorded (updates only show it in the hint). */
  version: number;
  /** Already on: a `setAgentEnabled` part flipped it, or the button below succeeded. */
  enabledNow: boolean;
  /** The missing-requirements count a model-driven enable reported (`0` when none/unknown). */
  missingCount?: number;
  /** The saved proposal's readiness rows; the `missing` ones make up the requirement list. */
  requirements?: Requirement[];
  chat: AuthorChat;
}

/** The create/update title and hint pairs (curly quotes per the copy conventions). */
function titleOf(kind: SuccessCardProps['kind'], name: string): string {
  return kind === 'create' ? `Created “${name}”` : `Updated “${name}”`;
}

function hintOf(kind: SuccessCardProps['kind'], version: number): string {
  return kind === 'create'
    ? "It's off for now. Review it, then turn it on here or ask in this chat."
    : `Saved as version ${version}.`;
}

/** The warn line after a successful enable that still has missing requirements. */
function warnCopy(missing: number): string {
  return `Turned on. ${missing} ${missing === 1 ? 'requirement is' : 'requirements are'} still missing, so runs may fail.`;
}

/**
 * Runs the enable click: `chat.enable` (a `null` result means no session)
 * then, when the route reports missing requirements, a fresh
 * `GET /agents/:id/requirements` - a secret added between propose and
 * enable changes which rows still count as missing. `null` rows means
 * the fetch failed and the card keeps the proposal's list.
 */
async function enableAndCheck(
  agentId: string,
  enable: AuthorChat['enable']
): Promise<{ output: SetEnabledOutput; rows: Requirement[] | null } | null> {
  const output = await enable(agentId);
  if (output === null || !output.ok) return null;
  if (output.missingRequirements === 0) return { output, rows: [] };
  const rows = await runtimeClient
    .getAgentRequirements(agentId)
    .then((list) => list.filter((r) => r.status === 'missing'))
    .catch(() => null);
  return { output, rows };
}

/** The missing-requirements warn line (enabled only) plus the requirement list itself. */
function MissingRequirements({ on, missing, rows }: { on: boolean; missing: number; rows: Requirement[] }): JSX.Element | null {
  if (!on && rows.length === 0) return null;
  return (
    <>
      {on && missing > 0 && <p className="success-card-warn">{warnCopy(missing)}</p>}
      {rows.length > 0 && (
        <ul className="success-card-reqs" aria-label="Missing requirements">
          {rows.map((r) => (
            <li key={r.id}>{r.label}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The action row: the create's enable affordance (or "On") and the canvas deep-link. */
function SuccessActions({
  kind,
  on,
  enabling,
  agentId,
  onEnable,
  onAgentScreen,
}: {
  kind: SuccessCardProps['kind'];
  on: boolean;
  enabling: boolean;
  agentId: string;
  onEnable(): void;
  onAgentScreen: boolean;
}): JSX.Element {
  return (
    <div className="success-card-actions">
      {kind === 'create' &&
        (on ? (
          <span className="success-card-on">On</span>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={enabling}
            title={enabling ? 'Turning the agent on' : undefined}
            onClick={onEnable}
          >
            {enabling ? 'Enabling…' : 'Enable agent'}
          </button>
        ))}
      {!onAgentScreen && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => navigate(`/agents/${encodeURIComponent(agentId)}`)}
        >
          Open in canvas
        </button>
      )}
    </div>
  );
}

function toastFailure(toast: ToastApi, error: unknown): void {
  toast.show({
    message: error instanceof Error ? error.message : 'The agent could not be turned on.',
    tone: 'error',
  });
}

/**
 * One success card. `enabledNow` covers the model-driven enable already
 * in the transcript; the button's own success is local state on top.
 */
export function SuccessCard({
  kind,
  agentId,
  name,
  version,
  enabledNow,
  missingCount = 0,
  requirements = [],
  chat,
}: SuccessCardProps): JSX.Element {
  const toast = useToast();
  const { path } = useRoute();
  const [enabling, setEnabling] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [missing, setMissing] = useState(missingCount);
  const [missingRows, setMissingRows] = useState<Requirement[]>(() =>
    requirements.filter((r) => r.status === 'missing')
  );

  const on = enabledNow || enabled;

  async function onEnable(): Promise<void> {
    setEnabling(true);
    try {
      const result = await enableAndCheck(agentId, chat.enable);
      if (result === null) return;
      setEnabled(true);
      setMissing(result.output.missingRequirements);
      if (result.rows !== null) setMissingRows(result.rows);
      toast.show({ message: `“${name}” is on`, tone: 'success' });
    } catch (error) {
      toastFailure(toast, error);
    } finally {
      setEnabling(false);
    }
  }

  return (
    <div className="success-card" role="status">
      <CircleCheck className="success-card-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
      <div className="success-card-body">
        <p className="success-card-title">{titleOf(kind, name)}</p>
        <p className="success-card-hint">{hintOf(kind, version)}</p>
        <MissingRequirements on={on} missing={missing} rows={missingRows} />
        <SuccessActions
          kind={kind}
          on={on}
          enabling={enabling}
          agentId={agentId}
          onEnable={() => void onEnable()}
          onAgentScreen={matchRoute(`#${path}`, ['/agents/:id'])?.params.id === agentId}
        />
      </div>
    </div>
  );
}
