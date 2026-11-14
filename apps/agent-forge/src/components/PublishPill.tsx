import { useState, type JSX } from 'react';
import { Loader2 } from 'lucide-react';

import type { EvalGateResult, PublishState } from '../../shared/wireTypes';
import { EvalGateDialog } from './EvalGateDialog';
import { evalGateFailureOf } from './evalGateFailure';
import { errorMessage } from './errorMessage';
import { navigate } from '../router/router';
import { runtimeClient } from '../runtime/runtimeClient';
import { useAppState } from '../state/AppState';
import { agentTabPath } from '../screens/agents/agentTabs';
import { Menu, type MenuEntry } from '../ui/Menu';
import { useToast } from '../ui/Toast';
import './publishPill.css';

/** What the publish pill reads and its tooltip says, per `PublishState`. */
export interface PublishLabel {
  text: string;
  tone: 'neutral' | 'ok' | 'warning';
  title: string;
}

/**
 * The publish state's one-line label (L14b, copy fixed by the ticket):
 * nothing pinned reads neutral, a pinned version matching the working
 * copy reads ok, and a pinned version the edits have drifted from reads
 * warning. `title` is the pill's tooltip.
 */
export function publishLabel(state: PublishState): PublishLabel {
  if (state.version === null) {
    return {
      text: 'Not published',
      tone: 'neutral',
      title: 'Nothing is live yet. Publish to serve, deploy or run triggers from a fixed version.',
    };
  }
  if (state.matchesWorkingCopy) {
    return { text: `Published v${state.version}`, tone: 'ok', title: `v${state.version} is live and matches what you are editing.` };
  }
  return {
    text: `Published v${state.version} · edited`,
    tone: 'warning',
    title: `v${state.version} is live. Your edits are not published yet.`,
  };
}

/** Props for {@link PublishPill}: the builder toolbar's publish-state menu trigger. */
export interface PublishPillProps {
  agentId: string;
  state: PublishState;
  /** The open document has unsaved edits; publish saves the working copy first. */
  dirty: boolean;
  /** Called with the pinned version after a successful publish (the caller refreshes its copy of the state). */
  onPublished(version: number): void;
}

/**
 * The builder toolbar's publish pill (L14b): a `status-pill`-styled Menu
 * trigger showing {@link publishLabel}'s text, opening "Publish current
 * version" (disabled with "Already published" once the working copy
 * matches the pin) and "View versions". While publishing the pill is
 * `aria-busy`, spins a Loader2 and reads "Running evals…"; a dirty editor
 * is saved first, a success toasts `Published v<n>` (plus `· evals passed`
 * when the gate ran, X01b), a 409 eval-gate failure opens
 * {@link EvalGateDialog} with the full result, and any other failure
 * toasts `Couldn't publish: <message>`.
 */
export function PublishPill({ agentId, state, dirty, onPublished }: PublishPillProps): JSX.Element {
  const { save } = useAppState();
  const toast = useToast();
  const [publishing, setPublishing] = useState(false);
  const [gateFailure, setGateFailure] = useState<{ version: number; result: EvalGateResult } | null>(null);
  const label = publishLabel(state);
  const shown = publishing ? { ...label, text: 'Running evals…' } : label;

  async function publishCurrent(): Promise<void> {
    if (publishing) return;
    setPublishing(true);
    try {
      if (dirty) await save();
      const { publishedVersion, evalResult } = await runtimeClient.publish(agentId);
      toast.show({
        message: evalResult === undefined ? `Published v${publishedVersion}` : `Published v${publishedVersion} · evals passed`,
        tone: 'success',
      });
      onPublished(publishedVersion);
    } catch (error) {
      const failure = evalGateFailureOf(error);
      if (failure !== null) {
        setGateFailure(failure);
      } else {
        toast.show({ message: `Couldn't publish: ${errorMessage(error)}`, tone: 'error' });
      }
    } finally {
      setPublishing(false);
    }
  }

  const items: MenuEntry[] = [
    {
      id: 'publish-current',
      label: 'Publish current version',
      disabled: state.matchesWorkingCopy || publishing,
      disabledReason: state.matchesWorkingCopy ? 'Already published' : publishing ? 'Running evals…' : undefined,
      onSelect: () => void publishCurrent(),
    },
    {
      id: 'view-versions',
      label: 'View versions',
      onSelect: () => navigate(agentTabPath(agentId, 'versions')),
    },
  ];

  return (
    <>
      <Menu
        label={`Publish state: ${shown.text}`}
        items={items}
        trigger={{
          className: `status-pill pill-${shown.tone} publish-pill`,
          content: (
            <>
              <span className="dot" aria-hidden="true" />
              {publishing && <Loader2 size={12} className="spin" aria-hidden="true" />}
              <span className="status-pill-label">{shown.text}</span>
            </>
          ),
          ariaLabel: `Publish state: ${shown.text}`,
          title: shown.title,
          busy: publishing,
        }}
      />
      {gateFailure !== null && (
        <EvalGateDialog
          open
          onClose={() => setGateFailure(null)}
          version={gateFailure.version}
          result={gateFailure.result}
        />
      )}
    </>
  );
}

/**
 * The read-only half of the publish state (L14b): the detail header's
 * pill next to the enabled switch - same text/tone/title as
 * {@link publishLabel}, not a button.
 */
export function PublishStatePill({ state }: { state: PublishState }): JSX.Element {
  const label = publishLabel(state);
  return (
    <span className={`status-pill pill-${label.tone}`} title={label.title}>
      <span className="dot" aria-hidden="true" />
      <span className="status-pill-label">{label.text}</span>
    </span>
  );
}
