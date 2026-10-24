import { describe, expect, it } from 'vitest';

import { formatTracesQuery, parseTracesQuery, rememberListQuery, toTraceFilter, tracesListPath } from '../tracesUrl';

const parse = (qs: string) => parseTracesQuery(new URLSearchParams(qs));

describe('tracesUrl', () => {
  it('round-trips every key in a stable order', () => {
    const qs = '?agent=a1&status=error&model=m&project=p&q=refund&prompt=mira%402&from=10&to=20&sort=cost&order=asc&offset=50';
    expect(formatTracesQuery(parse(qs.slice(1)))).toBe(qs);
  });

  it('leaves the defaults out, so a default state is a bare #/traces', () => {
    expect(formatTracesQuery({ offset: 0 })).toBe('');
    expect(formatTracesQuery({ offset: 0, sort: { key: 'start', order: 'desc' } })).toBe('');
  });

  it('drops malformed values instead of sending them to the daemon', () => {
    const state = parse('from=20&to=10&sort=nope&offset=-5&status=');
    expect(state).toEqual({ offset: 0, window: undefined, sort: undefined });
    expect(parse('sort=tokens&order=sideways').sort).toEqual({ key: 'tokens', order: 'desc' });
  });

  it('resolves the default rolling 24h window against now', () => {
    const filter = toTraceFilter({ offset: 0 }, 100_000_000);
    expect(filter).toMatchObject({ from: 100_000_000 - 86_400_000, to: 100_000_000, limit: 50, offset: 0 });
    expect(toTraceFilter(parse('from=1&to=2&agent=x'), 5)).toMatchObject({ from: 1, to: 2, agent_id: 'x' });
    expect(toTraceFilter(parse('prompt=mira@2'), 5)).toMatchObject({ prompt: 'mira@2' });
  });

  it("remembers the list's last query for the trace screen's way back", () => {
    rememberListQuery('?status=error');
    expect(tracesListPath()).toBe('/traces?status=error');
    rememberListQuery('');
    expect(tracesListPath()).toBe('/traces');
  });
});
