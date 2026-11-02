/**
 * The paging contract every `list*` Author tool shares: input
 * `{ query?, limit?, page? }`, output
 * `{ ok:true, items, total, page, hasMore }`. `query` filters
 * case-insensitively on the fields the tool names; `limit` defaults to
 * 20 and caps at 50; `page` is 1-based.
 */
import { z } from 'zod';

/**
 * The `query`/`limit`/`page` fields of a `list*` tool's input schema -
 * spread into each tool's `z.object({ ... })` so the descriptions the
 * model sees are identical across tools.
 */
export const pageSchema = {
  query: z.string().max(200).optional().describe('Case-insensitive text to match. Omit to list everything.'),
  limit: z.number().int().min(1).max(50).optional().describe('Items per page, 1-50. Default 20.'),
  page: z.number().int().min(1).optional().describe('Page number, starting at 1. Default 1.'),
} as const;

/** `pageSchema`'s parsed shape. */
export interface PageInput {
  query?: string;
  limit?: number;
  page?: number;
}

/** The `list*` tools' output envelope. */
export interface PageOutput<T> {
  ok: true;
  items: T[];
  /** How many items matched `query` before paging. */
  total: number;
  /** The 1-based page returned. */
  page: number;
  /** Whether `page + 1` would return more items. */
  hasMore: boolean;
}

/**
 * Filters `items` by `input.query` (case-insensitive substring over
 * `text(item)`'s fields) and returns one page of the matches.
 * `input.page` past the last page returns an empty `items` with the true
 * `total`; `hasMore` is `page * limit < total`.
 */
export function paginate<T>(
  items: readonly T[],
  input: PageInput,
  text: (item: T) => readonly (string | undefined)[]
): PageOutput<T> {
  const needle = input.query?.toLowerCase();
  const matched = needle === undefined || needle === ''
    ? [...items]
    : items.filter((item) => text(item).some((field) => field !== undefined && field.toLowerCase().includes(needle)));
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const page = Math.max(input.page ?? 1, 1);
  return {
    ok: true,
    items: matched.slice((page - 1) * limit, page * limit),
    total: matched.length,
    page,
    hasMore: page * limit < matched.length,
  };
}
