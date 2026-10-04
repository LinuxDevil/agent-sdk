/**
 * Worker-safe stand-in for every `@modelcontextprotocol/sdk` specifier the
 * `@lousho/build-ai-agent/worker` entry reaches (#289).
 *
 * `createAgent({ mcpServers })` lazy-imports the optional MCP peer through
 * tools/mcp/connect.ts (client/index.js, client/stdio.js,
 * client/streamableHttp.js) and tools/mcp/mcpOAuth.ts (client/auth.js). The
 * generated Worker can leave those specifiers external - the generated app's
 * own bundling stage resolves them when the operator installs the peer - but
 * the published /worker entry is bundled by the user's build directly, where
 * an unresolved specifier fails the build and a resolved one lands ~700 KB of
 * MCP SDK + ajv in every Worker. The entry's build (workerEntryPlugins in
 * ../bundle.ts) therefore points all MCP specifiers here: `mcpServers` fails
 * on first connect, with a message pointing at the targets that do support
 * MCP. Loading is side-effect free, so an agent without MCP servers is
 * unaffected.
 */

import { SDKError } from '../../execution/errors';

function unavailable(): never {
  throw new SDKError(
    'MCP is not available from @lousho/build-ai-agent/worker: the entry does not bundle @modelcontextprotocol/sdk. ' +
      'Use the package root on Node.js, or `lousho build --target=cloudflare-worker`, which supports streamable-HTTP MCP servers.',
    'LOUSHO_DEPLOY_FAILED'
  );
}

// @modelcontextprotocol/sdk/client/index.js
export class Client {
  constructor() {
    unavailable();
  }
}

// @modelcontextprotocol/sdk/client/stdio.js
export const getDefaultEnvironment = (): Record<string, string> => ({});
export class StdioClientTransport {
  constructor() {
    unavailable();
  }
}

// @modelcontextprotocol/sdk/client/streamableHttp.js
export class StreamableHTTPClientTransport {
  constructor() {
    unavailable();
  }
}

// @modelcontextprotocol/sdk/client/auth.js
export class UnauthorizedError extends Error {}
export const auth = (): never => unavailable();
