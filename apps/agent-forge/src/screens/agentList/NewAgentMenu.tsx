/**
 * The "New agent" affordances of the agents list (A04): {@link NewAgentMenu}
 * is the header's primary menu button (Blank agent · Describe with AI · From
 * template · separator · Import from file…), and {@link StartOptions} is the
 * empty state's four large start buttons - import included since L08b wired
 * it to the import sheet. Both read
 * the same action table from `useNewAgentActions`; anything not runnable yet
 * stays visible with its reason as the title and, on the start buttons, as
 * screen-reader text after the hint.
 */
import { useId } from 'react';
import { Plus } from 'lucide-react';
import { Menu, type MenuAction, type MenuEntry } from '../../ui/Menu';
import { type NewAgentActions, type NewAgentAction, type NewAgentKind } from './newAgent';
import './newAgent.css';

/** The action of `kind`, found by kind rather than position so a reordered table cannot mislabel a row. */
function actionOfKind(actions: NewAgentAction[], kind: NewAgentKind): NewAgentAction {
  const action = actions.find((candidate) => candidate.kind === kind);
  if (action === undefined) throw new Error(`useNewAgentActions: no '${kind}' action`);
  return action;
}

/** Maps one start action onto a Menu row; a missing `run` renders it disabled with its reason. */
function toMenuAction(action: NewAgentAction): MenuAction {
  return {
    id: action.kind,
    label: action.label,
    icon: action.icon,
    onSelect: action.run ?? (() => undefined),
    disabled: action.run === undefined,
    disabledReason: action.disabledReason,
  };
}

/**
 * The header action: a primary "New agent" button with a caret opening the four start ways.
 * Takes the shared {@link NewAgentActions} state so its `creating` flag is the same one the
 * empty state's start buttons see.
 */
export function NewAgentMenu({ actions, creating }: NewAgentActions): JSX.Element {
  const items: MenuEntry[] = [
    ...(['blank', 'describe', 'template'] as const).map((kind) => toMenuAction(actionOfKind(actions, kind))),
    { id: 'separator-import', separator: true },
    toMenuAction(actionOfKind(actions, 'import')),
  ];
  return (
    <Menu
      label="New agent"
      align="end"
      items={items}
      trigger={{
        text: creating ? 'Creating…' : 'New agent',
        icon: Plus,
        variant: 'primary',
        size: 'sm',
        caret: true,
      }}
      disabled={creating}
      disabledReason="Creating an agent…"
    />
  );
}

/** One large start button of the empty state; disabled buttons keep their reason reachable. */
function StartOption({ action }: { action: NewAgentAction }) {
  const hintId = useId();
  const reasonId = useId();
  const Icon = action.icon;
  const disabled = action.run === undefined;
  return (
    <button
      type="button"
      className="start-option"
      disabled={disabled}
      title={disabled ? action.disabledReason : undefined}
      aria-describedby={disabled && action.disabledReason ? `${hintId} ${reasonId}` : hintId}
      onClick={action.run}
    >
      <span className="start-option-icon">
        <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <span className="start-option-text">
        <span className="start-option-title">{action.label}</span>
        <span className="start-option-hint" id={hintId}>
          {action.hint}
        </span>
        {disabled && action.disabledReason ? (
          <span className="visually-hidden" id={reasonId}>
            {` ${action.disabledReason}`}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * The empty state's "Ways to start" group: all four start actions as large
 * buttons, import included (L08b). Takes the shared {@link NewAgentActions}
 * state (only `actions` is read) so a create started here disables the
 * header menu's trigger too.
 */
export function StartOptions({ actions }: NewAgentActions): JSX.Element {
  return (
    <div className="start-options" role="group" aria-label="Ways to start">
      {actions.map((action) => (
        <StartOption key={action.kind} action={action} />
      ))}
    </div>
  );
}
