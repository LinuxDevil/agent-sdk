/**
 * `STEP_VIEWS` — the flow step-type table the card, the palette and the
 * Inspector share (C15/C25). Kept in its own module so `flowForm.tsx`'s
 * `flowNodeTitle` can read step labels without importing `flow.tsx`,
 * which imports `FlowStepFields` — importing it here would cycle.
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
import type { KindTone } from '../index';

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
