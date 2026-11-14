import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHOR_TOOL_NAMES } from '../../../server/author/toolNames';
import { loadScenarios, scenarioProblems } from '../scenario';
import type { AuthorScenario } from '../scenario';

/**
 * Every committed `*.scenario.json` validates against the TypeScript
 * shape: it parses with no problems, its `name` is unique and matches the
 * file name, and every tool it expects or forbids is a real Author tool.
 */

const scenariosDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');
const loaded = loadScenarios(scenariosDir);

describe('author eval scenario files', () => {
  it('finds the 16 committed scenarios', () => {
    expect(loaded).toHaveLength(16);
  });

  it('every file parses with no problems and names itself', () => {
    for (const { scenario, file } of loaded) {
      expect(scenarioProblems(scenario), file).toEqual([]);
      expect(scenario.name).toBe(file.replace(/\.scenario\.json$/, ''));
      expect(scenario.turns.length).toBeGreaterThan(0);
      expect(scenario.expect.rubric.trim().length).toBeGreaterThan(0);
    }
  });

  it('names are unique', () => {
    const names = loaded.map(({ scenario }) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('expected and forbidden tool names are all Author tools', () => {
    const known = new Set<string>(AUTHOR_TOOL_NAMES);
    for (const { scenario } of loaded) {
      for (const name of [...(scenario.expect.tools ?? []), ...(scenario.expect.mustNot ?? [])]) {
        expect(known.has(name), `${scenario.name}: ${name}`).toBe(true);
      }
    }
  });

  it('rejects malformed scenarios with named problems', () => {
    expect(scenarioProblems({})).toContain('name is required');
    expect(scenarioProblems({ name: 'x', turns: [], expect: { rubric: 'r' } })).toContain(
      'turns must be a non-empty list of user messages'
    );
    expect(scenarioProblems({ name: 'x', turns: ['hi'], expect: { rubric: '' } })).toContain(
      'expect.rubric is required'
    );
    expect(
      scenarioProblems({ name: 'x', turns: ['hi'], expect: { rubric: 'r', tools: ['madeUpTool'] } })
    ).toContain('expect.tools names an unknown tool "madeUpTool"');
    expect(
      scenarioProblems({ name: 'x', turns: ['hi'], expect: { rubric: 'r' }, focus: { mode: 'edit', agentId: '..' } })
    ).toContain('focus.agentId must be a valid agent id');
  });

  it('seed fixture names resolve to a committed fixture file', () => {
    const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
    for (const { scenario } of loaded as { scenario: AuthorScenario; file: string }[]) {
      for (const name of scenario.seed?.agents ?? []) {
        expect(fs.existsSync(path.join(fixturesDir, `${name}.yaml`)), `${scenario.name}: ${name}`).toBe(true);
      }
    }
  });
});
