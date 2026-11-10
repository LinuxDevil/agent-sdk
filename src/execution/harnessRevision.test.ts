import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { harnessHash } from '../improve/revisions';
import { harnessRevisionOf, sha256Hex } from './harnessRevision';

const nodeSha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ])('hashes %j to the published digest', (text, digest) => {
    expect(sha256Hex(text)).toBe(digest);
  });

  it('matches node:crypto across block boundaries and non-ASCII text', () => {
    for (const text of ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'naïve 漢字 🎉 \r\n', 'x'.repeat(100_003)]) {
      expect(sha256Hex(text)).toBe(nodeSha(text));
    }
  });
});

describe('harnessRevisionOf', () => {
  it('equals harnessHash for the same instructions and skills, in any order and with CRLF line ends', () => {
    const skills = [
      { name: 'b', description: 'B', content: 'do b\r\nthen stop' },
      { name: 'a', description: 'A', content: 'do a' },
    ];
    const id = harnessRevisionOf('Be careful.\r\n', skills);
    expect(id).toBe(harnessHash({ instructions: 'Be careful.\n', skills: { a: { description: 'A', content: 'do a' }, b: { description: 'B', content: 'do b\nthen stop' } } }));
    expect(harnessRevisionOf('Be careful.\n', [...skills].reverse())).toBe(id);
  });

  it('changes when a skill changes', () => {
    expect(harnessRevisionOf('x', [{ name: 'a', description: 'A', content: 'one' }])).not.toBe(harnessRevisionOf('x', [{ name: 'a', description: 'A', content: 'two' }]));
  });
});
