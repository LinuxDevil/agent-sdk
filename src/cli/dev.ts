/**
 * `loushy dev` - a local dev server for iterating on an agent (LOU-H6).
 *
 * Serves:
 *   GET  /health  -> 200 'ok'
 *   POST /chat    -> { message } in, the agent's real ExecutionResult out
 *
 * Config loading: configPath is a small JSON file
 * { name, prompt, provider: { type, model }, tools?: string[] } describing
 * the agent to run. This is intentionally the simplest thing that works -
 * LOU-H9 (declarative agent spec files, .yaml/.json + zod validation) is
 * the natural, designed-for successor to this format; dev.ts is retrofitted
 * to load configs via loadSpec()+specToAgent() once LOU-H9 lands (see that
 * commit).
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAgent, SimpleAgent, CreateAgentConfig } from '../createAgent';
import { resolveProvider } from '../providers/resolveProvider';
import { LLMProvider, LLMProviderRegistry } from '../providers/llm';
import { httpTool } from '../tools/built-in/http';
import { ToolDescriptor } from '../types';

const REAL_PROVIDER_TYPES = new Set(['openai', 'anthropic', 'ollama', 'openrouter']);

/**
 * Resolves a dev-server provider config to an LLMProvider. Real provider
 * types go through LOU-F8's resolveProvider() (env-var driven credentials,
 * as usual). Any other registered type - notably 'mock', which
 * intentionally has no env var and is never part of resolveProvider()'s
 * whitelist - is created directly via LLMProviderRegistry, which is how
 * tests run the dev server end-to-end against a MockLLMProvider without
 * needing real API credentials.
 */
function resolveDevProvider(type: string, model: string): LLMProvider {
  if (REAL_PROVIDER_TYPES.has(type.toLowerCase())) {
    return resolveProvider(`${type}/${model}`);
  }
  return LLMProviderRegistry.create(type, { defaultModel: model });
}

export interface DevAgentConfig {
  name?: string;
  prompt: string;
  provider: { type: string; model: string };
  tools?: string[];
}

const BUILT_IN_TOOLS: Record<string, ToolDescriptor> = {
  http: httpTool,
};

/** Loads a DevAgentConfig JSON file, guarding the fields configToAgent() needs. */
export function loadDevConfig(configPath: string): DevAgentConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw) as DevAgentConfig;

  if (!config.prompt) {
    throw new Error(`loadDevConfig: '${configPath}' is missing required field 'prompt'`);
  }
  if (!config.provider || !config.provider.type) {
    throw new Error(`loadDevConfig: '${configPath}' is missing required field 'provider.type'`);
  }

  return config;
}

export function configToAgent(config: DevAgentConfig): SimpleAgent {
  const provider = resolveDevProvider(config.provider.type, config.provider.model);

  const tools: CreateAgentConfig['tools'] = {};
  for (const toolName of config.tools || []) {
    const tool = BUILT_IN_TOOLS[toolName];
    if (tool) {
      tools[toolName] = tool;
    }
  }

  return createAgent({
    name: config.name,
    prompt: config.prompt,
    provider,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
  });
}

function loadAgentFromConfig(configPath: string): SimpleAgent {
  return configToAgent(loadDevConfig(configPath));
}

export interface DevServerHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function serveChatUi(res: http.ServerResponse): void {
  const uiPath = path.join(__dirname, 'dev-ui', 'index.html');
  const html = fs.readFileSync(uiPath, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agent: SimpleAgent
): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    try {
      serveChatUi(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('dev UI not found');
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/chat') {
    try {
      const body = await readBody(req);
      const { message } = JSON.parse(body || '{}');
      if (typeof message !== 'string' || !message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Request body must be JSON with a 'message' string" }));
        return;
      }

      const result = await agent.send(message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

/**
 * Starts the dev server, binding to `port` (checked for availability up
 * front - EADDRINUSE is caught and rejected with a clear, port-naming
 * error rather than crashing uncaught).
 */
export async function startDevServer(
  configPath: string,
  port = 3737
): Promise<DevServerHandle> {
  const agent = loadAgentFromConfig(configPath);

  const server = http.createServer((req, res) => {
    handleRequest(req, res, agent).catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[loushy dev] unhandled request error:', error);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`[loushy dev] port ${port} is already in use. Pass a different port.`));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });

  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
