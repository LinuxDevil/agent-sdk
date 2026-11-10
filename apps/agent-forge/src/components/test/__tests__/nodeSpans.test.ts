import { describe, expect, it } from 'vitest';
import { spansForNode } from '../nodeSpans';
import type { SpanEvent } from '../../../../shared/wireTypes';

let seq = 0;
function span(id: string, nodeId: string | undefined, parentId?: string): SpanEvent {
  seq += 1;
  return {
    id,
    name: id,
    parentId,
    startTime: seq,
    attributes: nodeId === undefined ? {} : { 'lousho.node.id': nodeId },
  };
}

describe('spansForNode', () => {
  it('returns the spans stamped with the exact node id', () => {
    const spans = [
      span('s1', 'tool:http'),
      span('s2', 'tool:http'),
      span('s3', 'tool:web_fetch'),
      span('s4', undefined),
    ];
    expect(spansForNode(spans, 'tool:http').map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('includes a subagent node’s children (the `${nodeId}/` prefix) but not siblings', () => {
    const spans = [
      span('root', 'sub:research'),
      span('child', 'sub:research/tool:web_fetch', 'root'),
      span('grandchild', 'sub:research/tool:web_fetch/inner', 'child'),
      span('sibling', 'sub:billing'),
      // `sub:research-2` shares the string prefix but not the path prefix.
      span('other', 'sub:research-2/tool:x'),
    ];
    const matched = spansForNode(spans, 'sub:research');
    expect(matched.map((s) => s.id)).toEqual(['root', 'child', 'grandchild']);
  });

  it('excludes spans with no stamped node id or a non-string one', () => {
    const unstamped: SpanEvent = { id: 'u', name: 'u', startTime: 1, attributes: {} };
    const nonString: SpanEvent = {
      id: 'n',
      name: 'n',
      startTime: 2,
      attributes: { 'lousho.node.id': 42 },
    };
    expect(spansForNode([unstamped, nonString], 'agent')).toEqual([]);
  });

  it('cuts parentId when the parent span is filtered out, so the span becomes a root', () => {
    const parent = span('sub-root', 'sub:research');
    const child = span('child', 'sub:research/tool:web_fetch', 'sub-root');
    // Asking for the child path alone leaves its parent outside the set.
    const [matched] = spansForNode([parent, child], 'sub:research/tool:web_fetch');
    expect(matched.id).toBe('child');
    expect(matched.parentId).toBeUndefined();
    // The original span is not mutated.
    expect(child.parentId).toBe('sub-root');
  });

  it('keeps parentId when the parent is also matched', () => {
    const parent = span('sub-root', 'sub:research');
    const child = span('child', 'sub:research/tool:web_fetch', 'sub-root');
    const matched = spansForNode([parent, child], 'sub:research');
    expect(matched.find((s) => s.id === 'child')?.parentId).toBe('sub-root');
  });
});
