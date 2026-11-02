/**
 * The Author's `openPage` tool (PLAN §8.2, AA06 tool 13): returns
 * `{ ok:true, path }` for a Studio route so the panel can navigate for
 * the user (the client-side navigation is AA15b) instead of the model
 * pasting links.
 *
 * Only Studio pages are accepted: the path must start with one of the
 * known route prefixes and carry no `..`, `//`, whitespace or scheme -
 * the tool's output ends up in a client `history.push`, so anything
 * else is `INVALID_INPUT`, not a navigation.
 */
import { defineTool } from 'lousho';
import { z } from 'zod';
import { guardedToolCall, toolFailure } from './failure';
import type { AuthorToolFactory } from './index';

/** The Studio route roots the tool may open (`path` must equal one or start with `<prefix>/`). */
const STUDIO_PAGE_PREFIXES = [
  '/agents',
  '/templates',
  '/inbox',
  '/settings',
  '/traces',
  '/threads',
  '/playground',
  '/prompts',
  '/hub',
  '/evals',
] as const;

/**
 * Whether `path` is a Studio route: a known prefix, and no `..`, `//`,
 * whitespace or `:` (a scheme or port - the path always starts `/`, so
 * a colon inside it is never legitimate).
 */
function isStudioPath(path: string): boolean {
  if (!STUDIO_PAGE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return false;
  return !(/\s/.test(path) || path.includes('..') || path.includes('//') || path.includes(':'));
}

/** AA06's read tool 13. */
export const openPageTool: AuthorToolFactory = () =>
  defineTool({
    name: 'openPage',
    description: 'Open a Studio page for the user. Use instead of pasting links.',
    input: z.object({
      path: z
        .string()
        .max(200)
        .describe('A Studio route such as "/agents/support-triage/canvas", "/templates" or "/settings".'),
    }),
    execute: ({ path }) =>
      guardedToolCall('openPage', () =>
        isStudioPath(path)
          ? { ok: true, path }
          : toolFailure(
              'INVALID_INPUT',
              `"${path}" is not a Studio page.`,
              "That page doesn't exist in Studio.",
              'Use a path like /agents/<id>/canvas.'
            )
      ),
  });
