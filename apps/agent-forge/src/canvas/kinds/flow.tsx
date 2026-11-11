/**
 * The `KindView` for `flow` nodes — one node per `AgentFlow` step
 * (`flow:<step id>`). The card's title is the step type's palette label
 * (or the raw `type` for editor-only/unknown steps), its chip the step id,
 * and its rows a one-line summary of the step's key field. `Fields` stays
 * the generic JSON editor over `data.step` — per-step forms are C25's.
 * `STEP_VIEWS` is the single table the card, the palette and (later) the
 * Inspector share; the palette offers one Flow-group entry per runnable
 * step type, and every entry's `afterAdd` runs `attachNewStep` so a new
 * step is never left orphaned.
 */
import {
  Bot,
  Box,
  Calculator,
  Columns3,
  Flag,
  GitBranch,
  ListOrdered,
  Repeat,
  Sparkles,
  UserCheck,
  Variable,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { attachNewStep, emptyFlowChildren, nextStepId } from '../../graph/v2/kinds/flow';
import type { FlowNodeData, NodeOfKind } from '../../graph/v2/types';
import { GenericFields } from './GenericFields';
import type { KindTone, KindView, NodeRow, PaletteEntry } from './index';

/** Card/palette metadata for one step `type`. */
export interface FlowStepView {
  /** Sentence-case label (`Sequence`, `Model call`, …). */
  label: string;
  Icon: LucideIcon;
  /** The card/palette tile tone (C15's per-step-type table). */
  tone: KindTone;
  /** Palette copy plus the step's default fields (everything but `type`/`id`). */
  palette?: { id: string; label: string; description: string; fields: Record<string, unknown> };
}

const clip = (text: string): string => {
  const line = text.split('\n', 1)[0];
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The step-type table: the eleven palette entries plus the executable
 * leaf types that have no palette entry (`return`, `throw`) and the
 * `Box` fallback for editor-only/unknown types.
 */
export const STEP_VIEWS: Record<string, FlowStepView> = {
  sequence: {
    label: 'Sequence',
    Icon: ListOrdered,
    tone: 'neutral',
    palette: { id: 'flow-sequence', label: 'Sequence', description: 'Runs steps in order', fields: {} },
  },
  parallel: {
    label: 'Parallel',
    Icon: Columns3,
    tone: 'neutral',
    palette: { id: 'flow-parallel', label: 'Parallel', description: 'Runs steps side by side', fields: {} },
  },
  oneOf: {
    label: 'Router',
    Icon: GitBranch,
    tone: 'neutral',
    palette: { id: 'flow-router', label: 'Router', description: 'Picks a branch by condition', fields: {} },
  },
  forEach: {
    label: 'Loop',
    Icon: Repeat,
    tone: 'neutral',
    palette: {
      id: 'flow-loop',
      label: 'Loop',
      description: 'Runs a step for each item',
      fields: { items: '$items', itemVariable: 'item' },
    },
  },
  evaluator: {
    label: 'Evaluate',
    Icon: Calculator,
    tone: 'accent',
    palette: {
      id: 'flow-evaluate',
      label: 'Evaluate',
      description: 'Computes an expression',
      fields: { expression: '', outputVariable: 'result' },
    },
  },
  llmCall: {
    label: 'Model call',
    Icon: Sparkles,
    tone: 'violet',
    palette: {
      id: 'flow-llm',
      label: 'Model call',
      description: 'Asks a model for text',
      fields: { prompt: '', outputVariable: 'text' },
    },
  },
  agent: {
    label: 'Run an agent',
    Icon: Bot,
    tone: 'violet',
    palette: {
      id: 'flow-agent',
      label: 'Run an agent',
      description: 'Runs a subagent or this agent',
      fields: { agent: '', outputVariable: 'answer' },
    },
  },
  approval: {
    label: 'Ask for approval',
    Icon: UserCheck,
    tone: 'warning',
    palette: {
      id: 'flow-approval',
      label: 'Ask for approval',
      description: 'Pauses until a person approves',
      fields: { message: '' },
    },
  },
  toolCall: {
    label: 'Tool call',
    Icon: Wrench,
    tone: 'info',
    palette: {
      id: 'flow-tool',
      label: 'Tool call',
      description: 'Calls one of the agent’s tools',
      fields: { tool: '', arguments: {}, outputVariable: 'toolResult' },
    },
  },
  setVariable: {
    label: 'Set variable',
    Icon: Variable,
    tone: 'accent',
    palette: {
      id: 'flow-set',
      label: 'Set variable',
      description: 'Stores a value for later steps',
      fields: { variable: '', value: '' },
    },
  },
  end: {
    label: 'End',
    Icon: Flag,
    tone: 'success',
    palette: { id: 'flow-end', label: 'End', description: 'Finishes the flow with a value', fields: { value: '$text' } },
  },
  return: { label: 'Return', Icon: Box, tone: 'accent' },
  throw: { label: 'Throw', Icon: Box, tone: 'accent' },
};

/** The card title: the step type's label, or the raw type for shapes the table does not know. */
function title(node: NodeOfKind<'flow'>): string {
  const type = String(node.data.step.type);
  return STEP_VIEWS[type]?.label ?? (type === '' ? 'Step' : type);
}

/** The card rows: one key/value line summarising the step's main field. */
function rows(node: NodeOfKind<'flow'>): NodeRow[] {
  const { step, children } = node.data as FlowNodeData;
  const result: NodeRow[] = [];
  const push = (k: string, v: string) => {
    if (v !== '') result.push({ k, v });
  };
  switch (String(step.type)) {
    case 'sequence':
    case 'parallel':
      push('steps', String(children.shape === 'steps' ? children.ids.length : 0));
      break;
    case 'oneOf':
      push('options', String(children.shape === 'options' ? children.options.length : 0));
      break;
    case 'forEach':
      push('items', clip(str(step.items)));
      break;
    case 'evaluator':
      push('expression', clip(str(step.expression)));
      break;
    case 'llmCall':
      push('prompt', clip(str(step.prompt)));
      break;
    case 'agent':
      push('agent', str(step.agent));
      break;
    case 'approval':
      push('message', clip(str(step.message)));
      break;
    case 'toolCall':
      push('tool', str(step.tool));
      break;
    case 'setVariable': {
      const value = step.value;
      const shown = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
      push('set', clip(`${str(step.variable)} =${shown === '' ? '' : ` ${shown}`}`));
      break;
    }
    case 'end':
      push('value', clip(str(step.value)));
      break;
    default:
      break;
  }
  const output = step.outputVariable;
  if (typeof output === 'string' && output !== '' && result.length < 4) {
    result.push({ k: '→', v: output });
  }
  return result.slice(0, 4);
}

/** One Flow-group palette entry: `create` gives the step type's defaults a fresh `s<n>` id and its empty children shape. */
function paletteEntry(type: string, view: FlowStepView): PaletteEntry {
  const { id, label, description, fields } = view.palette as NonNullable<FlowStepView['palette']>;
  return {
    id,
    group: 'Flow',
    label,
    description,
    kind: 'flow',
    Icon: view.Icon,
    tone: view.tone,
    create: (graph) => ({
      kind: 'flow',
      data: {
        step: { type, id: nextStepId(graph), ...fields },
        children: emptyFlowChildren(type),
      },
    }),
    // `attachNewStep` links the fresh node into the tree (root, container,
    // after-selection or a new sequence) — palette adds never orphan.
    afterAdd: attachNewStep,
  };
}

const PALETTE: PaletteEntry[] = Object.entries(STEP_VIEWS).flatMap(([type, view]) =>
  view.palette === undefined ? [] : [paletteEntry(type, view)]
);

/** The step type's card tone; unknown/editor-only types fall back to `accent`. */
function toneOf(node: NodeOfKind<'flow'>): KindTone {
  return STEP_VIEWS[String(node.data.step.type)]?.tone ?? 'accent';
}

/** The `flow` kind's card + generic-JSON Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const FLOW_VIEW: KindView<'flow'> = {
  label: 'Flow step',
  tone: 'neutral',
  toneFor: toneOf,
  Icon: GitBranch,
  title,
  chip: (node) => node.data.step.id,
  rows,
  ports: { in: true, out: true },
  Fields: GenericFields,
  palette: PALETTE,
};
