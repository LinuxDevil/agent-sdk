import './commandPalette.css';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  CornerDownLeft,
  Search,
  SunMoon,
  TextSearch,
  type LucideIcon,
} from 'lucide-react';
import { navigate } from '../router/router';
import { NAV_ITEMS } from '../shell/NavRail';
import { SHORTCUTS, matchShortcut } from '../shell/shortcuts';
import { toggleTheme } from '../shell/theme';
import { useAppState } from '../state/AppState';

/** One runnable entry in the command palette. */
interface Command {
  id: string;
  label: string;
  run: () => void;
  /** Section label the palette groups it under; consecutive commands with the same group share one section. */
  group?: string;
  /** Leading 16px icon (decorative). */
  icon?: LucideIcon;
}

/** A saved agent as the palette lists it: `id` routes and switches, `name` is shown. */
interface AgentRef {
  id: string;
  name: string;
}

const TRACE_ID = /^[0-9a-fA-F-]{8,}$/;

function baseCommands(agents: AgentRef[], openAgent: (id: string) => void): Command[] {
  return [
    ...NAV_ITEMS.map((item) => ({
      id: `go:${item.id}`,
      label: `Go to ${item.label}`,
      run: () => navigate(item.href),
      group: 'Navigation',
      // The nav rail's own icon, so a destination looks the same in both places.
      icon: item.icon,
    })),
    ...agents.map((a) => ({ id: `agent:${a.id}`, label: `Open agent ${a.name}`, run: () => openAgent(a.id), group: 'Agents', icon: Bot })),
    { id: 'theme', label: 'Toggle theme', run: toggleTheme, group: 'Actions', icon: SunMoon },
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
  const trace: Command = { id: 'trace', label: `Open trace ${q}`, run: () => navigate(`/traces/${q}`), group: 'Trace', icon: TextSearch };
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
    // Modal: no keydown leaks to window-level handlers behind it (a queue's `S` skip, table row keys).
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
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

/** A run of consecutive commands sharing a group; `start` is the first one's index in the flat list. */
interface CommandSection {
  group?: string;
  start: number;
  items: Command[];
}

/** Consecutive commands with the same `group` form one section, so keyboard order and visual order match. */
function sections(commands: Command[]): CommandSection[] {
  const out: CommandSection[] = [];
  commands.forEach((cmd, i) => {
    const last = out[out.length - 1];
    if (last && last.group === cmd.group) last.items.push(cmd);
    else out.push({ group: cmd.group, start: i, items: [cmd] });
  });
  return out;
}

/** A labelled `role="group"` of options (the APG grouped-listbox pattern); ungrouped commands render bare. */
function Section({ section, listId, children }: { section: CommandSection; listId: string; children: ReactNode }) {
  if (!section.group) return <>{children}</>;
  const labelId = `${listId}-group-${section.start}`;
  return (
    <li role="presentation" className="cmdk-section">
      <ul role="group" aria-labelledby={labelId} className="cmdk-group">
        <li role="presentation" id={labelId} className="cmdk-group-label">
          {section.group}
        </li>
        {children}
      </ul>
    </li>
  );
}

function Option({ cmd, id, selected, onHover, onPick }: {
  cmd: Command;
  id: string;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const Icon = cmd.icon;
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      className="cmdk-option"
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onHover}
      onClick={onPick}
    >
      {Icon && <Icon className="cmdk-option-icon" size={16} strokeWidth={1.75} aria-hidden="true" />}
      <span className="cmdk-option-label">{cmd.label}</span>
    </li>
  );
}

/** The key hints under the list; decorative, since the combobox and listbox carry the semantics. */
function PaletteFooter() {
  return (
    <div className="cmdk-footer" aria-hidden="true">
      <span className="cmdk-hint">
        <kbd>
          <ArrowUp size={12} strokeWidth={2} />
        </kbd>
        <kbd>
          <ArrowDown size={12} strokeWidth={2} />
        </kbd>
        navigate
      </span>
      <span className="cmdk-hint">
        <kbd>
          <CornerDownLeft size={12} strokeWidth={2} />
        </kbd>
        open
      </span>
      <span className="cmdk-hint">
        <kbd>esc</kbd>
        close
      </span>
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
  const optionId = (i: number) => `${listId}-opt-${i}`;

  useEffect(() => input.current?.focus(), []);
  // Keep the active option in view as the arrows walk a list taller than the dialog.
  useEffect(() => {
    if (current >= 0) document.getElementById(`${listId}-opt-${current}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [current, listId]);

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

  return (
    <Dialog label="Command palette" className="cmdk-palette" onClose={onClose}>
      <div className="cmdk-search">
        <Search className="cmdk-search-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
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
        <kbd aria-hidden="true">Esc</kbd>
      </div>
      {commands.length ? (
        <ul id={listId} role="listbox" aria-label="Commands" className="cmdk-list">
          {sections(commands).map((section) => (
            <Section key={section.start} section={section} listId={listId}>
              {section.items.map((cmd, j) => {
                const i = section.start + j;
                return (
                  <Option
                    key={cmd.id}
                    cmd={cmd}
                    id={optionId(i)}
                    selected={i === current}
                    onHover={() => setActive(i)}
                    onPick={() => run(cmd)}
                  />
                );
              })}
            </Section>
          ))}
        </ul>
      ) : (
        <p className="cmdk-empty">No matching commands</p>
      )}
      <PaletteFooter />
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
        <button ref={close} type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
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
 * in the app shell; it owns the window keydown listener for both. While either
 * is open it stops every keydown inside it from reaching window-level handlers.
 */
export function CommandPalette() {
  const { agents } = useAppState();
  const [open, setOpen] = useState<'palette' | 'help' | null>(null);
  const agentRefs = useMemo(() => agents.map((a) => ({ id: a.id, name: a.spec.name || a.id })), [agents]);
  // The hash drives selection (screens/agents/useAgentRouteSync.ts): it asks about unsaved changes and reports a failed open.
  const openAgent = useCallback((id: string) => navigate(`/agents/${encodeURIComponent(id)}`), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const id = matchShortcut(e);
      if (!id || e.repeat) return;
      e.preventDefault();
      setOpen((o) => (id === 'palette' && o === 'palette' ? null : id));
    };
    // Capture phase: the dialog stops every keydown it gets from bubbling to window, so the toggle must not wait for it.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const onClose = () => setOpen(null);
  if (open === 'palette') return <Palette agents={agentRefs} openAgent={openAgent} onClose={onClose} />;
  if (open === 'help') return <ShortcutSheet onClose={onClose} />;
  return null;
}
