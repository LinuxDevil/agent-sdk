import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Check } from '../evals/checks';
import { flowSpecSchema } from '../spec/v2/flow';
import { attachmentsSchema } from './contracts/agentRefs';
import { applyOps } from './contracts/authoringOps';
import { MARKETING_BUILD_OPS, NOT_WRITABLE, normal } from './contracts/__fixtures__/authoringOps';
import { baseHarnessLayer, baseHarnessSchema, type HarnessLayer, type WorkspaceTree } from './contracts/baseHarness';
import { composeHarness, type EffectiveHarness } from './contracts/compose';
import { hasExecutableCriterion, harnessProfileSchema, harnessSchema, type Harness } from './contracts/harness';
import { crossCheckMainHarness, mainHarnessSchema } from './contracts/mainHarness';
import { pageSchema, type PageManifest } from './contracts/page';
import { workspacePolicySchema } from './contracts/policy';
import { pageUiSchema, validateUiBindings } from './contracts/ui';
import { workspaceManifestSchema, type WorkspaceManifest } from './contracts/workspace';
import { readFixtureTree, readNegativeIndex, readNegativeTree, type NegativeCase } from './__fixtures__/readTree';

interface Parser {
  safeParse(value: unknown): { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } };
}

const ROUTES: [RegExp, Parser][] = [
  [/^workspace\.json$/, workspaceManifestSchema],
  [/^harness\/harness\.json$/, baseHarnessSchema],
  [/^harness-profiles\/.+\/harness\.json$/, harnessProfileSchema],
  [/^pages\/[^/]+\/harness\/harness\.json$/, harnessSchema],
  [/^pages\/[^/]+\/page\.json$/, pageSchema],
  [/^pages\/[^/]+\/agents\.json$/, attachmentsSchema],
  [/^pages\/[^/]+\/ui\/page\.ui\.json$/, pageUiSchema],
  [/^main-agent\/harness\/main-harness\.json$/, mainHarnessSchema],
  [/^shared\/policies\/policy\.json$/, workspacePolicySchema],
  [/^workflows\/[^/]+\/workflow\.json$/, flowSpecSchema],
  [/^pages\/[^/]+\/workflow\.json$/, flowSpecSchema],
];

const WITHOUT_SCHEMA: RegExp[] = [/\.md$/, /\.ts$/, /(^|\/)agent\.json$/, /(^|\/)goal\.json$/, /^shared\/brand\/palette\.json$/];

const POSITIVE = ['marketing', 'ops-desk', 'coding'];

const parserFor = (path: string): Parser | undefined => ROUTES.find(([pattern]) => pattern.test(path))?.[1];

const hasNoSchema = (path: string): boolean => WITHOUT_SCHEMA.some((pattern) => pattern.test(path));

interface FileProblem {
  file: string;
  message: string;
}

function parseProblems(path: string, value: unknown): FileProblem[] {
  const result = parserFor(path)?.safeParse(value);
  if (result === undefined || result.success) return [];
  return (result.error?.issues ?? []).map((issue) => ({ file: path, message: `${issue.path.join('.')}: ${issue.message}` }));
}

const fileProblems = (tree: WorkspaceTree): FileProblem[] => Object.entries(tree).flatMap(([path, value]) => parseProblems(path, value));

const unclassified = (tree: WorkspaceTree): string[] => Object.keys(tree).filter((path) => parserFor(path) === undefined && !hasNoSchema(path));

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const manifestOf = (tree: WorkspaceTree): WorkspaceManifest => workspaceManifestSchema.parse(tree['workspace.json']);

const pageOf = (tree: WorkspaceTree, id: string): PageManifest => pageSchema.parse(tree[`pages/${id}/page.json`]);

const textsFor = (tree: WorkspaceTree, dir: string, harness: Harness): Record<string, string> =>
  Object.fromEntries((harness.instructions ?? []).map((file) => [file, String(tree[`${dir}/${file}`] ?? '')]));

