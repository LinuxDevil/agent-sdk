/**
 * The built-in tool catalog (`listBuiltinTools()`): machine-readable
 * metadata for every `{ builtin }` name an AgentSpec v2 spec accepts — what
 * the canvas palette and the Author's `listTools` show. Each entry reports
 * the primary tool's description and argument JSON Schema, whether a call
 * can change something outside the run (which drives the default approval
 * suggestion), the JSON Schema of the ref's `options` and every
 * model-facing tool name the builtin adds (`todo` registers two).
 * Node-side: the factories pull in `node:*`, so browser-safe spec files
 * must not import this module; the S23 spec subpath carries it for
 * server-side consumers (D09's `GET /catalog/tools`).
 */
import { zodSchema } from 'ai';
import { BUILTIN_TOOL_NAMES, BUILTIN_TOOL_OPTIONS } from '../spec/v2/tools';
import { schemaToJsonSchema } from '../utils/zodCompat';
import { BUILTIN_TOOL_FACTORIES } from './builtinRegistry';
import type { DefinedTool } from './defineTool';

/** One `{ builtin }` entry of the tool palette. */
export interface BuiltinToolInfo {
  /** The `{ builtin: name }` value. */
  name: string;
  /** What it does (the primary tool's description). */
  description: string;
  /** JSON Schema (draft 7) of the primary tool's arguments. */
  inputJsonSchema: Record<string, unknown>;
  /** Credential keys the tool needs: always [] for builtins (credentialed tools are `{ integration }` refs). */
  needsCredentials: string[];
  /** Whether a call can change something outside the run (drives the default approval suggestion). */
  mutating: boolean;
  /** JSON Schema of `options`, or null when it takes none. */
  optionsJsonSchema: Record<string, unknown> | null;
  /** The model-facing tool names this builtin adds (`todo` adds two). */
  toolNames: string[];
}

/** Whether a call can change something outside the run, per `{ builtin }` name. */
const MUTATING = {
  current_date: false,
  day_name: false,
  http_request: true,
  web_fetch: false,
  todo: false,
} as const satisfies Record<keyof typeof BUILTIN_TOOL_OPTIONS, boolean>;

/** JSON Schema (draft 7) of `schema`: zod 4 and Standard Schemas via `schemaToJsonSchema`, zod 3 via `ai`'s converter. */
function toJsonSchema(schema: unknown): Record<string, unknown> {
  return schemaToJsonSchema(schema) ?? (zodSchema(schema as never).jsonSchema as Record<string, unknown>);
}

/**
 * Every builtin a spec can reference, in BUILTIN_TOOL_NAMES order. Pure:
 * builds the tools with default options and performs no I/O.
 */
export function listBuiltinTools(): BuiltinToolInfo[] {
  return BUILTIN_TOOL_NAMES.map((name) => {
    const tools = BUILTIN_TOOL_FACTORIES[name]({});
    const toolNames = Object.keys(tools);
    const primary = tools[toolNames[0]] as DefinedTool;
    const options = BUILTIN_TOOL_OPTIONS[name];
    return {
      name,
      description: primary.description,
      inputJsonSchema: toJsonSchema(primary.inputSchema),
      needsCredentials: [],
      mutating: MUTATING[name],
      optionsJsonSchema: options === null ? null : toJsonSchema(options),
      toolNames,
    };
  });
}
