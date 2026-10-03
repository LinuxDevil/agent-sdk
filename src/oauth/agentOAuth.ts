/**
 * N9b: `agent.oauth` - finishing a sign-in at the callback, and signing the
 * app itself in. Fetch-runtime safe: no `node:*` import.
 */
import { ConfigurationError } from '../execution/errors';
import type { ApprovalStore, PendingApproval } from '../execution/ApprovalGate';
import { isOAuthProvider, type OAuthProvider } from './defineOAuthProvider';
import { completeSignIn, startSignIn, type McpSignInExchange, type OAuthCallbackParams, type OAuthCompleteResult } from './signIn';
import type { OAuthTokenStore } from './types';

/** `agent.oauth`: sign-ins for tools that call `ctx.getToken()` (docs/oauth.md). */
export interface AgentOAuth {
  /**
   * Finishes a sign-in where the provider redirected back (`GET /oauth/callback`
   * does this): takes the pending sign-in for `state` once (unknown or expired:
   * `LOUSHO_OAUTH_STATE_INVALID`), exchanges `code` for a token and stores it
   * for the user the sign-in was started for. With `error` (the user declined)
   * it ends as `'declined'`, and approving the paused call then cancels it. It
   * does not continue the run: approve the pause (`approvalId`) for that.
   *
   * @example
   * ```ts
   * const { approvalId } = await agent.oauth.complete({ state, code });
   * if (approvalId) await agent.approvals.resolve({ id: approvalId, approved: true });
   * ```
   */
  complete(params: OAuthCallbackParams): Promise<OAuthCompleteResult>;
  /**
   * An authorization URL that signs the app itself in to an app-owned provider
   * (`credentialOwner: 'app'`): the operator opens it once, and the callback
   * stores the token every run then uses. A chat user is never sent this link.
   *
   * @example
   * ```ts
   * console.log('Open this to connect the app:', await agent.oauth.signInUrl(slackBot));
   * ```
   */
  signInUrl(provider: OAuthProvider): Promise<string>;
  /**
   * N9c: an authorization URL that signs the app in to the HTTP MCP server
   * `server` (an `mcpServers` entry with `oauth`). It discovers the server's
   * authorization server, registers a client when no `clientId` is set, and
   * uses PKCE and a resource indicator. The operator opens it once; the
   * callback stores the token and the next connection uses it.
   *
   * @example
   * ```ts
   * console.log('Open this to connect Linear:', await agent.oauth.mcpSignInUrl('linear'));
   * ```
   */
  mcpSignInUrl(server: string): Promise<string>;
}

/** The agent's MCP servers with `oauth` (N9c): starting and finishing their sign-ins. */
export interface McpOAuthSignIn {
  signInUrl(server: string): Promise<string>;
  complete: McpSignInExchange;
}

/** Marks a sign-in pause as declined, so approving it cancels the call. */
async function markDeclined(store: ApprovalStore, id: string): Promise<void> {
  const record = await store.resolve(id);
  if (!record) return;
  const mark = (pending: PendingApproval): PendingApproval =>
    pending.kind === 'sign-in' && pending.signIn ? { ...pending, signIn: { ...pending.signIn, declined: true } } : pending;
  await store.save(mark(record.pending), { ...record.snapshot, pendingToolCall: mark(record.snapshot.pendingToolCall) });
}

/** `agent.oauth` over the agent's token store, approval store and (N9c) MCP servers. */
export function createAgentOAuth(tokens: OAuthTokenStore | undefined, approvals: ApprovalStore, mcp?: McpOAuthSignIn): AgentOAuth {
  return {
    async complete(params) {
      const result = await completeSignIn(params, tokens, mcp?.complete);
      if (result.outcome === 'declined' && result.approvalId !== undefined) await markDeclined(approvals, result.approvalId);
      return result;
    },
    async signInUrl(provider) {
      if (!isOAuthProvider(provider) || provider.credentialOwner !== 'app') {
        throw new ConfigurationError(
          "agent.oauth.signInUrl() signs the app in: pass a provider defined with credentialOwner: 'app'. A user's sign-in starts when a tool calls ctx.getToken().",
          'provider'
        );
      }
      return startSignIn(provider, { owner: 'app' }, tokens);
    },
    async mcpSignInUrl(server) {
      if (!mcp) {
        throw new ConfigurationError(`agent.oauth.mcpSignInUrl('${server}'): this agent has no HTTP MCP server with \`oauth\`.`, 'server');
      }
      return mcp.signInUrl(server);
    },
  };
}