function profileLayers(tree: WorkspaceTree, refs: readonly string[], seen: Set<string>): HarnessLayer[] {
  return refs.flatMap((ref) => {
    if (seen.has(ref)) return [];
    seen.add(ref);
    const path = ref.replace(/^workspace:/, '');
    const dir = `harness-profiles/${path}`;
    const harness = harnessProfileSchema.parse(tree[`${dir}/harness.json`]);
    return [{ source: ref, harness, texts: textsFor(tree, dir, harness) }, ...profileLayers(tree, harness.extends ?? [], seen)];
  });
}

function pageLayers(tree: WorkspaceTree, id: string): HarnessLayer[] {
  const page = pageOf(tree, id);
  const dir = `pages/${id}`;
  const harness = harnessSchema.parse({ ...asRecord(tree[`${dir}/harness/harness.json`]), extends: page.harness.extends });
  const base = baseHarnessLayer(tree);
  const own: HarnessLayer = { source: 'page', harness, texts: textsFor(tree, dir, harness) };
  return [...(base ? [base] : []), ...profileLayers(tree, page.harness.extends, new Set()), own];
}

const composePage = (tree: WorkspaceTree, id: string): EffectiveHarness => composeHarness(pageLayers(tree, id));

const pageIds = (tree: WorkspaceTree): string[] => manifestOf(tree).pages;

function aliasesOf(tree: WorkspaceTree, id: string): string[] {
  return attachmentsSchema.parse(tree[`pages/${id}/agents.json`]).agents.map((agent) => agent.as);
}

function executionAliases(page: PageManifest): string[] {
  const { single, multiAgent, goal } = page.execution;
  return [single?.agent, multiAgent?.lead, ...(multiAgent?.delegates ?? []), goal?.lead, ...(goal?.delegates ?? [])].filter((alias): alias is string => alias !== undefined);
}

function agentFolderExists(tree: WorkspaceTree, id: string, ref: string): boolean {
  const [kind, name] = ref.split(':');
  if (kind === 'workspace') return `agents/${name}/agent.json` in tree;
  if (kind === 'local') return `pages/${id}/agents/${name}/agent.json` in tree;
  return kind === 'global';
}

function missingFiles(tree: WorkspaceTree, id: string): string[] {
  const page = pageOf(tree, id);
  const own = harnessSchema.parse(tree[`pages/${id}/harness/harness.json`]);
  const base = baseHarnessSchema.parse(tree['harness/harness.json'] ?? { schema: 'lousho.harness/1' });
  const wanted = [
    ...(own.instructions ?? []).map((file) => `pages/${id}/${file}`),
    ...(own.evaluation?.criteria ?? []).flatMap((criterion) => (criterion.check ? [`pages/${id}/${criterion.check}`] : [])),
    ...(own.context?.resources ?? []).map((file) => `pages/${id}/${file}`),
    ...(base.evaluation?.criteria ?? []).flatMap((criterion) => (criterion.check ? [`harness/${criterion.check}`] : [])),
    ...(page.execution.goal ? [`pages/${id}/goal.json`] : []),
    ...(page.execution.workflow?.workflow === './workflow.json' ? [`pages/${id}/workflow.json`] : []),
    ...(page.execution.workflow?.workflow.startsWith('workspace:') ? [`workflows/${page.execution.workflow.workflow.slice('workspace:'.length)}/workflow.json`] : []),
  ];
  return wanted.filter((path) => !(path in tree));
}

