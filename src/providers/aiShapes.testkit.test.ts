/**
 * The prompt normalization of aiShapes.testkit.ts, on hand-written v5+ prompts, so it
 * is checked on every install (the contract tests only exercise it on `ai` 5+).
 */

import { describe, expect, it } from 'vitest';
import { normalizeModernPrompt } from './aiShapes.testkit';

const bytes = new Uint8Array([1, 2, 3]);

describe('normalizeModernPrompt', () => {
  it('turns image file parts into v4 image parts, decoding base64 and URLs', () => {
    expect(
      normalizeModernPrompt([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: bytes } },
            { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'AQID' } },
            { type: 'file', mediaType: 'image', data: { type: 'url', url: 'https://example.com/a.png' } },
          ],
        },
      ])
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', image: bytes, mimeType: 'image/png' },
          { type: 'image', image: bytes, mimeType: 'image/jpeg' },
          { type: 'image', image: new URL('https://example.com/a.png') },
        ],
      },
    ]);
  });

  it('turns other file parts into v4 file parts with base64 data, and keeps strings and other parts', () => {
    expect(
      normalizeModernPrompt([
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'file', mediaType: 'application/pdf', filename: 'a.pdf', data: { type: 'data', data: bytes } }] },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 't', input: {} }] },
      ])
    ).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'file', mimeType: 'application/pdf', filename: 'a.pdf', data: 'AQID' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 't', input: {} }] },
    ]);
  });
});
