import type { PlaygroundMessage, PlaygroundRole } from './types';

const ROLES: PlaygroundRole[] = ['system', 'user', 'assistant'];
const MAX_ROWS = 200;

interface MessageEditorProps {
  messages: PlaygroundMessage[];
  onChange: (messages: PlaygroundMessage[]) => void;
}

/** The message rows: a role select and a text area each, plus remove and "Add message". */
export function MessageEditor({ messages, onChange }: MessageEditorProps) {
  const update = (index: number, patch: Partial<PlaygroundMessage>) =>
    onChange(messages.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  const remove = (index: number) => onChange(messages.filter((_, i) => i !== index));
  const add = () => {
    const last = messages.at(-1)?.role;
    onChange([...messages, { role: last === 'user' ? 'assistant' : 'user', content: '' }]);
  };

  return (
    <section className="pg-panel pg-messages" aria-labelledby="pg-messages-title">
      <h3 id="pg-messages-title" className="pg-panel-title">
        Messages
      </h3>
      <ol className="pg-message-list">
        {messages.map((message, index) => (
          <li key={index} className={`pg-message pg-message-${message.role}`}>
            <div className="pg-message-head">
              <label>
                <span className="visually-hidden">Role of message {index + 1}</span>
                <select
                  className="pg-role"
                  value={message.role}
                  onChange={(e) => update(index, { role: e.target.value as PlaygroundRole })}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-ghost pg-remove"
                aria-label={`Remove message ${index + 1}`}
                disabled={messages.length === 1}
                onClick={() => remove(index)}
              >
                Remove
              </button>
            </div>
            <label>
              <span className="visually-hidden">Content of message {index + 1}</span>
              <textarea
                className="pg-content"
                rows={message.role === 'system' ? 4 : 3}
                placeholder={message.role === 'system' ? 'System instructions, e.g. You are {persona}.' : 'Message text'}
                value={message.content}
                onChange={(e) => update(index, { content: e.target.value })}
              />
            </label>
          </li>
        ))}
      </ol>
      <button type="button" className="btn" onClick={add} disabled={messages.length >= MAX_ROWS}>
        Add message
      </button>
    </section>
  );
}