function integrityProblems(tree: WorkspaceTree): string[] {
  const manifest = manifestOf(tree);
  const folders = [...new Set(Object.keys(tree).flatMap((path) => /^pages\/([^/]+)\//.exec(path)?.[1] ?? []))];
  const problems = folders.filter((folder) => !manifest.pages.includes(folder)).map((folder) => `page folder ${folder} is not listed`);
  for (const id of manifest.pages) {
    const page = pageOf(tree, id);
    const aliases = aliasesOf(tree, id);
    problems.push(...executionAliases(page).filter((alias) => !aliases.includes(alias)).map((alias) => `${id}: alias ${alias} is not in agents.json`));
    const refs = attachmentsSchema.parse(tree[`pages/${id}/agents.json`]).agents.map((agent) => agent.ref);
    problems.push(...refs.filter((ref) => !agentFolderExists(tree, id, ref)).map((ref) => `${id}: ${ref} has no folder`));
    problems.push(...missingFiles(tree, id).map((path) => `${id}: ${path} is missing`));
  }
  const routes = tree['main-agent/harness/main-harness.json'] ? mainHarnessSchema.parse(tree['main-agent/harness/main-harness.json']).routes ?? [] : [];
  problems.push(...routes.filter((route) => !manifest.pages.includes(route.page)).map((route) => `route to missing page ${route.page}`));
  return problems;
}

function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

describe('positive fixtures', () => {
  it('every file in the positive fixtures parses with its schema', () => {
    for (const name of POSITIVE) {
      const tree = readFixtureTree(name);
      expect(fileProblems(tree), name).toEqual([]);
      expect(unclassified(tree), name).toEqual([]);
    }
  });

  for (const name of POSITIVE) {
    const tree = readFixtureTree(name);

    it(`every ${name} page composes its harness layers and its UI binds to the composed harness`, () => {
      for (const id of pageIds(tree)) {
        const effective = composePage(tree, id);
        const ui = pageUiSchema.parse(tree[`pages/${id}/ui/page.ui.json`]);
        expect(validateUiBindings(ui, effective), id).toEqual([]);
        expect(hasExecutableCriterion({ schema: 'lousho.harness/1', evaluation: effective.evaluation }), `${id} has an executable criterion (R19)`).toBe(true);
      }
    });

    it(`${name} is internally consistent: pages listed, aliases, refs, routes and referenced files exist`, () => {
      expect(integrityProblems(tree)).toEqual([]);
    });
  }

  it('Marketing has a base harness and a main-agent harness that cross-check against workspace.json', () => {
    const tree = readFixtureTree('marketing');
    const base = baseHarnessLayer(tree);
    expect(base?.harness.constraints).toHaveLength(1);
    expect(base?.harness.evaluation?.criteria.filter((criterion) => criterion.check)).toHaveLength(1);
    const main = mainHarnessSchema.parse(tree['main-agent/harness/main-harness.json']);
    expect(crossCheckMainHarness(main, manifestOf(tree))).toEqual({ errors: [], warnings: [] });
    expect(main.routes?.map((route) => route.page)).toEqual(manifestOf(tree).pages);
    expect(main.clarify).toBeDefined();
    expect(main.limits?.maxConcurrentPages).toBeDefined();
    for (const id of pageIds(tree)) expect(composePage(tree, id).sources[0]).toBe('workspace base');
  });

  it('Marketing pages cover workflow, multi-agent and goal-oriented, and Instagram keeps inactive blocks', () => {
    const tree = readFixtureTree('marketing');
    expect(pageIds(tree).map((id) => pageOf(tree, id).execution.type)).toEqual(['workflow', 'multi-agent', 'goal-oriented']);
    const instagram = pageOf(tree, 'instagram-videos').execution;
    expect(instagram.multiAgent).toBeDefined();
    expect(instagram.goal).toBeDefined();
    const research = pageOf(tree, 'content-research').execution;
    expect(research.goal?.lead).toBe('lead');
    expect(research.goal?.delegates).toEqual(['script']);
    expect(aliasesOf(tree, 'content-research')).toEqual(['lead', 'script']);
  });

  it('Marketing policy allows the three tools and puts publish_* behind approvals', () => {
    const policy = workspacePolicySchema.parse(readFixtureTree('marketing')['shared/policies/policy.json']);
    expect(policy.tools.allow).toEqual(expect.arrayContaining(['render_video', 'synthesize_voice', 'search_facts']));
    expect(policy.approvals?.require).toEqual(['publish_*']);
  });

  it('ops-desk has three pages and no main agent', () => {
    const tree = readFixtureTree('ops-desk');
    expect(manifestOf(tree).mainAgent).toBeNull();
    expect(pageIds(tree)).toHaveLength(3);
    expect(Object.keys(tree).some((path) => path.startsWith('main-agent/'))).toBe(false);
  });

  it('coding has investigate, fix, review and a support-triage page in the support domain', () => {
    const tree = readFixtureTree('coding');
    expect(pageIds(tree)).toEqual(['investigate', 'fix', 'review', 'support-triage']);
    expect(pageOf(tree, 'fix').domain).toBe('coding');
    expect(pageOf(tree, 'support-triage').domain).toBe('support');
  });

  it('global-agents holds the one global fact-checker that ops-desk references', () => {
    const tree = readFixtureTree('global-agents');
    expect(Object.keys(tree).filter((path) => path.endsWith('agent.json'))).toEqual(['fact-checker/agent.json']);
    expect(asRecord(tree['fact-checker/agent.json']).version).toBe('1.0.0');
    const refs = attachmentsSchema.parse(readFixtureTree('ops-desk')['pages/reply-drafts/agents.json']).agents.map((agent) => agent.ref);
    expect(refs).toContain('global:fact-checker@^1.0.0');
  });

  it('Instagram and Facebook reference the same three agents and no agent file is copied', () => {
    const tree = readFixtureTree('marketing');
    const agentPaths = Object.keys(tree).filter((path) => path.startsWith('agents/'));
    const names = [...new Set(agentPaths.map((path) => path.split('/')[1]))].sort();
    expect(names).toEqual(['script-maker', 'video-maker', 'voice-maker']);
    const folderHashes = names.map((name) => hash(agentPaths.filter((path) => path.startsWith(`agents/${name}/`)).map((path) => [path, tree[path]])));
    expect(new Set(folderHashes).size).toBe(3);
    const refsOf = (id: string): string[] => attachmentsSchema.parse(tree[`pages/${id}/agents.json`]).agents.map((agent) => agent.ref);
    expect(refsOf('instagram-videos')).toEqual(names.map((name) => `workspace:${name}`));
    expect(refsOf('facebook-videos')).toEqual(refsOf('instagram-videos'));
    const agentFileHashes = new Set(agentPaths.map((path) => hash(tree[path])));
    const copies = Object.keys(tree).filter((path) => !path.startsWith('agents/') && agentFileHashes.has(hash(tree[path])));
    expect(copies).toEqual([]);
    const strays = Object.keys(tree).filter((path) => /\/agents\/(script|video|voice)-maker\//.test(path));
    expect(strays).toEqual([]);
  });

  it('the ops-built Marketing tree equals the fixture on every file the operations write', () => {
    const fixture = readFixtureTree('marketing');
    const result = applyOps({}, MARKETING_BUILD_OPS, { validate: () => [] });
    expect(result.problems).toEqual([]);
    const built = result.tree;
    expect(Object.keys(built).length).toBeGreaterThan(30);
    const differing = Object.keys(built).filter((path) => !(path in fixture) || !isDeepStrictEqual(normal(built[path]), normal(fixture[path])));
    expect(differing).toEqual([]);
    const onlyInFixture = Object.keys(fixture).filter((path) => !(path in built));
    expect(onlyInFixture.filter((path) => !NOT_WRITABLE.some((pattern) => pattern.test(path)))).toEqual([]);
  });
});

describe('R19 check modules', () => {
  const fixtures = [...POSITIVE.map((name) => name), 'negative/_base'];

  it.each(fixtures)('every check in %s fails on {} and passes on a valid output', async (name) => {
    const tree = readFixtureTree(name);
    const checks = Object.keys(tree).filter((path) => /\/checks\/[^/]+\.ts$/.test(path));
    expect(checks.length).toBeGreaterThan(0);
    for (const path of checks) {
      const module = (await import(`./__fixtures__/${name}/${path}`)) as { default: Check<Record<string, unknown>> };
      const page = /^pages\/([^/]+)\//.exec(path)?.[1];
      const outputs = page ? harnessSchema.parse(tree[`pages/${page}/harness/harness.json`]).outputs?.schema : undefined;
      const field = (outputs as { required?: string[] } | undefined)?.required?.[0] ?? 'text';
      expect(module.default.evaluate({}).passed, path).toBe(false);
      expect(module.default.evaluate({ [field]: '   ' }).passed, path).toBe(false);
      expect(module.default.evaluate({ [field]: 'a valid output' }).passed, path).toBe(true);
    }
  });
});

describe('negative fixtures', () => {
  const index = readNegativeIndex();
  const treeOf = (item: NegativeCase): WorkspaceTree => readNegativeTree(item.name);
  const only = (kind: NegativeCase['checkedBy']): NegativeCase[] => index.cases.filter((item) => item.checkedBy === kind);

  const HELPER_ERRORS: Record<string, (tree: WorkspaceTree) => string[]> = {
    'main-harness-no-main-agent': (tree) => crossCheckMainHarness(mainHarnessSchema.parse(tree['main-agent/harness/main-harness.json']), manifestOf(tree)).errors,
    'ui-bind-missing-input': (tree) => validateUiBindings(pageUiSchema.parse(tree['pages/main/ui/page.ui.json']), composePage(tree, 'main')).map((problem) => `${problem.code} ${problem.message}`),
    'profile-cycle': (tree) => {
      try {
        composePage(tree, 'main');
        return [];
      } catch (error) {
        return [(error as Error).message];
      }
    },
    'rubric-only-improvable': (tree) => {
      const improvable = manifestOf(tree).improve?.enabled !== false && pageOf(tree, 'main').improve?.enabled !== false;
      const executable = hasExecutableCriterion(harnessSchema.parse(tree['pages/main/harness/harness.json']));
      return improvable && !executable ? ['PRD017 an improvable page needs an executable criterion'] : [];
    },
  };

  it('there are 22 negatives with distinct names and 22 distinct codes', () => {
    expect(index.cases).toHaveLength(22);
    expect(new Set(index.cases.map((item) => item.name)).size).toBe(22);
    expect(new Set(index.cases.map((item) => item.code)).size).toBe(22);
    expect(index.cases.every((item) => /^PRD\d{3}$/.test(item.code))).toBe(true);
    expect(index.cases.find((item) => item.name === 'rubric-only-improvable')?.code).toBe('PRD017');
    for (const item of index.cases) expect(item.file in treeOf(item), `${item.name} names ${item.file}`).toBe(true);
  });

  it('the base workspace has no per-file problems and is internally consistent', () => {
    const tree = readNegativeTree(index.base);
    expect(fileProblems(tree)).toEqual([]);
    expect(unclassified(tree)).toEqual([]);
    expect(integrityProblems(tree)).toEqual([]);
    expect(composePage(tree, 'main').sources).toEqual(['page']);
  });

  for (const item of only('schema')) {
    it(`${item.name} fails its schema in ${item.file} with the named error`, () => {
      const problems = fileProblems(treeOf(item));
      expect(new Set(problems.map((problem) => problem.file))).toEqual(new Set([item.file]));
      expect(problems.map((problem) => problem.message).join('\n')).toContain(item.expect);
    });
  }

  for (const item of only('helper')) {
    it(`${item.name} passes every per-file schema and fails the helper check with the named error`, () => {
      const tree = treeOf(item);
      expect(fileProblems(tree)).toEqual([]);
      expect(HELPER_ERRORS[item.name](tree).join('\n')).toContain(item.expect);
    });
  }

  for (const item of only('validateWorkspace')) {
    it(`${item.name} passes every per-file schema and is left to validateWorkspace (P0.10)`, () => {
      expect(fileProblems(treeOf(item))).toEqual([]);
    });
  }

  it('the validateWorkspace-only cases are exactly the cross-file negatives P0.10 drives', () => {
    expect(only('validateWorkspace').map((item) => item.name)).toEqual([
      'policy-outside-shared',
      'main-harness-route-missing-page',
      'goal-check-missing-criterion',
      'inactive-block-unknown-alias',
      'workflow-unknown-alias',
      'workspace-ref-missing-folder',
      'page-folder-not-listed',
      'page-listed-missing-folder',
    ]);
  });
});
