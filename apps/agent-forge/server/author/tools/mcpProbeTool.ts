/**
 * The Author's `probeMcpServer` tool (PLAN §8.2, AA06 tool 11): connect
 * to one MCP server - "the server exactly as it would appear under
 * `mcpServers.<key>`" - for up to 10 seconds and list its tools, so the
 * model can check a server exists before proposing it.
 *
 * The input schema is the spec v2 `mcpServers` entry shape with a
 * `.describe()` on every field (the describe-coverage test enforces
 * this): the v1 `mcpServerSpecSchema` the SDK exports is not the right
 * fit - it has no describes and rejects the v2 SecretRef values
 * (`{ env }`/`{ secret }`) that a spec can carry in `env`, `headers` and
 * `oauth.clientSecret`. The `command`-xor-`url` and cross-field checks
 * mirror the spec schema's own refinement so a malformed server fails
 * argument validation rather than the probe.
 *
 * Probe failures are returned, never thrown: `TIMEOUT` for the 10 s
 * deadline, `MCP_PROBE_FAILED` for everything else, and the `UNAVAILABLE`
 * catch-all for a thrown dep error (guardedToolCall).
 */
import { defineTool } from '@linuxdevil/lousho';
import { z } from 'zod';
import type { McpServerSpecV2 } from '../../../shared/wireTypes';
import { guardedToolCall, toolFailure } from './failure';
import type { AuthorToolFactory } from './index';

/** A `{ env }`/`{ secret }` SecretRef as spec v2 allows where secrets go. */
const secretRef = z
  .union([
    z
      .object({ env: z.string().min(1).describe('Name of the environment variable holding the value.') })
      .strict()
      .describe('Read the value from a process environment variable.'),
    z
      .object({ secret: z.string().min(1).describe('Name of the secret in Settings → Secrets.') })
      .strict()
      .describe('Read the value from a named secret in the Studio secrets store.'),
  ])
  .describe('A secret reference: { env: "NAME" } reads a process environment variable, { secret: "name" } reads a Studio secret.');

/** A string value or a SecretRef - what `env`, `headers` and `oauth.clientSecret` take in spec v2. */
const valueOrRef = z
  .union([z.string().describe('A literal value.'), secretRef])
  .describe('A plain string, or a secret reference ({ env } / { secret }).');

/** A map of string values that may be secret references. */
const stringOrRefMap = z.record(z.string(), valueOrRef);

/**
 * The spec v2 `mcpServers` entry (stdio `command` or HTTP `url`, exactly
 * one), with a describe on every field. The superRefine mirrors the spec
 * schema's own either-or and no-cross-fields checks.
 */
const mcpServerInput = z
  .object({
    command: z.string().min(1).optional().describe('stdio: the executable to run, for example "npx". Set exactly one of command / url.'),
    args: z.array(z.string().describe('One command-line argument.')).optional().describe('stdio: arguments for command.'),
    env: stringOrRefMap.optional().describe('stdio: environment variables for the server process.'),
    cwd: z.string().min(1).optional().describe('stdio: the working directory of the server process.'),
    stderr: z
      .enum(['forward', 'capture', 'inherit', 'ignore'])
      .optional()
      .describe("stdio: what to do with the server's stderr output."),
    url: z.string().url().optional().describe("http: the server's URL. Set exactly one of command / url."),
    headers: stringOrRefMap.optional().describe('http: request headers sent to the server.'),
    oauth: z
      .object({
        redirectUri: z.string().url().describe("The agent's OAuth callback URL."),
        clientId: z.string().min(1).optional().describe('A pre-registered OAuth client id.'),
        clientSecret: valueOrRef.optional().describe('The client secret, or a secret reference to it.'),
        scopes: z.array(z.string().describe('One OAuth scope.')).optional().describe('OAuth scopes to request.'),
        clientName: z.string().min(1).optional().describe('The name the OAuth consent screen shows.'),
      })
      .strict()
      .optional()
      .describe('http: sign in to this server with OAuth.'),
    approval: z
      .enum(['annotations', 'always', 'never'])
      .optional()
      .describe("Which of this server's tools ask for approval before they run."),
    deferLoading: z.boolean().optional().describe("Withhold this server's tools until the tool_search tool finds them."),
    timeoutMs: z.number().positive().optional().describe('How long one tool call may take, in milliseconds.'),
    connectTimeoutMs: z.number().positive().optional().describe('How long connecting may take, in milliseconds.'),
    tools: z
      .object({
        include: z.array(z.string().describe('A tool name to load.')).optional().describe('Only these tool names are loaded.'),
        exclude: z.array(z.string().describe('A tool name to skip.')).optional().describe('These tool names are never loaded.'),
      })
      .strict()
      .optional()
      .describe("Load only some of this server's tools."),
    optional: z.boolean().optional().describe('Skip this server when it fails to connect instead of failing the run.'),
  })
  .superRefine((server, ctx) => {
    const stdio = server.command !== undefined;
    if (stdio === (server.url !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: stdio ? "set either 'command' (stdio) or 'url' (http), not both" : "missing 'command' (stdio) or 'url' (http)",
      });
      return;
    }
    const stray = (stdio ? ['headers', 'oauth'] : ['args', 'env', 'cwd', 'stderr']).find(
      (key) => server[key as keyof typeof server] !== undefined
    );
    if (stray !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `'${stray}' does not apply to ${stdio ? "a stdio ('command')" : "an http ('url')"} server`,
      });
    }
  })
  .describe('The server exactly as it would appear under mcpServers.<key>.');

/** AA06's read tool 11. */
export const probeMcpServerTool: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'probeMcpServer',
    description:
      'Connect to an MCP server for up to 10 seconds and list its tools. Use it before proposing a server you have not used before.',
    input: z.object({ server: mcpServerInput }),
    execute: ({ server }) =>
      guardedToolCall('probeMcpServer', async () => {
        const result = await deps.probeMcp(server as McpServerSpecV2);
        if (result.ok) return { ok: true, tools: result.tools };
        if (result.timedOut === true) {
          return toolFailure('TIMEOUT', 'The server did not answer within 10 seconds.', 'The MCP server took too long to answer.');
        }
        return toolFailure(
          'MCP_PROBE_FAILED',
          `The server did not answer: ${result.error}.`,
          'Studio could not reach that MCP server.',
          'Check the command or URL and its secrets, then try again, or ask the user.'
        );
      }),
  });
