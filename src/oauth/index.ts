/**
 * OAuth token storage (N9a): the types of `AgentStore.tokens`, its record
 * keys and the key helper. N9b: providers and sign-in for tools
 * (`defineOAuthProvider`, `ctx.getToken()`, `agent.oauth`).
 */
export type {
  CredentialOwner,
  OAuthToken,
  OAuthTokenInfo,
  OAuthTokenListOptions,
  OAuthTokenStore,
  PendingSignIn,
  TokenOwner,
} from './types';
export { tokenStoreKey } from './tokenStoreKey';
export { generateTokenKey, type TokenKeyInput } from './tokenCipher';
export type { TokenStoreOptions } from './sealedTokenStore';
export { defineOAuthProvider, type OAuthClientAuth, type OAuthProvider, type OAuthProviderOptions } from './defineOAuthProvider';
export { SignInPendingError, type OAuthCallbackParams, type OAuthCompleteResult } from './signIn';
export type { AgentOAuth } from './agentOAuth';
