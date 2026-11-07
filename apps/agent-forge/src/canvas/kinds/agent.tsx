/**
 * The `KindView` for `agent` nodes (the root agent and every inline
 * subagent): the card's title is the agent's name (the `subagents` key for
 * an inline subagent), the chip its model, and the rows a one-line digest
 * of its instructions, prompt ref and reasoning. `Fields` is the full
 * agent Inspector (`agent/AgentFields.tsx`). No palette entry: the root
 * always exists and inline subagents come from C04's palette.
 */
import { Bot } from 'lucide-react';
import type { AgentFields, NodeOfKind } from '../../graph/v2/types';
import { AgentFields as AgentInspector } from './agent/AgentFields';
import type { KindView, NodeRow } from './index';

/** The instructions row: the first non-empty line of text (≤ 40 chars + '…'), or `file: <path>`. */
function instructionsRow(instructions: AgentFields['instructions']): string | undefined {
  if (instructions === undefined || instructions === null) return undefined;
  if (typeof instructions !== 'string') {
    return typeof instructions.file === 'string' && instructions.file !== ''
      ? `file: ${instructions.file}`
      : undefined;
  }
  const line = instructions.split('\n').find((l) => l.trim() !== '');
  if (line === undefined) return undefined;
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/** The reasoning row: the effort string, or '<n> tokens' for a budget object. */
function reasoningRow(reasoning: AgentFields['reasoning']): string | undefined {
  if (reasoning === undefined || reasoning === null) return undefined;
  if (typeof reasoning === 'string') return reasoning;
  if (reasoning.budgetTokens !== undefined) return `${reasoning.budgetTokens} tokens`;
  return reasoning.effort ?? 'on';
}

/** The card rows, in the ticket's order; absent fields are skipped. */
function rows(node: NodeOfKind<'agent'>): NodeRow[] {
  const { fields } = node.data;
  const rows: NodeRow[] = [];
  const instructions = instructionsRow(fields.instructions);
  if (instructions !== undefined) rows.push({ k: 'instructions', v: instructions });
  if (fields.promptRef !== undefined && fields.promptRef !== '') rows.push({ k: 'prompt', v: fields.promptRef });
  const reasoning = reasoningRow(fields.reasoning);
  if (reasoning !== undefined) rows.push({ k: 'reasoning', v: reasoning });
  return rows;
}

/** The `agent` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const AGENT_VIEW: KindView<'agent'> = {
  label: 'Agent',
  tone: 'violet',
  Icon: Bot,
  title: (node) => node.data.subagentKey ?? (node.data.fields.name || '(unnamed)'),
  chip: (node) => node.data.fields.model || undefined,
  rows,
  ports: { in: true, out: true },
  Fields: AgentInspector,
  palette: [],
};
