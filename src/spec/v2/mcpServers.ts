/**
 * The `mcpServers` section of AgentSpec v2: a record of server name to the
 * v1 entry shape (stdio `command` or HTTP `url`). The legacy v1 list form
 * `[{ name, ... }]` is not accepted here; `upgradeSpec` (S02) hands v2 the
 * record v1's parser produces. Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import { mcpServerSpecSchema } from '../schema';
import { forwardIssues } from './common';

/** MCP server names become the `<server>__<tool>` prefix, so they follow the tool-name alphabet. */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 section schemas (S03 secret refs, Studio name validation)
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One entry: validated by v1's mcpServerSpecSchema, issues re-pathed under
 * the entry and stripped of v1's "AgentSpec validation failed: " prefix by
 * {@link forwardIssues}. The raw value is kept (no v1 transform output).
 */
const mcpServerEntrySchema = z.any().superRefine((value, ctx) => {
  forwardIssues(mcpServerSpecSchema.safeParse(value), ctx);
});

/**
 * `AgentSpecV2.mcpServers`: a map of server name to server config (record form
 * only). Names are checked in a superRefine rather than a record key schema so
 * both zod majors report the same issue (zod 4 wraps key failures in a generic
 * "Invalid key in record").
 */
export const mcpServersSchema = z
  .record(z.string(), mcpServerEntrySchema)
  .superRefine((servers, ctx) => {
    for (const name of Object.keys(servers)) {
      if (!MCP_SERVER_NAME.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'server names must be 1-64 letters, digits, dashes or underscores',
          path: [name],
        });
      }
    }
  });
