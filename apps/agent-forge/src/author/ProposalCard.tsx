/**
 * The proposal card every ok `proposeAgent`/`proposeAgentUpdate` part
 * renders (PLAN §8.3, research §1.4): name, enabled badge, description, an
 * optional carried-over note, the server-computed "What changes" diff for
 * updates, missing-requirement rows with fixes, a full-configuration
 * toggle, and - only on the one actionable card - the Apply footer with
 * its saving, disabled and error states.
 */
import { useState } from 'react';
import { CircleAlert, GitCompareArrows, History } from 'lucide-react';
import type { ProposalOutput, Requirement, SpecChange } from '../../shared/authorWire';
import type { LineDiff } from '../../shared/wireTypes';
import { navigate } from '../router/router';
import { runtimeClient } from '../runtime/runtimeClient';
import { ChangeList } from '../ui/ChangeList';
import type { ChangeItem, ChangeLine } from '../ui/changeValue';
import { StatusBadge } from '../ui/StatusBadge';
import { formatSpecValue } from './formatSpecValue';
import type { ProposalCardState } from './proposalActionState';
import './proposalCard.css';

/** Props for {@link ProposalCard}. */
export interface ProposalCardProps {
  /** The propose call's `ok: true` output - the card's stored truth. */
  output: ProposalOutput;
  /** Where the card sits in the conversation (from `cardState`). */
  state: ProposalCardState;
  /** The Apply footer; only the actionable card receives one. */
  apply?: {
    onApply(): void;
    saving: boolean;
    disabledReason: string | null;
    error?: { message: string; latestProposalId?: string };
  };
  /** Scrolls to (and focuses) a newer card - the save-error escape hatch. */
  onShowNewer?(proposalId: string): void;
}

/**
 * The config-row labels, in display order (a row shows for every spec
 * field that is set and non-empty). Unknown keys fall back to the raw
 * field name, the same rule the carried-over note uses.
 */
export const SPEC_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  description: 'Description',
  model: 'Model',
  fallbackModels: 'Fallback models',
  instructions: 'Instructions',
  modelSettings: 'Model settings',
  reasoning: 'Reasoning',
  tools: 'Tools',
  mcpServers: 'MCP servers',
  skills: 'Skills',
  memory: 'Memory',
  subagents: 'Subagents',
  handoffs: 'Handoffs',
  guardrails: 'Guardrails',
  permissions: 'Permissions',
  permissionMode: 'Permission mode',
  hooks: 'Hooks',
  output: 'Output',
  limits: 'Limits',
  maxSteps: 'Max steps',
  triggers: 'Triggers',
  abortListeners: 'Abort listeners',
};

/** The order {@link SPEC_FIELD_LABELS} lists rows - `Object.keys` keeps insertion order. */
const FIELD_ORDER = Object.keys(SPEC_FIELD_LABELS);

/**
 * The server's `LineDiff` kinds (`add`/`del`/`context`/`gap`) onto
 * ChangeList's `ChangeLine` kinds (`added`/`removed`/`same`): a collapsed
 * `gap` run draws as one quiet context row naming the hidden count.
 */
function toChangeLine(line: LineDiff): ChangeLine {
  if (line.kind === 'gap') {
    return { kind: 'same', text: `··· ${line.count} unchanged ${line.count === 1 ? 'line' : 'lines'}` };
  }
  if (line.kind === 'add') return { kind: 'added', text: line.text };
  if (line.kind === 'del') return { kind: 'removed', text: line.text };
  return { kind: 'same', text: line.text };
}

/** `SpecChange[]` onto ChangeList's `ChangeItem[]` (only `lines` needs the kind mapping). */
function toChangeItem(change: SpecChange): ChangeItem {
  const { lines, ...rest } = change;
  return lines === undefined ? rest : { ...rest, lines: lines.map(toChangeLine) };
}

