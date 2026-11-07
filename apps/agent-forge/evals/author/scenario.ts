/**
 * The Author eval scenario file shape (`evals/author/scenarios/*.scenario.json`)
 * and its loader. One file is one scripted conversation: the user turns to
 * send, the optional seeded agents/focus/Apply press around them, and the
 * hard checks plus judged rubric the run is graded by.
 *
 * `scenarioProblems` is the single validation entry: the runner refuses a
 * malformed file with every problem listed, and the scenarios unit test
 * asserts every committed file produces none.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isValidAgentId } from '../../shared/agentId';
import type { AuthorFocus } from '../../shared/authorWire';
import { AUTHOR_TOOL_NAMES } from '../../server/author/toolNames';

/** What a scenario asserts about the conversation it scripts. */
export interface AuthorScenarioExpect {
  /** true: at least one agent was created by the end; false: none. Omitted: not checked. */
  creates?: boolean;
  /** Tool names that must each be called at least once (any turn). */
  tools?: string[];
  /** Tool names that must never be called. */
  mustNot?: string[];
  /** Strings that must appear in no assistant text, tool input or saved spec. */
  notEcho?: string[];
  /** The judged rubric (real mode only): what a good conversation looks like. */
  rubric: string;
}

/** One `*.scenario.json` file. `name` must equal the file's basename. */
export interface AuthorScenario {
  name: string;
  /** Defaults to `{ mode: 'create' }`. */
  focus?: AuthorFocus;
  /** Fixture names under `evals/author/fixtures/<name>.yaml`, saved as agent id = name. */
  seed?: { agents?: string[] };
  /** After turn i (0-based) the harness presses Apply on the newest open card. */
  pressApplyAfterTurn?: number;
  /** The user messages, sent one turn at a time. */
  turns: string[];
  expect: AuthorScenarioExpect;
}

/** A scenario file plus the basename its `name` must match. */
export interface LoadedScenario {
  scenario: AuthorScenario;
  file: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Problems with a `focus` value, or [] when it is absent or a valid AuthorFocus. */
function focusProblems(focus: unknown): string[] {
  if (focus === undefined) return [];
  if (!isRecord(focus)) return ['focus must be an object'];
  if (focus.mode === 'create') return [];
  if (focus.mode === 'edit') {
    return typeof focus.agentId === 'string' && isValidAgentId(focus.agentId)
      ? []
      : ['focus.agentId must be a valid agent id'];
  }
  return ['focus.mode must be "create" or "edit"'];
}

/** Problems with a `seed` value, or [] when absent or `{ agents: string[] }`. */
function seedProblems(seed: unknown): string[] {
  if (seed === undefined) return [];
  if (!isRecord(seed)) return ['seed must be an object'];
  if (seed.agents !== undefined && !isStringList(seed.agents)) return ['seed.agents must be a list of names'];
  return [];
}

/** Problems with a tool-name list (`expect.tools`/`expect.mustNot`), including unknown names. */
function toolNameProblems(field: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!isStringList(value)) return [`expect.${field} must be a list of tool names`];
  const known = new Set<string>(AUTHOR_TOOL_NAMES);
  return value.filter((name) => !known.has(name)).map((name) => `expect.${field} names an unknown tool "${name}"`);
}

/**
 * Every problem with `data` as an AuthorScenario, human-readable. [] means
 * the value is a valid scenario - the runner and the scenarios test share
 * this exact shape check so no file can drift from the contract.
 */
export function scenarioProblems(data: unknown): string[] {
  if (!isRecord(data)) return ['scenario must be a JSON object'];
  const problems: string[] = [];
  if (typeof data.name !== 'string' || data.name === '') problems.push('name is required');
  problems.push(...focusProblems(data.focus));
  problems.push(...seedProblems(data.seed));
  if (
    data.pressApplyAfterTurn !== undefined &&
    (typeof data.pressApplyAfterTurn !== 'number' || !Number.isInteger(data.pressApplyAfterTurn) || data.pressApplyAfterTurn < 0)
  ) {
    problems.push('pressApplyAfterTurn must be a non-negative integer');
  }
  if (!isStringList(data.turns) || data.turns.length === 0) {
    problems.push('turns must be a non-empty list of user messages');
  }
  if (!isRecord(data.expect)) {
    problems.push('expect must be an object');
    return problems;
  }
  if (data.expect.creates !== undefined && typeof data.expect.creates !== 'boolean') {
    problems.push('expect.creates must be a boolean');
  }
  problems.push(...toolNameProblems('tools', data.expect.tools));
  problems.push(...toolNameProblems('mustNot', data.expect.mustNot));
  if (data.expect.notEcho !== undefined && !isStringList(data.expect.notEcho)) {
    problems.push('expect.notEcho must be a list of strings');
  }
  if (typeof data.expect.rubric !== 'string' || data.expect.rubric.trim() === '') {
    problems.push('expect.rubric is required');
  }
  return problems;
}

/**
 * Parses one scenario file. Throws with the file name and every problem
 * found rather than trusting a malformed file to fail a scenario for the
 * wrong reason.
 */
function parseScenarioFile(filePath: string): AuthorScenario {
  const data: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const problems = scenarioProblems(data);
  const base = path.basename(filePath).replace(/\.scenario\.json$/, '');
  if (isRecord(data) && typeof data.name === 'string' && data.name !== base) {
    problems.push(`name "${data.name}" does not match the file name "${base}"`);
  }
  if (problems.length > 0) {
    throw new Error(`${path.basename(filePath)}: ${problems.join('; ')}`);
  }
  return data as AuthorScenario;
}

/**
 * Loads every `*.scenario.json` under `dir`, sorted by file name so runs
 * and results read in a stable order.
 */
export function loadScenarios(dir: string): LoadedScenario[] {
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.scenario.json'))
    .sort((a, b) => a.localeCompare(b));
  return files.map((file) => ({ scenario: parseScenarioFile(path.join(dir, file)), file }));
}
