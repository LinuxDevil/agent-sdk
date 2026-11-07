/**
 * The "New agent" ways to start (A04): the header menu's four actions and
 * the empty state's three large start buttons share this one table. Blank
 * creates through `POST /agents` and opens the new agent's canvas; From
 * template navigates to `/templates` once A10 registers that route (checked
 * against `routeTable.ts`, which is React-free so there is no import cycle
 * with `screens/routes.tsx`). Describe with AI waits for AA19's Author dock
 * entry point and Import from file… for L08's import sheet - until then they
 * carry a `disabledReason` the menu and start buttons surface as their title.
 */
import { useCallback, useMemo, useState } from 'react';
import { FilePlus2, LayoutTemplate, Sparkles, Upload, type LucideIcon } from 'lucide-react';
import { runtimeClient } from '../../runtime/runtimeClient';
import { navigate } from '../../router/router';
import { useToast } from '../../ui/Toast';
import { ROUTES, type RouteEntry } from '../routeTable';
import { agentTabPath } from '../agents/agentTabs';

/** The four ways to start an agent, in menu order. */
export type NewAgentKind = 'blank' | 'describe' | 'template' | 'import';

/** One start option: its kind, copy, icon, and either `run` or the `disabledReason` shown instead. */
export interface NewAgentAction {
  kind: NewAgentKind;
  label: string;
  /** The large-button second line (the menu ignores it). */
  hint: string;
  icon: LucideIcon;
  /** Absent while the way cannot run yet - or while a create is in flight. */
  run?: () => void;
  /** Why `run` is absent; the menu item and start button show it as their title. */
  disabledReason?: string;
}

const HINT_BLANK = 'Start from an empty canvas and add what you need.';
const HINT_DESCRIBE = 'Tell the Agent Author what you want, then review its proposal.';
const HINT_TEMPLATE = 'Start from a ready-made agent and adapt it.';
const HINT_IMPORT = 'Bring an agent spec file into the workspace.';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Whether A10 has registered `/templates` in the route table. Reads
 * `routeTable.ts` (no React imports) rather than `routes.tsx`, so callers can
 * detect the screen without an import cycle.
 */
export function hasTemplatesRoute(routes: readonly RouteEntry[] = ROUTES): boolean {
  return routes.some((route) => route.pattern === '/templates');
}

/** What {@link useNewAgentActions} returns: the four start actions and whether a blank create is in flight. */
export interface NewAgentActions {
  actions: NewAgentAction[];
  creating: boolean;
}

/**
 * The four start actions for the New agent menu and the empty state's start
 * buttons. `creating` is true while the blank create is in flight; failures
 * toast `error` with the server message. One instance must be shared by the
 * header menu and the empty state (AgentListScreen owns it): two instances
 * would each track `creating` separately and allow a duplicate POST /agents.
 */
export function useNewAgentActions(): NewAgentActions {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const templatesAvailable = hasTemplatesRoute();

  const createBlank = useCallback(() => {
    setCreating(true);
    runtimeClient
      .createAgentRecord({ from: 'blank' })
      .then((record) => navigate(agentTabPath(record.id, 'canvas')))
      .catch((error: unknown) => toast.show({ message: messageOf(error), tone: 'error' }))
      .finally(() => setCreating(false));
  }, [toast]);

  const openTemplates = useCallback(() => navigate('/templates'), []);

  const actions = useMemo<NewAgentAction[]>(() => {
    const blank: NewAgentAction = creating
      ? { kind: 'blank', label: 'Blank agent', hint: HINT_BLANK, icon: FilePlus2, disabledReason: 'Creating an agent…' }
      : { kind: 'blank', label: 'Blank agent', hint: HINT_BLANK, icon: FilePlus2, run: createBlank };
    return [
      blank,
      {
        kind: 'describe',
        label: 'Describe with AI',
        hint: HINT_DESCRIBE,
        icon: Sparkles,
        disabledReason: 'The Agent Author isn’t set up yet.',
      },
      templatesAvailable
        ? { kind: 'template', label: 'From template', hint: HINT_TEMPLATE, icon: LayoutTemplate, run: openTemplates }
        : {
            kind: 'template',
            label: 'From template',
            hint: HINT_TEMPLATE,
            icon: LayoutTemplate,
            disabledReason: 'Templates aren’t available yet.',
          },
      {
        kind: 'import',
        label: 'Import from file…',
        hint: HINT_IMPORT,
        icon: Upload,
        disabledReason: 'Import arrives with the import sheet.',
      },
    ];
  }, [creating, templatesAvailable, createBlank, openTemplates]);

  return { actions, creating };
}