/** The status line each non-actionable card shows instead of the footer. */
const STATE_COPY: Record<Exclude<ProposalCardState, 'actionable'>, string> = {
  superseded: 'Replaced by a newer proposal',
  discarded: 'Discarded',
  saved: 'Saved',
};

/** A spec field value counts as "set" when it is not empty in any obvious way. */
function nonEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** One readiness row: icon, label (or the probe verdict), and its fix button. */
function RequirementRow({ req, spec }: { req: Requirement; spec: ProposalOutput['spec'] }): JSX.Element {
  const [probing, setProbing] = useState(false);
  const [verdict, setVerdict] = useState<string | null>(null);

  async function probe(target: string): Promise<void> {
    const server = spec.mcpServers?.[target];
    if (server === undefined) {
      setVerdict('Unreachable: the spec has no such MCP server');
      return;
    }
    setProbing(true);
    try {
      const res = await runtimeClient.probeMcp(server);
      setVerdict(res.ok ? `Reachable · ${res.tools.length} ${res.tools.length === 1 ? 'tool' : 'tools'}` : `Unreachable: ${res.error}`);
    } catch (error) {
      setVerdict(`Unreachable: ${error instanceof Error ? error.message : 'probe failed'}`);
    } finally {
      setProbing(false);
    }
  }

  const fix = req.fix;
  let button: JSX.Element | null = null;
  if (fix !== undefined && verdict === null) {
    if (fix.action === 'add_secret') {
      button = (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/settings')}>
          Add secret
        </button>
      );
    } else if (fix.action === 'open_settings') {
      button = (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(fix.target)}>
          Open Settings
        </button>
      );
    } else {
      button = (
        <button type="button" className="btn btn-ghost btn-sm" disabled={probing} onClick={() => void probe(fix.target)}>
          {probing ? 'Checking…' : 'Check'}
        </button>
      );
    }
  }

  return (
    <li className="proposal-req" data-status={req.status}>
      <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
      <span>{verdict ?? req.label}</span>
      {button}
    </li>
  );
}

