import { describe, it, expect, vi } from 'vitest';
import { runFixer, extractDiffBlock, EmptyPatchError, FixRequest, createFixerDelegateTool } from './fixer';
import { LLMProvider, GenerateResult } from '../../src/providers';

function makeScriptedProvider(text: string): LLMProvider {
  const result: GenerateResult = {
    text,
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
  };
  return {
    name: 'mock',
    generate: vi.fn().mockResolvedValue(result),
    stream: vi.fn() as any,
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => [],
  };
}

const request: FixRequest = {
  errorSignature: 'sig-1',
  logs: 'NullPointerException at OrderService.java:42',
  files: ['src/OrderService.java'],
};

const FENCED_DIFF_RESPONSE = [
  'Here is the fix:',
  '',
  '```diff',
  '--- a/src/OrderService.java',
  '+++ b/src/OrderService.java',
  '@@ -40,3 +40,3 @@',
  '-  charge(null);',
  '+  charge(order);',
  '```',
].join('\n');

describe('extractDiffBlock', () => {
  it('extracts a fenced ```diff block', () => {
    const patch = extractDiffBlock(FENCED_DIFF_RESPONSE);
    expect(patch).toContain('--- a/src/OrderService.java');
    expect(patch).toContain('+  charge(order);');
  });

  it('extracts a diff-looking plain fenced block', () => {
    const text = ['```', '--- a/foo.txt', '+++ b/foo.txt', '@@ -1 +1 @@', '-old', '+new', '```'].join(
      '\n'
    );
    expect(extractDiffBlock(text)).toContain('+new');
  });

  it('falls back to scanning for unified-diff markers with no fencing', () => {
    const text = ['I fixed it.', '--- a/foo.txt', '+++ b/foo.txt', '@@ -1 +1 @@', '-old', '+new'].join(
      '\n'
    );
    expect(extractDiffBlock(text)).toContain('+new');
  });

  it('returns an empty string when nothing diff-shaped is present', () => {
    expect(extractDiffBlock('I could not find a fix.')).toBe('');
  });
});

describe('runFixer', () => {
  it('with a deterministic mock provider scripted to return a fenced diff, returns a non-empty patch referencing the expected file', async () => {
    const provider = makeScriptedProvider(FENCED_DIFF_RESPONSE);

    const { patch } = await runFixer(request, provider);

    expect(patch.length).toBeGreaterThan(0);
    expect(patch).toContain('src/OrderService.java');
  });

  it('throws EmptyPatchError when the fixer response has no extractable diff', async () => {
    const provider = makeScriptedProvider('I am not sure how to fix this.');

    await expect(runFixer(request, provider)).rejects.toBeInstanceOf(EmptyPatchError);
  });
});

describe('createFixerDelegateTool', () => {
  it('delegates to the fixer agent and extracts a patch from its response', async () => {
    const provider = makeScriptedProvider(FENCED_DIFF_RESPONSE);
    const fixerAgent = { name: 'fixer', prompt: 'fix it' };

    const delegateTool = createFixerDelegateTool({ agent: fixerAgent, provider });
    const result: any = await delegateTool.tool.execute!({ task: 'fix sig-1' }, {} as any);

    expect(result.patch).toContain('src/OrderService.java');
  });

  it('throws EmptyPatchError when the delegated fixer agent has no extractable diff', async () => {
    const provider = makeScriptedProvider('I am not sure how to fix this.');
    const fixerAgent = { name: 'fixer', prompt: 'fix it' };

    const delegateTool = createFixerDelegateTool({ agent: fixerAgent, provider });
    await expect(delegateTool.tool.execute!({ task: 'fix sig-1' }, {} as any)).rejects.toBeInstanceOf(
      EmptyPatchError
    );
  });
});
