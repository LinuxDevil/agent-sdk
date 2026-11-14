import { describe, expect, it } from 'vitest';

import { createSseParser, type SseFrame } from '../sseFrames';

const FIXTURE = [
  'event: message',
  'data: {"type":"text.delta","text":"Hi"}',
  '',
  'data: {"type":"tool.start","toolCallId":"t1","toolName":"search","args":{}}',
  'data: continued',
  '',
  ': a comment',
  'event: done',
  'data: {}',
  '',
].join('\n');

function parseAll(chunks: string[]): SseFrame[] {
  const parser = createSseParser();
  const frames: SseFrame[] = [];
  for (const chunk of chunks) frames.push(...parser.push(chunk));
  frames.push(...parser.flush());
  return frames;
}

describe('createSseParser', () => {
  it('returns the same frames for every chunking of the fixture', () => {
    const expected = parseAll([FIXTURE]);
    expect(expected).toEqual([
      { event: 'message', data: '{"type":"text.delta","text":"Hi"}' },
      { event: 'message', data: '{"type":"tool.start","toolCallId":"t1","toolName":"search","args":{}}\ncontinued' },
      { event: 'done', data: '{}' },
    ]);
    for (let i = 0; i <= FIXTURE.length; i++) {
      expect(parseAll([FIXTURE.slice(0, i), FIXTURE.slice(i)])).toEqual(expected);
    }
  });

  it('handles CRLF line endings', () => {
    const crlf = FIXTURE.replace(/\n/g, '\r\n');
    expect(parseAll([crlf])).toEqual(parseAll([FIXTURE]));
  });

  it('handles a CRLF split across chunks', () => {
    const frames = parseAll(['data: a\r', '\ndata: b\n\n']);
    expect(frames).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('ignores comment lines and keeps the frame open', () => {
    const frames = parseAll([': ping\n\ndata: x\n\n']);
    expect(frames).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('joins multi-line data with a newline', () => {
    const frames = parseAll(['data: one\ndata: two\ndata: three\n\n']);
    expect(frames).toEqual([{ event: 'message', data: 'one\ntwo\nthree' }]);
  });

  it('strips a single leading space after the colon', () => {
    const frames = parseAll(['data:no-space\ndata:  two-spaces\n\n']);
    expect(frames[0]!.data).toBe('no-space\n two-spaces');
  });

  it('flushes a trailing frame without a final blank line', () => {
    expect(parseAll(['data: tail\n\ndata: last'])).toEqual([
      { event: 'message', data: 'tail' },
      { event: 'message', data: 'last' },
    ]);
  });

  it('does not dispatch frames that carry no event or data', () => {
    expect(parseAll(['id: 1\nretry: 100\n\n'])).toEqual([]);
  });
});
