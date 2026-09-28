import { describe, it, expect, vi } from 'vitest';
import { loadMcpTools } from './McpToolLoader';
import { createConnectedClient } from './McpToolLoader.test';

describe('loadMcpTools', () => {
  it('synthesizes exactly 2 ToolDescriptors named <connectionName>__<toolName>', async () => {
    const { client } = await createConnectedClient();
    const descriptors = await loadMcpTools(client, 'myconn');

    expect(Object.keys(descriptors).sort()).toEqual(['myconn__add', 'myconn__search']);
    expect(descriptors['myconn__add'].tool).toBeDefined();
    expect(descriptors['myconn__search'].tool).toBeDefined();
  });

  it("calling a synthesized descriptor's execute invokes client.callTool with correct name/args and surfaces the return value", async () => {
    const { client } = await createConnectedClient();
    const callToolSpy = vi.spyOn(client, 'callTool');

    const descriptors = await loadMcpTools(client, 'myconn');
    const result = await descriptors['myconn__add'].tool.execute!({ a: 2, b: 3 }, {} as any);

    expect(callToolSpy).toHaveBeenCalledWith({ name: 'add', arguments: { a: 2, b: 3 } });
    expect(result).toMatchObject({ content: [{ type: 'text', text: '5' }] });
  });

  it('produces distinctly-named descriptors with zero collision across two connections exposing a tool of the same name', async () => {
    const { client: linearClient } = await createConnectedClient();
    const { client: githubClient } = await createConnectedClient();

    const linearDescriptors = await loadMcpTools(linearClient, 'linear');
    const githubDescriptors = await loadMcpTools(githubClient, 'github');

    expect(linearDescriptors['linear__search']).toBeDefined();
    expect(githubDescriptors['github__search']).toBeDefined();
    expect(linearDescriptors['github__search']).toBeUndefined();
    expect(githubDescriptors['linear__search']).toBeUndefined();
  });
});
