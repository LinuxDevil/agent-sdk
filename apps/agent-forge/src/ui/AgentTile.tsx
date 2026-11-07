import { Bot } from 'lucide-react';

import './agentTile.css';

/** The eight tile tones, in hash order. Each maps to Forge tokens in agentTile.css. */
export const AGENT_TILE_TONES = ['accent', 'violet', 'info', 'danger', 'success', 'warning', 'chart-4', 'chart-2'] as const;

/** One entry of {@link AGENT_TILE_TONES}: the colour a tile can take. */
export type AgentTileTone = (typeof AGENT_TILE_TONES)[number];

/**
 * Java-style string hash (h = h*31 + charCode, 32-bit), absolute value.
 * Kept identical to Wakeel's `agentAccent` hash so an agent's colour
 * survives ports and renames.
 */
export function hashAgentId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** The tone for an agent id: `AGENT_TILE_TONES[hashAgentId(id) % 8]`. */
export function agentTone(id: string): AgentTileTone {
  return AGENT_TILE_TONES[hashAgentId(id) % AGENT_TILE_TONES.length];
}

const GLYPH_SIZE = { sm: 16, md: 18, lg: 22 } as const;

/** Props for {@link AgentTile}. */
export interface AgentTileProps {
  /** The agent id (not the display name: renames keep the colour). */
  id: string;
  /** Tile edge: `sm` 28px, `md` 36px (default), `lg` 44px. */
  size?: 'sm' | 'md' | 'lg';
  /** A disabled agent: grey tile, faint glyph. */
  muted?: boolean;
  className?: string;
}

/**
 * A rounded tile with a Bot glyph whose colour is picked by hashing the
 * agent id, so an agent keeps the same colour on the list, the detail
 * header, the inbox and the Author cards. The tile is decorative
 * (`aria-hidden`): the agent name next to it names the row. Wrap the
 * containing card or row in `.agent-tile-host` to get the tinted hover ring.
 */
export function AgentTile({ id, size = 'md', muted = false, className }: AgentTileProps) {
  const classes = ['agent-tile', `agent-tile-${size}`, `agent-tone-${agentTone(id)}`];
  if (muted) classes.push('agent-tile-muted');
  if (className) classes.push(className);
  return (
    <span className={classes.join(' ')} aria-hidden="true">
      <Bot size={GLYPH_SIZE[size]} strokeWidth={1.75} aria-hidden="true" />
    </span>
  );
}
