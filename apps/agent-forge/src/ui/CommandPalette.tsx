import './commandPalette.css';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { navigate } from '../router/router';
import { NAV_ITEMS } from '../shell/NavRail';
import { SHORTCUTS, matchShortcut } from '../shell/shortcuts';
import { toggleTheme } from '../shell/theme';
import { useAppState } from '../state/AppState';
import { useToast } from './Toast';

/** One runnable entry in the command palette. */
interface Command {
  id: string;
  label: string;
  run: () => void;
}

/** A saved agent as the palette lists it: `id` routes and switches, `name` is shown. */
interface AgentRef {
  id: string;
  name: string;
}

const TRACE_ID = /^[0-9a-fA-F-]{8,}$/;

function baseCommands(agents: AgentRef[], openAgent: (id: string) => void): Command[] {
  return [
    ...NAV_ITEMS.map((item) => ({ id: `go:${item.id}`, label: `Go to ${item.label}`, run: () => navigate(item.href) })),
    ...agents.map((a) => ({ id: `agent:${a.id}`, label: `Open agent ${a.name}`, run: () => openAgent(a.id) })),
    { id: 'theme', label: 'Toggle theme', run: toggleTheme },
  ];
}

/**
 * The palette's commands for `query`: every command whose label contains it
 * (case-insensitive), led by "Open trace <id>" when the query looks like a
 * trace id (8+ characters of hex digits and dashes).
 */
export function buildCommands(query: string, agents: AgentRef[], openAgent: (id: string) => void): Command[] {
  const q = query.trim();
  const needle = q.toLowerCase();
  const matches = baseCommands(agents, openAgent).filter((c) => c.label.toLowerCase().includes(needle));
  if (!TRACE_ID.test(q)) return matches;
  const trace: Command = { id: 'trace', label: `Open trace ${q}`, run: () => navigate(`/traces/${q}`) };
  return [trace, ...matches];
}

/** Modal shell shared by the palette and the sheet: backdrop click closes, focus returns to where it was. */
function Dialog({
  label,
  className,
  onClose,
  children,
}: {
  label: string;
  className: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // the opener may have unmounted (e.g. the command navigated away): then leave focus where it falls
    return () => {
      if (previous?.isConnected) previous.focus?.();
    };
  }, []);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // one focusable control per dialog: keep focus inside
    }
  };
  return (
    <div className="cmdk-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={label} className={`cmdk-dialog ${className}`} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  );
}

function Palette({
  agents,
  openAgent,
  onClose,
}: {
  agents: AgentRef[];
  openAgent: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const commands = useMemo(() => buildCommands(query, agents, openAgent), [query, agents, openAgent]);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const current = Math.min(active, commands.length - 1);

  useEffect(() => input.current?.focus(), []);

  const run = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };
  const step = (delta: number) => {
    if (commands.length) setActive((current + delta + commands.length) % commands.length);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      step(move);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      run(commands[current]);
    }
  };
  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <Dialog label="Command palette" className="cmdk-palette" onClose={onClose}>
      <input
        ref={input}
        className="cmdk-input"
        role="combobox"
        aria-label="Command"
        aria-expanded={commands.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={commands.length ? optionId(current) : undefined}
        placeholder="Type a command or paste a trace id"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {commands.length ? (
        <ul id={listId} role="listbox" aria-label="Commands" className="cmdk-list">
          {commands.map((cmd, i) => (
            <li
              key={cmd.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === current}
              className="cmdk-option"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(cmd)}
            >
              {cmd.label}
            </li>
          ))}
        </ul>
      ) : (
        <p className="cmdk-empty">No matching commands</p>
      )}
    </Dialog>
  );
}

function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  return (
    <Dialog label="Keyboard shortcuts" className="cmdk-sheet" onClose={onClose}>
      <div className="cmdk-sheet-head">
        <h2 className="cmdk-sheet-title">Keyboard shortcuts</h2>
        <button ref={close} type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="cmdk-shortcuts">
        {SHORTCUTS.map((s) => (
          <div key={s.id} className="cmdk-shortcut">
            <dt>
              <kbd>{s.keys}</kbd>
            </dt>
            <dd>{s.description}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

/**
 * The global command palette (Ctrl/Cmd+K) and `?` shortcut sheet. Mount once
 * in the app shell; it owns the window keydown listener for both.
 */
export function CommandPalette() {
  const { agents, switchAgent } = useAppState();
  const toast = useToast();
  const [open, setOpen] = useState<'palette' | 'help' | null>(null);
  const agentRefs = useMemo(() => agents.map((a) => ({ id: a.id, name: a.spec.name || a.id })), [agents]);
  const openAgent = useCallback(
    (id: string) => {
      navigate(`/agents/${encodeURIComponent(id)}`);
      switchAgent(id).catch((err: unknown) =>
        toast.show({ tone: 'error', message: `Could not open agent ${id}: ${err instanceof Error ? err.message : String(err)}` }),
      );
    },
    [switchAgent, toast],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const id = matchShortcut(e);
      if (!id || e.repeat) return;
      e.preventDefault();
      setOpen((o) => (id === 'palette' && o === 'palette' ? null : id));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const onClose = () => setOpen(null);
  if (open === 'palette') return <Palette agents={agentRefs} openAgent={openAgent} onClose={onClose} />;
  if (open === 'help') return <ShortcutSheet onClose={onClose} />;
  return null;
}
