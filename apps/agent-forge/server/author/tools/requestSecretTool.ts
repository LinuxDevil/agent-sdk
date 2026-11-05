/**
 * The Author's `requestSecret` tool (PLAN §8.2, AA14): asks the user for
 * a secret through a secure card. The tool itself never sees the value -
 * it returns `{ ok:true, name, status:'pending' }`, which the turn runner
 * stores as a `state:'pending'` part and reports as `tool.pending`; the
 * panel's card then posts the value straight to
 * `POST /assistant/sessions/:id/secret`, which writes it into the named
 * secrets store (D13) and starts a continuation turn. A name that already
 * holds a value answers `'exists'` with no card at all.
 *
 * Provider keys and the Studio token are refused: they are configured in
 * Settings, and letting the Author store a second copy under a named
 * secret would silently shadow the Settings value.
 */
import { defineTool } from 'lousho';
import { z } from 'zod';
import type { RequestSecretOutput } from '../../../shared/authorWire';
import { guardedToolCall, toolFailure } from './failure';
import type { AuthorToolFactory } from './index';

/**
 * Names `requestSecret` refuses: the provider keys and the Studio token,
 * which Settings owns (`/settings`), not the named-secrets store.
 */
const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'LOUSHO_STUDIO_TOKEN',
]);

/** AA14's client-answered card tool; the value never crosses it. */
export const requestSecretTool: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'requestSecret',
    description:
      "Ask the user for a secret (API key, token, password) through a secure card. The value is stored in Studio's secrets store and never shown to you. After calling it, end your turn with one short sentence asking the user to fill in the card.",
    input: z.object({
      name: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
        .describe(
          'UPPER_SNAKE_CASE name to store it under, e.g. GITHUB_TOKEN. Reference it later as { "secret": NAME }.'
        ),
      why: z
        .string()
        .min(1)
        .max(300)
        .describe('One plain sentence shown on the card: what the agent needs it for.'),
    }),
    execute: ({ name }) =>
      guardedToolCall('requestSecret', (): RequestSecretOutput | ReturnType<typeof toolFailure> => {
        if (RESERVED_SECRET_NAMES.has(name)) {
          return toolFailure(
            'INVALID_INPUT',
            `${name} is a provider key or a Studio token and is set in Settings, not through requestSecret.`,
            'That key is set in Settings.',
            'Tell the user to add it in Settings, and use openPage with "/settings".'
          );
        }
        if (deps.secrets.secretStatus(name).hasValue) {
          return { ok: true, name, status: 'exists' };
        }
        return { ok: true, name, status: 'pending' };
      }),
  });
