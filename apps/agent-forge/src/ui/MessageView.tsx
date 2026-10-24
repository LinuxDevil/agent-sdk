import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { JsonView } from './JsonView';
import './messageView.css';

/**
 * Props for {@link MessageView}. `value` is an observation's input or output as
 * stored (often JSON text, possibly truncated so it no longer parses); `label`
 * is the block heading, e.g. "Input".
 */
export interface MessageViewProps {
  value: string | null;
  label?: string;
}

type Mode = 'rendered' | 'raw' | 'json';
type CopyState = 'idle' | 'copied' | 'failed';

interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ContentPart {
  type?: string;
  text?: string;
  name?: string;
}

/** Strings longer than this render as a first chunk plus a "Show all" button. */
const CHUNK = 8 * 1024;
const ARGS_PREVIEW = 60;
const MODE_LABEL: Record<Mode, string> = { rendered: 'Rendered', raw: 'Raw', json: 'JSON' };
const COPY_LABEL: Record<CopyState, string> = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Parse JSON objects/arrays only; anything else (plain text, truncated JSON, bare scalars) is text. */
function parseJson(value: string): { ok: true; data: object } | { ok: false } {
  const first = value.trimStart()[0];
  if (first !== '{' && first !== '[') return { ok: false };
  try {
    const data: unknown = JSON.parse(value);
    return isRecord(data) ? { ok: true, data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** A chat transcript: an array of `{ role }` objects, or an object holding one under `messages`. */
function asMessages(data: object): ChatMessage[] | undefined {
  const list = Array.isArray(data) ? data : (data as { messages?: unknown }).messages;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.every((m) => isRecord(m) && typeof m.role === 'string') ? (list as ChatMessage[]) : undefined;
}

/** Text without per-character work; long strings show a first chunk until expanded. */
function LongText({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const clipped = !all && text.length > CHUNK;
  return (
    <>
      <div className="mv-text">{clipped ? text.slice(0, CHUNK) : text}</div>
      {clipped && (
        <button type="button" className="mv-more" onClick={() => setAll(true)}>
          Show all ({Math.round(text.length / 1024)} KB)
        </button>
      )}
    </>
  );
}

function Chip({ name, detail }: { name: string; detail?: string }) {
  const preview = detail && detail.length > ARGS_PREVIEW ? `${detail.slice(0, ARGS_PREVIEW)}…` : detail;
  return (
    <span className="mv-chip" title={detail}>
      <span className="mv-chip-name">{name}</span>
      {preview && <span className="mv-chip-args">{preview}</span>}
    </span>
  );
}

function Part({ part }: { part: unknown }) {
  if (typeof part === 'string') return <LongText text={part} />;
  const p = (isRecord(part) ? part : {}) as ContentPart;
  if (p.type === 'text' && typeof p.text === 'string') return <LongText text={p.text} />;
  return <Chip name={p.name ?? p.type ?? 'part'} />;
}

function Content({ content }: { content: unknown }) {
  if (content == null || content === '') return null;
  if (typeof content === 'string') return <LongText text={content} />;
  if (Array.isArray(content)) return content.map((part, i) => <Part key={i} part={part} />);
  return <JsonView value={content} />;
}

function Bubble({ message }: { message: ChatMessage }) {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return (
    <div className="mv-bubble" data-role={message.role}>
      <div className="mv-bubble-head">
        <span className="mv-role">{message.role}</span>
        {message.tool_call_id && <span className="mv-call-id">{message.tool_call_id}</span>}
      </div>
      <Content content={message.content} />
      {calls.length > 0 && (
        <div className="mv-chips">
          {calls.map((call, i) => (
            <Chip key={call.id ?? i} name={call.function?.name ?? 'tool'} detail={call.function?.arguments} />
          ))}
        </div>
      )}
    </div>
  );
}

function Rendered({ value, data }: { value: string; data: object | undefined }) {
  if (!data) return <LongText text={value} />;
  const messages = asMessages(data);
  if (!messages) return <JsonView value={data} />;
  return (
    <div className="mv-thread">
      {messages.map((m, i) => (
        <Bubble key={i} message={m} />
      ))}
    </div>
  );
}

/** Copy `text` to the clipboard; the label reports the outcome for a moment. */
function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const settle = (next: CopyState) => {
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      settle('copied');
    } catch {
      settle('failed');
    }
  };
  return (
    <button type="button" className="mv-btn" onClick={() => void copy()}>
      {COPY_LABEL[state]}
    </button>
  );
}

function ModeSwitch({ modes, mode, onMode }: { modes: Mode[]; mode: Mode; onMode: (m: Mode) => void }) {
  return (
    <div className="mv-modes" role="group" aria-label="View mode">
      {modes.map((m) => (
        <button key={m} type="button" className="mv-btn" aria-pressed={m === mode} onClick={() => onMode(m)}>
          {MODE_LABEL[m]}
        </button>
      ))}
    </div>
  );
}

function Body({ mode, value, data }: { mode: Mode; value: string; data: object | undefined }) {
  if (mode === 'raw') return <pre className="mv-raw">{value}</pre>;
  if (mode === 'json' && data) return <JsonView value={data} />;
  return <Rendered value={value} data={data} />;
}

function Header({ label, children }: { label?: string; children?: ReactNode }) {
  return (
    <div className="mv-head">
      {label && <span className="mv-label">{label}</span>}
      {children}
    </div>
  );
}

/**
 * One payload block (an observation's input or output): chat bubbles for an
 * OpenAI-style message array (role-labelled, tool calls as chips), a JSON tree
 * for other JSON, plain text otherwise. A Raw toggle shows the exact string,
 * a JSON toggle (when it parses) the parsed tree, and a copy button copies the string.
 */
export function MessageView({ value, label }: MessageViewProps) {
  const [mode, setMode] = useState<Mode>('rendered');
  const parsed = useMemo(() => (value ? parseJson(value) : { ok: false as const }), [value]);
  const data = parsed.ok ? parsed.data : undefined;
  if (!value) {
    return (
      <section className="mv">
        <Header label={label} />
        <p className="mv-empty">empty</p>
      </section>
    );
  }
  const modes: Mode[] = data ? ['rendered', 'raw', 'json'] : ['rendered', 'raw'];
  const active = modes.includes(mode) ? mode : 'rendered';
  return (
    <section className="mv">
      <Header label={label}>
        <ModeSwitch modes={modes} mode={active} onMode={setMode} />
        <CopyButton text={value} />
      </Header>
      <div className="mv-body">
        <Body key={value} mode={active} value={value} data={data} />
      </div>
    </section>
  );
}
