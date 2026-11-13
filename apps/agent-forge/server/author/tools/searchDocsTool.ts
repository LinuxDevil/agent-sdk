/**
 * The Author's `searchDocs` tool (PLAN §8.2, AA06 tool 12): keyword
 * search over the bundled lousho docs (`deps.docsDir`, the package
 * root's `docs/`), returning the best matching sections as
 * `{ title, path, excerpt }` hits the model can quote from instead of
 * guessing field names.
 *
 * A missing docs folder is `UNAVAILABLE` - Studio works without the
 * bundled docs (docsIndex.ts normalizes an unreadable folder to
 * `undefined`).
 */
import { defineTool } from '@linuxdevil/lousho';
import { z } from 'zod';
import { loadDocsIndex, searchDocs } from './docsIndex';
import { guardedToolCall, toolFailure } from './failure';
import type { AuthorToolFactory } from './index';

/** AA06's read tool 12. */
export const searchDocsTool: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'searchDocs',
    description: 'Search the bundled lousho docs. Returns the best matching sections.',
    input: z.object({
      query: z.string().min(2).max(200).describe('What to look for, in plain words.'),
      limit: z.number().int().min(1).max(8).optional().describe('How many results, 1-8. Default 5.'),
    }),
    execute: ({ query, limit }) =>
      guardedToolCall('searchDocs', async () => {
        const index = await loadDocsIndex(deps.docsDir);
        if (index === undefined) {
          return toolFailure('UNAVAILABLE', 'The docs folder is missing from this install.', "Docs search isn't available here.");
        }
        return { ok: true, items: searchDocs(index, query, limit ?? 5) };
      }),
  });
