/**
 * N8: openApiTools() against a local node:http server (127.0.0.1) and a
 * hand-written petstore document. Fully offline.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ZodTypeAny } from 'zod';
import petstore from './__fixtures__/petstore.json';
import { openApiTools, type OpenApiToolsOptions } from './openApiTools';
import { createAgent } from '../../createAgent';
import { mockModel } from '../../testing';
import type { AgentEvent } from '../../execution/agentEvents';
import type { DefinedTool } from '../defineTool';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let base: string;
let seen: Seen[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const url = req.url ?? '';
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (url.startsWith('/v1/slow')) return; // never answers
      if (url.startsWith('/v1/big')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return void res.end('x'.repeat(500));
      }
      if (url.startsWith('/v1/text')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return void res.end('plain words');
      }
      if (url.startsWith('/v1/redirect-same')) {
        res.writeHead(302, { location: '/v1/pets/redirected' });
        return void res.end();
      }
      if (url.startsWith('/v1/redirect-cross')) {
        res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/v1/pets/leaked` });
        return void res.end();
      }
      if (url.startsWith('/v1/missing')) return json(404, { error: 'no such thing' });
      if (req.method === 'POST') return json(201, { created: true, received: body ? JSON.parse(body) : null });
      if (req.method === 'DELETE') {
        res.writeHead(204);
        return void res.end();
      }
      json(200, { url });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  seen = [];
});

const ctx = { toolCallId: 'call_1', messages: [] };

async function tools(options: OpenApiToolsOptions = {}, document: object | string | URL = petstore): Promise<Record<string, DefinedTool>> {
  const list = await openApiTools(document, { baseUrl: base, ...options });
  return Object.fromEntries(list.map((tool) => [tool.name, tool]));
}

function extraPaths(paths: Record<string, unknown>): object {
  return { ...petstore, paths: { ...petstore.paths, ...paths } };
}

const getOp = (operationId: string) => ({ get: { operationId, responses: {} } });
const parse = (tool: DefinedTool, value: unknown) => (tool.input as unknown as ZodTypeAny).safeParse(value);

describe('names, descriptions, selection', () => {
  it('makes one tool per supported operation, named from operationId or method and path', async () => {
    const all = await tools();
    expect(Object.keys(all).sort()).toEqual(['createPet', 'deletePet', 'getPet', 'listPets', 'put_pets_petId']);
  });

  it('describes a tool with its summary, description and method and path', async () => {
    const all = await tools();
    expect(all.listPets.description).toBe('List pets\n\nReturns pets, newest first.\n\nGET /pets');
    expect(all.getPet.description).toBe('Get one pet\n\nGET /pets/{petId}');
  });

  it('cuts a long description at 1000 characters and keeps the method and path', async () => {
    const long = extraPaths({ '/long': { get: { operationId: 'longOne', description: 'd'.repeat(3000) } } });
    const all = await tools({}, long);
    expect(all.longOne.description.length).toBeLessThan(1100);
    expect(all.longOne.description.endsWith('GET /long')).toBe(true);
  });

  it('include takes operationIds, derived names or a predicate; exclude removes', async () => {
    expect(Object.keys(await tools({ include: ['getPet', 'put_pets_petId'] })).sort()).toEqual(['getPet', 'put_pets_petId']);
    expect(Object.keys(await tools({ include: (op) => op.tags.includes('pets') && op.method === 'GET' })).sort()).toEqual(['getPet', 'listPets']);
    expect(Object.keys(await tools({ exclude: ['deletePet', 'createPet'] })).sort()).toEqual(['getPet', 'listPets', 'put_pets_petId']);
  });

  it('refuses an include that names no operation, and an operation it cannot turn into a tool', async () => {
    await expect(tools({ include: ['getPett'] })).rejects.toThrow(/getPett/);
    await expect(tools({ include: ['uploadPhoto'] })).rejects.toThrow(/multipart/);
  });

  it('prefixes names and keeps them within 64 characters', async () => {
    const all = await tools({ prefix: 'pets', include: ['getPet'] });
    expect(Object.keys(all)).toEqual(['pets__getPet']);
    const long = extraPaths({ '/l': getOp('a'.repeat(80)) });
    for (const name of Object.keys(await tools({ prefix: 'p' }, long))) expect(name.length).toBeLessThanOrEqual(64);
  });

  it('lists both operations when two produce the same name', async () => {
    const dup = extraPaths({ '/a': getOp('same'), '/b': getOp('same') });
    await expect(tools({}, dup)).rejects.toThrow(/'same'.*GET \/a.*GET \/b/);
  });
});

describe('input schema', () => {
  it('has path, query and header parameters and the body as top-level properties', async () => {
    const all = await tools();
    expect(parse(all.getPet, { petId: 'p1', 'X-Tenant': 't' }).success).toBe(true);
    expect(parse(all.getPet, { 'X-Tenant': 't' }).success).toBe(false); // path parameter required (via $ref)
    expect(parse(all.getPet, { petId: 'p1' }).success).toBe(false); // required header parameter
    expect(parse(all.listPets, { limit: 500 }).success).toBe(false);
    expect(parse(all.listPets, {}).success).toBe(true);
    expect(parse(all.listPets, { tag: ['a', 'b'] }).success).toBe(true);
  });

  it('resolves the body through $ref, including a $ref request body, and normalizes nullable', async () => {
    const all = await tools();
    expect(parse(all.createPet, {}).success).toBe(false);
    expect(parse(all.createPet, { body: { kind: 'dog' } }).success).toBe(false);
    expect(parse(all.createPet, { body: { name: 'Rex', kind: 'cat', nickname: null, owner: { email: 'a@b.c' } } }).success).toBe(true);
    expect(parse(all.createPet, { body: { name: 'Rex', kind: 'fish' } }).success).toBe(false);
    expect(parse(all.put_pets_petId, { petId: 'p', body: { name: 'x' } }).success).toBe(true);
    expect(parse(all.put_pets_petId, { petId: 'p' }).success).toBe(false);
  });

  it('refuses Swagger 2.0, an unknown version and a remote $ref', async () => {
    await expect(openApiTools({ swagger: '2.0', paths: {} }, { baseUrl: base })).rejects.toThrow(/Swagger 2\.0.*Convert/);
    await expect(openApiTools({ openapi: '4.0.0', paths: {} }, { baseUrl: base })).rejects.toThrow(/version/);
    const remote = extraPaths({ '/r': { get: { operationId: 'r', parameters: [{ $ref: 'other.yaml#/p' }] } } });
    await expect(tools({}, remote)).rejects.toThrow(/remote \$ref/);
  });

  it('lets an operation-level parameter override a path-level one of the same name and location', async () => {
    const doc = extraPaths({
      '/o/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { operationId: 'override', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] },
      },
    });
    const all = await tools({}, doc);
    expect(parse(all.override, { id: 5 }).success).toBe(true);
    expect(parse(all.override, { id: 'five' }).success).toBe(false);
  });
});

describe('approval and annotations', () => {
  it('defaults to asking for every method except GET, HEAD and OPTIONS', async () => {
    const all = await tools();
    expect(all.listPets.needsApproval).toBe(false);
    expect(all.getPet.needsApproval).toBe(false);
    expect(all.createPet.needsApproval).toBe(true);
    expect(all.deletePet.needsApproval).toBe(true);
    expect(all.put_pets_petId.needsApproval).toBe(true);
  });

  it("supports 'always', 'never' and a predicate", async () => {
    expect((await tools({ approval: 'always' })).listPets.needsApproval).toBe(true);
    expect((await tools({ approval: 'never' })).deletePet.needsApproval).toBe(false);
    const some = await tools({ approval: (op) => op.operationId === 'getPet' });
    expect(some.getPet.needsApproval).toBe(true);
    expect(some.createPet.needsApproval).toBe(false);
  });

  it('sets read-only and destructive annotations', async () => {
    const all = await tools({ approval: 'never' });
    const annotations = (tool: DefinedTool) => (tool.metadata as { mcp: { annotations: unknown } }).mcp.annotations;
    expect(annotations(all.getPet)).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(annotations(all.createPet)).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(annotations(all.deletePet)).toEqual({ readOnlyHint: false, destructiveHint: true });
  });
});

describe('requests', () => {
  it('puts path, query, header and body values on the wire', async () => {
    const all = await tools();
    const result = await all.getPet.execute({ petId: 'p 1', 'X-Tenant': 'acme' }, ctx);
    expect(result).toEqual({ status: 200, statusText: 'OK', body: { url: '/v1/pets/p%201' } });
    expect(seen[0].headers['x-tenant']).toBe('acme');

    await all.listPets.execute({ limit: 5, tag: ['a', 'b'], 'X-Request-Source': 'agent' }, ctx);
    expect(seen[1].url).toBe('/v1/pets?limit=5&tag=a&tag=b');
    expect(seen[1].headers['x-request-source']).toBe('agent');

    const created = await all.createPet.execute({ body: { name: 'Rex' } }, ctx);
    expect(seen[2]).toMatchObject({ method: 'POST', url: '/v1/pets', body: '{"name":"Rex"}' });
    expect(seen[2].headers['content-type']).toBe('application/json');
    expect(created).toMatchObject({ status: 201, body: { created: true, received: { name: 'Rex' } } });
  });

  it('keeps path traversal inside the path segment', async () => {
    const all = await tools();
    await all.deletePet.execute({ petId: '../admin?x=1#y' }, ctx);
    expect(seen[0].url).toBe('/v1/pets/..%2Fadmin%3Fx%3D1%23y');
    await expect(all.getPet.execute({ petId: '..', 'X-Tenant': 't' }, ctx)).rejects.toThrow(/cannot be/);
    expect(seen).toHaveLength(1);
  });

  it('removes providedArguments from the schema and sends them', async () => {
    const provided = vi.fn(({ op, toolCallId }: { op: { name: string }; toolCallId: string }) => `${op.name}:${toolCallId}`);
    const all = await tools({ providedArguments: { 'X-Tenant': provided } });
    expect(parse(all.getPet, { petId: 'p1' }).success).toBe(true); // required header no longer asked of the model
    await all.getPet.execute({ petId: 'p1', 'X-Tenant': 'model-tried' }, ctx);
    expect(seen[0].headers['x-tenant']).toBe('getPet:call_1');
    expect(Object.keys((all.getPet.input as unknown as { shape: object }).shape)).toEqual(['petId']);
  });

  it('rejects a providedArguments key no selected operation has', async () => {
    await expect(tools({ providedArguments: { tenant: 'x' } })).rejects.toThrow(/'tenant'/);
  });

  it('sends configured headers and the bearer token last, so the model cannot override them', async () => {
    const all = await tools({
      headers: (op) => ({ 'x-op': op.name, 'X-Tenant': 'configured' }),
      bearerToken: async () => 'secret-token',
    });
    await all.getPet.execute({ petId: 'p', 'X-Tenant': 'model', Authorization: 'Bearer evil' }, ctx);
    expect(seen[0].headers.authorization).toBe('Bearer secret-token');
    expect(seen[0].headers['x-op']).toBe('getPet');
    expect(seen[0].headers['x-tenant']).toBe('configured');
  });
});

describe('responses', () => {
  const doc = () => extraPaths({ '/missing': getOp('missing'), '/text': getOp('text'), '/big': getOp('big'), '/slow': getOp('slow') });

  it('returns status and body for every HTTP response, including errors', async () => {
    const all = await tools({}, doc());
    expect(await all.missing.execute({}, ctx)).toEqual({ status: 404, statusText: 'Not Found', body: { error: 'no such thing' } });
    expect(await all.text.execute({}, ctx)).toMatchObject({ status: 200, body: 'plain words' });
    expect(await (await tools()).deletePet.execute({ petId: 'p' }, ctx)).toEqual({ status: 204, statusText: 'No Content', body: null });
  });

  it('caps the body and says so', async () => {
    const all = await tools({ maxResponseChars: 100 }, doc());
    const result = (await all.big.execute({}, ctx)) as { body: string };
    expect(result.body.startsWith('x'.repeat(100))).toBe(true);
    expect(result.body).toContain('400 more characters');
  });

  it('turns a timeout and a refused connection into errors', async () => {
    const all = await tools({ timeoutMs: 100 }, doc());
    await expect(all.slow.execute({}, ctx)).rejects.toThrow(/timed out after 100 ms/);
    const dead = await tools({ baseUrl: 'http://127.0.0.1:1/v1' });
    await expect(dead.listPets.execute({}, ctx)).rejects.toThrow(/GET \/pets failed/);
  });

  it('follows a same-origin redirect and refuses a cross-origin one', async () => {
    const all = await tools({}, extraPaths({ '/redirect-same': getOp('same'), '/redirect-cross': getOp('cross') }));
    expect(await all.same.execute({}, ctx)).toMatchObject({ status: 200, body: { url: '/v1/pets/redirected' } });
    await expect(all.cross.execute({}, ctx)).rejects.toThrow(/not the configured origin/);
    expect(seen.some((s) => s.url.includes('leaked'))).toBe(false);
  });

  it('does not send the bearer token to another origin', async () => {
    const all = await tools({ bearerToken: 'secret-token' }, extraPaths({ '/redirect-cross': getOp('cross') }));
    await expect(all.cross.execute({}, ctx)).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe('base URL and document sources', () => {
  it('requires https except for loopback hosts', async () => {
    await expect(openApiTools(petstore, { baseUrl: 'http://api.example.com/v1' })).rejects.toThrow(/https/);
    await expect(openApiTools(petstore, { baseUrl: 'https://user:pw@api.example.com' })).rejects.toThrow(/user name/);
    await expect(openApiTools(petstore, { baseUrl: 'http://localhost:3000' })).resolves.toBeDefined();
    await expect(openApiTools(petstore, { baseUrl: 'http://[::1]:3000' })).resolves.toBeDefined();
    await expect(openApiTools(petstore, { baseUrl: base })).resolves.toBeDefined();
  });

  it("uses the document's first server when baseUrl is not given, and needs one", async () => {
    const recorder = (async (url: string) => {
      seen.push({ method: 'GET', url, headers: {}, body: '' });
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const all = await openApiTools(petstore, { fetch: recorder });
    await all.find((t) => t.name === 'listPets')!.execute({}, ctx);
    expect(seen[0].url).toBe('https://petstore.example.com/v1/pets');
    await expect(openApiTools({ openapi: '3.1.0', paths: {} })).rejects.toThrow(/baseUrl/);
  });

  it('reads a YAML string and a JSON string', async () => {
    const yaml = `openapi: 3.1.0\ninfo: {title: t, version: '1'}\npaths:\n  /ping:\n    get:\n      operationId: ping\n      summary: Ping\n`;
    const all = await tools({}, yaml);
    expect(Object.keys(all)).toEqual(['ping']);
    expect(await all.ping.execute({}, ctx)).toMatchObject({ status: 200, body: { url: '/v1/ping' } });
    expect(Object.keys(await tools({}, JSON.stringify(petstore)))).toContain('getPet');
  });

  it('fetches a document URL with the injected fetch, and refuses http', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(petstore), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const list = await openApiTools('https://specs.example.com/petstore/openapi.json', { baseUrl: base, fetch: fakeFetch });
    expect(calls).toEqual(['https://specs.example.com/petstore/openapi.json']);
    expect(list.map((t) => t.name)).toContain('listPets');
    expect((await openApiTools(new URL('https://specs.example.com/x.json'), { baseUrl: base, fetch: fakeFetch })).length).toBeGreaterThan(0);
    await expect(openApiTools('http://specs.example.com/openapi.json', { fetch: fakeFetch })).rejects.toThrow(/https/);
  });

  it('turns a failing document fetch into a configuration error', async () => {
    const notFound = (async () => new Response('nope', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;
    await expect(openApiTools('https://specs.example.com/x.json', { baseUrl: base, fetch: notFound })).rejects.toThrow(/HTTP 404/);
  });
});

describe('with an agent', () => {
  it('runs a GET straight away; a POST pauses for approval and runs after approving; secrets stay out of events and the transcript', async () => {
    const events: AgentEvent[] = [];
    const list = await openApiTools(petstore, { baseUrl: base, bearerToken: 'secret-token', headers: { 'x-api-key': 'key-123' } });
    const agent = createAgent({
      provider: mockModel([
        { toolCalls: [{ name: 'getPet', args: { petId: 'p1', 'X-Tenant': 'acme' }, id: 'call_get' }] },
        { toolCalls: [{ name: 'createPet', args: { body: { name: 'Rex' } }, id: 'call_post' }] },
        'Done.',
      ]),
      tools: list,
      onEvent: (event) => events.push(event),
    });

    const paused = await agent.send('Fetch p1, then add Rex');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /v1/pets/p1']);

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.finishReason).toBe('stop');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /v1/pets/p1', 'POST /v1/pets']);
    expect(seen[1].headers.authorization).toBe('Bearer secret-token');

    const visible = JSON.stringify([events.filter((e) => e.type.startsWith('tool.')), result.messages]);
    expect(visible).not.toContain('secret-token');
    expect(visible).not.toContain('key-123');
    expect(visible).toContain('"created":true');
  });
});
