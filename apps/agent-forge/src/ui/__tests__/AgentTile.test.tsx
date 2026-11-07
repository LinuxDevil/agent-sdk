import { describe, expect, it } from 'vitest';
import { render } from './render';
import { AGENT_TILE_TONES, AgentTile, agentTone, hashAgentId } from '../AgentTile';

describe('AgentTile', () => {
  it('declares the eight tones in hash order', () => {
    expect(AGENT_TILE_TONES).toEqual(['accent', 'violet', 'info', 'danger', 'success', 'warning', 'chart-4', 'chart-2']);
  });

  it.each([
    ['e2e-agent', 98482544, 'accent'],
    ['pr-reviewer', 315054736, 'accent'],
    ['a', 97, 'violet'],
    ['b', 98, 'info'],
    ['docs-qa', 1828792034, 'info'],
    ['research-assistant', 1405939412, 'success'],
    ['inbox-triage', 1168484197, 'warning'],
    ['support-bot', 1852443959, 'chart-2'],
  ] as const)('hashAgentId("%s") is %i and its tone is "%s"', (id, hash, tone) => {
    expect(hashAgentId(id)).toBe(hash);
    expect(agentTone(id)).toBe(tone);
  });

  it('hashes the empty id to 0, which is the accent tone', () => {
    expect(hashAgentId('')).toBe(0);
    expect(agentTone('')).toBe('accent');
  });

  it('renders a large decorative tile with a 22px glyph', () => {
    const el = render(<AgentTile id="a" size="lg" />);
    const tile = el.querySelector('span.agent-tile.agent-tile-lg.agent-tone-violet')!;
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect(tile.querySelector('svg')?.getAttribute('width')).toBe('22');
  });

  it('muted greys the tile but keeps the tone class', () => {
    const el = render(<AgentTile id="a" muted />);
    const tile = el.querySelector('.agent-tile')!;
    expect(tile.classList.contains('agent-tile-muted')).toBe(true);
    expect(tile.classList.contains('agent-tone-violet')).toBe(true);
  });

  it('defaults to the md size with an 18px glyph', () => {
    const el = render(<AgentTile id="a" />);
    expect(el.querySelector('.agent-tile')!.classList.contains('agent-tile-md')).toBe(true);
    expect(el.querySelector('.agent-tile svg')?.getAttribute('width')).toBe('18');
  });
});
