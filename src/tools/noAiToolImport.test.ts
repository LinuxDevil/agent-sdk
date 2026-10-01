/**
 * Static check (LOU-D24): the built-in tools below are built with
 * `defineTool` (or `toolDescriptorFromSchema`) and must not import from `ai`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');

const CONVERTED_FILES = [
  'tools/built-in/currentDate.ts',
  'tools/built-in/dayName.ts',
  'tools/built-in/email.ts',
  'tools/built-in/http.ts',
  'tools/built-in/slack.ts',
  'tools/built-in/sandboxFetch.ts',
  'tools/mcp/McpToolLoader.ts',
  'execution/DelegationTool.ts',
];

const AI_IMPORT = /(?:from|import)\s*\(?\s*['"]ai['"]|require\(\s*['"]ai['"]\s*\)/;

describe('converted built-in tools do not import from "ai"', () => {
  for (const file of CONVERTED_FILES) {
    it(file, () => {
      const source = readFileSync(path.join(SRC, file), 'utf8');
      expect(source).not.toMatch(AI_IMPORT);
    });
  }
});
