import { Bot, Plus, Settings2, Trash2, User, type LucideIcon } from 'lucide-react';

import type { PlaygroundMessage, PlaygroundRole } from './types';

const ROLES: PlaygroundRole[] = ['system', 'user', 'assistant'];
const MAX_ROWS = 200;
/** The avatar per role, as in MessageView's transcript bubbles. */
const ROLE_ICON: Record<PlaygroundRole, LucideIcon> = { system: Settings2, user: User, assistant: Bot };

interface MessageEditorProps {
  messages: PlaygroundMessage[];
  onChange: (messages: PlaygroundMessage[]) => void;
}

interface MessageCardProps {
  message: PlaygroundMessage;
  index: number;
  only: boolean;
  onUpdate: (patch: Partial<PlaygroundMessage>) => void;
  onRemove: () => void;
}

/** One message: a role avatar and role select chip, a remove button, and the content. */
function MessageCard({ message, index, only, onUpdate, onRemove }: MessageCardProps) {
  const Icon = ROLE_ICON[message.role];
  const n = index + 1;
  return (
    <li className={`pg-message pg-message-${message.role}`} data-role={message.role}>
      <div className="pg-message-head">
        <span className="pg-role-avatar" aria-hidden="true">
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <label className="pg-role-chip">
          <span className="visually-hidden">Role of message {n}</span>
          <select
            className="pg-role"
            value={message.role}
            onChange={(e) => onUpdate({ role: e.target.value as PlaygroundRole })}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <span className="pg-message-count tabular-nums" aria-hidden="true">
          {message.content.length > 0 ? `${message.content.length.toLocaleString()} chars` : ''}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm pg-remove"
          aria-label={`Remove message ${n}`}
          title="Remove message"
          disabled={only}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </div>
      <label className="pg-content-label">
        <span className="visually-hidden">Content of message {n}</span>
        <textarea
          className="pg-content"
          rows={message.role === 'system' ? 4 : 3}
          placeholder={message.role === 'system' ? 'System instructions, e.g. You are {persona}.' : 'Message text'}
          value={message.content}
          onChange={(e) => onUpdate({ content: e.target.value })}
        />
      </label>
    </li>
  );
}

/** The message cards (role chip, content, remove) plus the "Add message" ghost button. */
export function MessageEditor({ messages, onChange }: MessageEditorProps) {
  const update = (index: number, patch: Partial<PlaygroundMessage>) =>
    onChange(messages.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  const remove = (index: number) => onChange(messages.filter((_, i) => i !== index));
  const add = () => {
    const last = messages.at(-1)?.role;
    onChange([...messages, { role: last === 'user' ? 'assistant' : 'user', content: '' }]);
  };

  return (
    <div className="pg-messages">
      <ol className="pg-message-list">
        {messages.map((message, index) => (
          <MessageCard
            key={index}
            message={message}
            index={index}
            only={messages.length === 1}
            onUpdate={(patch) => update(index, patch)}
            onRemove={() => remove(index)}
          />
        ))}
      </ol>
      <button type="button" className="btn btn-ghost btn-sm pg-add" onClick={add} disabled={messages.length >= MAX_ROWS}>
        <Plus aria-hidden="true" />
        Add message
      </button>
    </div>
  );
}
