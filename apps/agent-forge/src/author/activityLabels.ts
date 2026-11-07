import type { AuthorToolPart } from '../../shared/authorWire';

/** The quiet-copy triple one activity line cycles through (busy shows with a trailing `…`). */
export interface ActivityCopy {
  busy: string;
  done: string;
  failed: string;
}

/**
 * Person-facing copy for every Author tool's activity line, keyed by tool
 * name (the list mirrors `server/author/toolNames.ts` - a label-row test
 * keeps them in sync). Read tools keep quiet "Reading/Checking" verbs;
 * write and propose tools say what the person sees happen.
 */
export const ACTIVITY_LABELS: Record<string, ActivityCopy> = {
  getCurrentSpec: { busy: 'Reading the agent', done: 'Read the agent', failed: "Couldn't read the agent" },
  listAgents: { busy: 'Looking at your agents', done: 'Looked at your agents', failed: "Couldn't list your agents" },
  listModels: { busy: 'Checking models', done: 'Checked models', failed: "Couldn't check models" },
  listTools: { busy: 'Checking tools', done: 'Checked tools', failed: "Couldn't check tools" },
  listGuardrails: { busy: 'Checking guardrails', done: 'Checked guardrails', failed: "Couldn't check guardrails" },
  listTriggerTypes: { busy: 'Checking trigger types', done: 'Checked trigger types', failed: "Couldn't check trigger types" },
  listSkills: { busy: 'Checking skills', done: 'Checked skills', failed: "Couldn't check skills" },
  listKits: { busy: 'Checking kits', done: 'Checked kits', failed: "Couldn't check kits" },
  listTemplates: { busy: 'Looking at templates', done: 'Looked at templates', failed: "Couldn't list templates" },
  listMcpServers: { busy: 'Checking MCP servers', done: 'Checked MCP servers', failed: "Couldn't check MCP servers" },
  probeMcpServer: {
    busy: 'Connecting to the MCP server',
    done: 'Connected to the MCP server',
    failed: "Couldn't reach the MCP server",
  },
  searchDocs: { busy: 'Searching the docs', done: 'Searched the docs', failed: "Couldn't search the docs" },
  openPage: { busy: 'Opening the page', done: 'Opened the page', failed: "Couldn't open the page" },
  discardPendingChanges: {
    busy: 'Discarding unsaved changes',
    done: 'Discarded unsaved changes',
    failed: "Couldn't discard the changes",
  },
  setAgentEnabled: { busy: 'Switching the agent', done: 'Switched the agent', failed: "Couldn't switch the agent" },
  runDraft: { busy: 'Running the agent', done: 'Ran the agent', failed: 'The test run failed' },
  getTrace: { busy: 'Reading the run', done: 'Read the run', failed: "Couldn't read the run" },
  proposeAgent: { busy: 'Drafting the agent', done: 'Drafted the agent', failed: "Couldn't draft the agent" },
  proposeAgentUpdate: {
    busy: 'Drafting the change',
    done: 'Drafted the change',
    failed: "Couldn't draft the change",
  },
  saveAgent: { busy: 'Saving the agent', done: 'Saved the agent', failed: "Couldn't save the agent" },
  saveAgentUpdate: { busy: 'Saving the change', done: 'Saved the change', failed: "Couldn't save the change" },
  requestSecret: {
    busy: 'Preparing a secure card',
    done: 'Asked for a secret',
    failed: "Couldn't ask for the secret",
  },
};

/** What an unlisted tool (e.g. an MCP tool the server let through) reports. */
const FALLBACK_LABEL: ActivityCopy = { busy: 'Working', done: 'Done', failed: 'A step failed' };

/** Which of the three copy slots a part sits in: pending is busy; a settled part fails on `error` or `ok: false`. */
export type ActivityState = 'busy' | 'done' | 'failed';

/** Maps a tool part's wire state to the activity state the line shows. */
export function activityStateOf(part: AuthorToolPart): ActivityState {
  if (part.state === 'pending') return 'busy';
  if (part.state === 'error') return 'failed';
  const ok = (part.output as { ok?: unknown } | undefined)?.ok;
  return ok === false ? 'failed' : 'done';
}

/** The label for `name` in `state`, falling back to the generic row for tools without a card or a row. */
export function activityLabelFor(name: string, state: ActivityState): string {
  return (ACTIVITY_LABELS[name] ?? FALLBACK_LABEL)[state];
}