/** The collapsible Instructions row (a `{ file }` spec shows the plain formatted value instead). */
function InstructionsValue({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n').length;
  return (
    <details>
      <summary>Instructions · {lines} {lines === 1 ? 'line' : 'lines'}</summary>
      <pre className="proposal-instructions">{text}</pre>
    </details>
  );
}

/** The `<dl>` of spec fields, one row per non-empty field in {@link SPEC_FIELD_LABELS} order. */
function ConfigRows({ spec, id }: { spec: ProposalOutput['spec']; id: string }): JSX.Element {
  return (
    <dl id={id} className="proposal-config">
      {FIELD_ORDER.filter((key) => nonEmpty(spec[key as keyof typeof spec])).map((key) => (
        <div className="proposal-row" key={key}>
          <dt>{SPEC_FIELD_LABELS[key]}</dt>
          <dd>
            {key === 'instructions' && typeof spec.instructions === 'string' ? (
              <InstructionsValue text={spec.instructions} />
            ) : (
              formatSpecValue(key, spec[key as keyof typeof spec])
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The error strip's escape hatch: scrolls the card the save gate points at into view. */
function ShowNewerButton({
  proposalId,
  onShowNewer,
}: {
  proposalId: string;
  onShowNewer: (proposalId: string) => void;
}): JSX.Element {
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onShowNewer(proposalId)}>
      Show the newer proposal
    </button>
  );
}

/** The card footer: the missing-requirements warning, the save error, and the Apply button. */
function ApplyFooter({
  output,
  apply,
  hasMissing,
  onShowNewer,
}: {
  output: ProposalOutput;
  apply: NonNullable<ProposalCardProps['apply']>;
  hasMissing: boolean;
  onShowNewer?: (proposalId: string) => void;
}): JSX.Element {
  const label = apply.saving ? 'Saving…' : output.kind === 'create' ? 'Save agent' : 'Apply changes';
  return (
    <footer className="proposal-foot">
      {hasMissing && (
        <p className="proposal-warn">Some requirements are missing. The agent still saves, and stays off until you add them.</p>
      )}
      {apply.error !== undefined && (
        <p className="proposal-error" role="alert">
          {apply.error.message}
          {apply.error.latestProposalId !== undefined && onShowNewer !== undefined && (
            <ShowNewerButton proposalId={apply.error.latestProposalId} onShowNewer={onShowNewer} />
          )}
        </p>
      )}
      <button
        type="button"
        className="btn btn-primary proposal-apply"
        disabled={apply.saving || apply.disabledReason !== null}
        title={apply.disabledReason ?? undefined}
        onClick={apply.onApply}
      >
        {label}
      </button>
    </footer>
  );
}

/**
 * One proposal card. `data-proposal-id` + `data-state` are the card's
 * public handles (the "Show the newer proposal" scroll targets the id;
 * the states dim via `data-state`). The diff comes from `output.changes`
 * verbatim - the server computed it at propose time.
 */
export function ProposalCard({ output, state, apply, onShowNewer }: ProposalCardProps): JSX.Element {
  // Creates open with their full configuration shown; updates lead with the diff.
  const [configOpen, setConfigOpen] = useState(output.kind === 'create');
  const { spec } = output;
  const titleId = `proposal-${output.proposalId}-title`;
  const configId = `proposal-${output.proposalId}-config`;
  const attention = output.requirements.filter((r) => r.status !== 'ok');
  const hasMissing = output.requirements.some((r) => r.status === 'missing');
  const carried = output.carriedOver ? output.carriedFields.map((f) => SPEC_FIELD_LABELS[f] ?? f) : [];

  return (
    <article className="proposal-card" data-proposal-id={output.proposalId} data-state={state} aria-labelledby={titleId}>
      {carried.length > 0 && (
        <p className="proposal-carried">
          <History size={14} strokeWidth={1.75} aria-hidden="true" />
          Your earlier change was never saved, so it is included here: <strong>{carried.join(', ')}</strong>. Applying
          saves everything shown below.
        </p>
      )}
      <header className="proposal-head">
        <span className="proposal-kind">{output.kind === 'create' ? 'New agent' : 'Change'}</span>
        <h3 id={titleId} className="proposal-name">
          {spec.name}
        </h3>
        <StatusBadge status={output.enabled ? 'enabled' : 'disabled'} />
      </header>
      {nonEmpty(spec.description) && <p className="proposal-desc">{spec.description}</p>}
      {output.kind === 'update' && (
        <section className="proposal-changes" aria-label="What changes">
          <h4 className="proposal-section-title">
            <GitCompareArrows size={14} strokeWidth={1.75} aria-hidden="true" />
            What changes · {output.changes.length} {output.changes.length === 1 ? 'field' : 'fields'}
          </h4>
          {output.changes.length === 0 ? (
            <p className="proposal-nochange">This proposal matches the saved agent. Applying it would change nothing.</p>
          ) : (
            <ChangeList changes={output.changes.map(toChangeItem)} />
          )}
        </section>
      )}
      {attention.length > 0 && (
        <ul className="proposal-reqs" aria-label="Needs attention">
          {attention.map((req) => (
            <RequirementRow key={req.id} req={req} spec={spec} />
          ))}
        </ul>
      )}
      <button
        type="button"
        className="proposal-toggle"
        aria-expanded={configOpen}
        aria-controls={configId}
        onClick={() => setConfigOpen((open) => !open)}
      >
        {configOpen ? 'Hide full configuration' : 'Show full configuration'}
      </button>
      {configOpen && <ConfigRows spec={spec} id={configId} />}
      {state !== 'actionable' && <p className="proposal-status">{STATE_COPY[state]}</p>}
      {state === 'actionable' && apply !== undefined && (
        <ApplyFooter output={output} apply={apply} hasMissing={hasMissing} onShowNewer={onShowNewer} />
      )}
    </article>
  );
}
