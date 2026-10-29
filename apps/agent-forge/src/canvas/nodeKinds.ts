import { Flag, GitBranch, ShieldCheck, Sparkles, Wrench, Zap, type LucideIcon } from 'lucide-react';
import type { AgentGraphNodeType } from '../graph/types';

/** A kind tile's colour family: `kind-<tone>` in screens/agents/agents.css (also the MiniMap's node fill). */
export type KindTone = 'accent' | 'violet' | 'info' | 'warning' | 'success' | 'neutral';

/**
 * Each node kind's tone and lucide icon - the one map the canvas card
 * (AgentNode.tsx), the Nodes palette (LeftRail.tsx) and the Inspector header
 * draw their kind tile from, so the three never drift apart.
 */
export const NODE_KINDS: Record<AgentGraphNodeType, { tone: KindTone; Icon: LucideIcon }> = {
  trigger: { tone: 'accent', Icon: Zap },
  llm: { tone: 'violet', Icon: Sparkles },
  tool: { tone: 'info', Icon: Wrench },
  // The approval gate is the canvas's "hook" kind: warning, like a pause.
  approval: { tone: 'warning', Icon: ShieldCheck },
  output: { tone: 'success', Icon: Flag },
  // Router is neutral control flow.
  router: { tone: 'neutral', Icon: GitBranch },
};
