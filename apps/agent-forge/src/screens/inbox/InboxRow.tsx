import { useState, type ReactNode } from 'react';

import { fmtAge } from '../../observe/format';
import { AgentTile } from '../../ui/AgentTile';
import type { InboxItem } from '../../../shared/wireTypes';

/** An approval/question deadline has passed (or is missing a parseable `expiresAt`). */
function isExpired(item: InboxItem, now: number): boolean {
  if (item.kind !== 'approval' && item.kind !== 'question') return false;
  if (item.expiresAt === null) return false;
  const at = Date.parse(item.expiresAt);
  return Number.isNaN(at) || at <= now;
}

/** `Expires in m:ss` for a deadline `ms` away; `null` when there is none or it passed. */
function expiresLabel(expiresAt: string | null, now: number): string | null {
  if (expiresAt === null) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  const left = at - now;
  if (left <= 0) return 'Expired';
  const total = Math.ceil(left / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `Expires in ${minutes}:${String(seconds).padStart(2, '0')}`;
}

interface RowProps extends InboxActionHandlers {
  item: InboxItem;
  /** The row's action is in flight: its buttons disable with a "Sending…" title. */
  acting: boolean;
  /** The screen's shared clock (ms epoch), ticking once a second. */
  now: number;
}

/** The callbacks every inbox row offers, shared by the row and its group wrapper. */
export interface InboxActionHandlers {
  onApprove: (item: InboxItem & { kind: 'approval' }, approved: boolean) => void;
  onAnswer: (item: InboxItem & { kind: 'question' }, answer: string) => void;
  onDismiss: (item: InboxItem & { kind: 'alert' }) => void;
  onAddToDataset: (item: InboxItem & { kind: 'alert' }) => void;
}

const agentHref = (item: InboxItem) => `#/agents/${encodeURIComponent(item.agentId)}/canvas`;
const suggestionsHref = (item: InboxItem) => `#/agents/${encodeURIComponent(item.agentId)}/suggestions`;
const overviewHref = (item: InboxItem) => `#/agents/${encodeURIComponent(item.agentId)}/overview`;

function Meta({ item, now }: { item: InboxItem; now: number }) {
  const deadline = item.kind === 'approval' || item.kind === 'question' ? expiresLabel(item.expiresAt, now) : null;
  const soon = item.kind === 'approval' || item.kind === 'question'
    ? item.expiresAt !== null && Date.parse(item.expiresAt) - now < 60_000 && Date.parse(item.expiresAt) > now
    : false;
  return (
    <p className="inbox-row-meta">
      <a href={agentHref(item)}>{item.agentName}</a>
      {' · '}
      {fmtAge(now - Date.parse(item.at))}
      {deadline !== null && (
        <>
          {' · '}
          <span className={soon ? 'inbox-deadline inbox-deadline-soon' : 'inbox-deadline'}>{deadline}</span>
        </>
      )}
    </p>
  );
}

function ActionButton({
  label,
  className,
  disabled,
  title,
  onClick,
}: {
  label: string;
  className: string;
  disabled: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={className} disabled={disabled} title={title} onClick={onClick}>
      {label}
    </button>
  );
}

/** The question row's answer controls: option buttons, or a free-text box + Send. */
function QuestionActions({ item, disabled, expired, onAnswer }: { item: InboxItem & { kind: 'question' }; disabled: boolean; expired: boolean; onAnswer: RowProps['onAnswer'] }) {
  const [text, setText] = useState('');
  const send = (answer: string) => {
    if (answer.trim() !== '') onAnswer(item, answer);
  };
  const freeText = item.allowFreeText || item.options.length === 0;
  return (
    <>
      {item.options.map((option) => (
        <ActionButton
          key={option}
          label={option}
          className="btn btn-secondary btn-sm"
          disabled={disabled || expired}
          title={expired ? 'This request expired' : disabled ? 'Sending…' : undefined}
          onClick={() => send(option)}
        />
      ))}
      {freeText && (
        <span className="inbox-answer-group">
          <input
            className="input inbox-answer"
            aria-label="Your answer"
            value={text}
            disabled={disabled || expired}
            title={expired ? 'This request expired' : undefined}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') send(text);
            }}
          />
          <ActionButton
            label="Send"
            className="btn btn-secondary btn-sm"
            disabled={disabled || expired || text.trim() === ''}
            title={expired ? 'This request expired' : disabled ? 'Sending…' : undefined}
            onClick={() => send(text)}
          />
        </span>
      )}
    </>
  );
}

/** The per-kind action cluster; a lookup keeps the row's branches flat. */
function RowActions(props: RowProps) {
  const { item, acting, now, onApprove, onAnswer, onDismiss, onAddToDataset } = props;
  const expired = isExpired(item, now);
  const disabled = acting;
  const expiredTitle = 'This request expired';
  const sendingTitle = 'Sending…';

  switch (item.kind) {
    case 'approval':
      return (
        <>
          <ActionButton
            label="Approve"
            className="btn btn-success btn-sm"
            disabled={disabled || expired}
            title={expired ? expiredTitle : disabled ? sendingTitle : undefined}
            onClick={() => onApprove(item, true)}
          />
          <ActionButton
            label="Deny"
            className="btn btn-secondary btn-sm"
            disabled={disabled || expired}
            title={expired ? expiredTitle : disabled ? sendingTitle : undefined}
            onClick={() => onApprove(item, false)}
          />
        </>
      );
    case 'question':
      return <QuestionActions item={item} disabled={disabled} expired={expired} onAnswer={onAnswer} />;
    case 'draft':
    case 'suggestion':
      return (
        <a className="btn btn-secondary btn-sm" href={suggestionsHref(item)}>
          Review
        </a>
      );
    case 'alert':
      return (
        <>
          {item.alertKind === 'low_rating' && (
            <ActionButton
              label={`Add to dataset ${item.agentId}-regressions`}
              className="btn btn-secondary btn-sm"
              disabled={disabled}
              title={disabled ? sendingTitle : undefined}
              onClick={() => onAddToDataset(item)}
            />
          )}
          <a className="btn btn-secondary btn-sm" href={overviewHref(item)}>
            Open agent
          </a>
          <ActionButton
            label="Dismiss"
            className="btn btn-ghost btn-sm"
            disabled={disabled}
            title={disabled ? sendingTitle : undefined}
            onClick={() => onDismiss(item)}
          />
        </>
      );
  }
}

/** One inbox row: the agent tile, title/detail/meta, and the kind's actions. */
export function InboxRow(props: RowProps): ReactNode {
  const { item } = props;
  return (
    <li className="inbox-row" data-kind={item.kind}>
      <AgentTile id={item.agentId} size="sm" />
      <div className="inbox-row-main">
        <p className="inbox-row-title">{item.title}</p>
        {item.detail !== null && <p className="inbox-row-detail">{item.detail}</p>}
        <Meta item={item} now={props.now} />
      </div>
      <div className="inbox-row-actions">
        <RowActions {...props} />
      </div>
    </li>
  );
}
