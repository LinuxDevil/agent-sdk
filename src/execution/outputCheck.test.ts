import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { createOutputCheck, type OutputChecks } from './outputCheck';

function run(checks: OutputChecks, execute: () => unknown = () => ({ path: 'a.txt' })) {
  const write = defineTool({ name: 'write_file', description: 'Write', input: z.object({ path: z.string() }), execute: async () => execute() });
  const agent = createAgent({
    provider: mockModel([{ toolCalls: [{ name: 'write_file', args: { path: 'a.txt' } }] }, 'done']),
    tools: [write],
    hooks: [createOutputCheck(checks)],
  });
  return agent.send('go').then((result) => String(result.messages.find((m) => m.role === 'tool')?.content));
}

describe('createOutputCheck', () => {
  it('tells the model when the check finds a problem', async () => {
    const content = await run({ write_file: () => 'a.txt is empty' });
    expect(content).toContain('a.txt is empty');
    expect(content).toContain('a.txt');
  });

  it('leaves the result alone when the check passes', async () => {
    expect(await run({ write_file: async () => undefined })).toBe(JSON.stringify({ path: 'a.txt' }));
  });

  it('passes the arguments and result to the check', async () => {
    let seen: unknown;
    await run({
      write_file: (args, result) => {
        seen = { args, result };
        return undefined;
      },
    });
    expect(seen).toEqual({ args: { path: 'a.txt' }, result: { path: 'a.txt' } });
  });

  it('does not check a call that failed', async () => {
    let checked = false;
    await run(
      {
        write_file: () => {
          checked = true;
          return undefined;
        },
      },
      () => {
        throw new Error('disk full');
      }
    );
    expect(checked).toBe(false);
  });

  it('reports a check that throws as a problem, without ending the run', async () => {
    const content = await run({
      write_file: () => {
        throw new Error('reader crashed');
      },
    });
    expect(content).toContain('reader crashed');
  });

  it('keeps a non-object result', async () => {
    const content = await run({ write_file: () => 'bad' }, () => 'wrote it');
    expect(content).toContain('wrote it');
    expect(content).toContain('bad');
  });
});
