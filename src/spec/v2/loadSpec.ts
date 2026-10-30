/**
 * loadSpecV2(): reads a .yaml/.yml/.json spec file of either version and
 * returns a validated AgentSpecV2. The only other `src/spec/v2` file that
 * may import `node:*` besides files.ts - the schema files stay
 * browser-safe.
 */
import * as path from 'node:path';
import { parseSpecData, readSpecFile } from '../specFile';
import { parseAgentSpecV2 } from './parse';
import { upgradeSpec } from './upgrade';
import type { AgentSpecV2 } from './types';

/**
 * Reads `filePath` (.yaml/.yml/.json, chosen by extension) and returns it
 * as a validated AgentSpecV2: a document with `version: 2` is validated as
 * it is, anything else goes through `upgradeSpec()` first. File errors
 * match v1's loadSpec (LOUSHO_SPEC_NOT_FOUND,
 * LOUSHO_SPEC_UNSUPPORTED_FORMAT, LOUSHO_SPEC_INVALID for bad YAML/JSON);
 * validation problems name the file.
 */
export function loadSpecV2(filePath: string): AgentSpecV2 {
  const raw = readSpecFile(filePath);
  const data = parseSpecData(raw, path.extname(filePath).toLowerCase(), filePath);
  const version = typeof data === 'object' && data !== null ? (data as { version?: unknown }).version : undefined;
  return parseAgentSpecV2(version === 2 ? data : upgradeSpec(data), filePath);
}
