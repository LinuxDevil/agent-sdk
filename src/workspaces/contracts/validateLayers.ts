import { readBaseHarness, type HarnessLayer } from './baseHarness';
import { composeHarness, type EffectiveHarness } from './compose';
import { harnessProfileSchema, hasExecutableCriterion, type Harness } from './harness';
import { validateUiBindings, type UiBindingTarget } from './ui';
import { folderOf, fromIssues, goalCriteria, harnessCode, inlineSchemas, joinPath, layerFileProblems, normalizeDir, problem, resolveGlobal, subtree, type Ctx, type PageView, type WorkspaceProblem } from './validateModel';

interface Origin {
  file: string;
  path: string;
}

interface ProfileSource {
  files?: Readonly<Record<string, unknown>>;
  file: string;
  missing: string;
}

interface Profiles {
  layers: HarnessLayer[];
  problems: WorkspaceProblem[];
  seen: Set<string>;
}

type EffectiveCheck = (ctx: Ctx, view: PageView, effective: EffectiveHarness) => WorkspaceProblem[];

const PROFILE_PATH = /^workspace:((?:[a-z0-9][a-z0-9-]*)(?:\/[a-z0-9][a-z0-9-]*)*)$/;
const GLOBAL_REF = /^global:[^@]+@.+$/;

function profileSource(ctx: Ctx, ref: string): ProfileSource | undefined {
  const workspace = PROFILE_PATH.exec(ref);
  if (workspace) {
    const dir = joinPath(folderOf(ctx, 'harnessProfiles'), workspace[1]);
    return { files: subtree(ctx.tree, dir), file: `${dir}/harness.json`, missing: `has no profile at ${dir}/harness.json` };
  }
  if (!GLOBAL_REF.test(ref)) return undefined;
  const resolved = resolveGlobal(ctx, ref);
  const missing = resolved.error === undefined ? 'is a global ref that resolveGlobal does not answer' : `could not be resolved: resolveGlobal failed: ${resolved.error}`;
  return { files: resolved.files, file: ref, missing };
}

function textsOf(files: Readonly<Record<string, unknown>>, harness: Harness): { texts: Record<string, string>; missing: string[] } {
  const texts: Record<string, string> = {};
  const missing: string[] = [];
  for (const file of harness.instructions ?? []) {
    const text = files[joinPath('', file)];
    if (typeof text === 'string') texts[file] = text;
    else missing.push(file);
  }
  return { texts, missing };
}

function readProfile(ctx: Ctx, ref: string, origin: Origin): { layer?: HarnessLayer; file?: string; problems: WorkspaceProblem[] } {
  const source = profileSource(ctx, ref);
  if (!source) return { problems: [problem('PRD024', origin.file, origin.path, `extends '${ref}', which is not a workspace:<path> or global:<path>@<range> profile ref`)] };
  const doc = source.files?.['harness.json'];
  if (doc === undefined) return { problems: [problem('PRD024', origin.file, origin.path, `extends '${ref}', which ${source.missing}`)] };
  const parsed = harnessProfileSchema.safeParse(doc);
  if (!parsed.success) return { problems: fromIssues(source.file, parsed.error.issues, (issue) => harnessCode(issue.message, 'PRD003')) };
  const { texts, missing } = textsOf(source.files ?? {}, parsed.data);
  const dir = source.file.replace(/\/?harness\.json$/, '');
  const files = source.files ?? {};
  const owner = { dir, file: source.file, files, scanned: !ref.startsWith('global:') };
  const problems = [
    ...missing.map((file) => problem('PRD032', joinPath(dir, file), '', `is listed in ${source.file} instructions but missing`)),
    ...layerFileProblems(ctx, owner, parsed.data, false),
  ];
  return { layer: { source: ref, harness: inlineSchemas(parsed.data, files), texts }, file: source.file, problems };
}

function addProfile(ctx: Ctx, layer: HarnessLayer, file: string, acc: Profiles): void {
  collectProfiles(ctx, layer.harness.extends ?? [], (at) => ({ file, path: `extends.${at}` }), acc);
  acc.layers.push(layer);
}

function collectProfile(ctx: Ctx, ref: string, origin: Origin, acc: Profiles): void {
  if (acc.seen.has(ref)) return;
  acc.seen.add(ref);
  const read = readProfile(ctx, ref, origin);
  acc.problems.push(...read.problems);
  if (read.layer) addProfile(ctx, read.layer, read.file ?? origin.file, acc);
}

function collectProfiles(ctx: Ctx, refs: readonly string[], origin: (index: number) => Origin, acc: Profiles): void {
  refs.forEach((ref, index) => collectProfile(ctx, ref, origin(index), acc));
}

function pageLayer(ctx: Ctx, view: PageView, harness: Harness, extendsRefs: string[]): HarnessLayer | undefined {
  const files = subtree(ctx.tree, view.dir);
  const { texts, missing } = textsOf(files, harness);
  return missing.length > 0 ? undefined : { source: 'page', harness: inlineSchemas({ ...harness, extends: extendsRefs }, files), texts };
}

function baseDir(ctx: Ctx): string {
  return normalizeDir(ctx.manifest.harness ?? 'harness');
}

function tryCompose(layers: HarnessLayer[]): EffectiveHarness | string {
  try {
    return composeHarness(layers);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function bindingTarget(effective: EffectiveHarness): UiBindingTarget | undefined {
  const inputs = effective.inputs?.schema;
  const outputs = effective.outputs?.schema;
  if (typeof inputs === 'string' || typeof outputs === 'string') return undefined;
  return { ...(inputs && { inputs: { schema: inputs } }), ...(effective.outputs && { outputs: effective.outputs as UiBindingTarget['outputs'] }) };
}

const uiProblems: EffectiveCheck = (_ctx, view, effective) => {
  const target = bindingTarget(effective);
  if (!view.ui || !target) return [];
  return validateUiBindings(view.ui, target).map((item) => problem('PRD012', view.uiPath, item.path.join('.'), `${item.code}: ${item.message}`));
};

const executableProblems: EffectiveCheck = (ctx, view, effective) => {
  if (hasExecutableCriterion({ schema: 'lousho.harness/1', evaluation: effective.evaluation })) return [];
  const improvable = view.page?.improve?.enabled ?? ctx.manifest.improve?.enabled ?? true;
  const message = improvable
    ? `page '${view.id}' is improvable but no criterion has an executable check (R19); add a check or set improve.enabled to false`
    : `page '${view.id}' has no criterion with an executable check (R19); it can't be improved until it has one`;
  return [problem('PRD017', view.harnessPath, 'evaluation.criteria', message, improvable ? 'error' : 'warning')];
};

const goalCheckProblems: EffectiveCheck = (ctx, view, effective) => {
  const file = `${view.dir}/goal.json`;
  const criteria = view.page?.execution.goal ? goalCriteria(ctx.tree[file]) : undefined;
  const known = new Set((effective.evaluation?.criteria ?? []).map((criterion) => criterion.id));
  return (criteria ?? []).flatMap((id, index) => (known.has(id) ? [] : [problem('PRD016', file, `checks.${index}.criterion`, `check names criterion '${id}', which no layer defines`)]));
};

const capabilityProblems: EffectiveCheck = (_ctx, view, effective) =>
  (effective.capabilities?.require ?? []).map((capability, index) =>
    problem('PRD025', view.harnessPath, `capabilities.require.${index}`, `requires '${capability}'; capabilities can't be checked until P1 defines the effective toolset`, 'warning')
  );

const EFFECTIVE_CHECKS: readonly EffectiveCheck[] = [uiProblems, executableProblems, goalCheckProblems, capabilityProblems];

export function layerProblems(ctx: Ctx, view: PageView): WorkspaceProblem[] {
  const base = readBaseHarness(ctx.tree);
  const own = view.page && view.harness && base.problems.length === 0 ? pageLayer(ctx, view, view.harness, view.page.harness.extends) : undefined;
  const baseLayer = base.layer && { ...base.layer, harness: inlineSchemas(base.layer.harness, subtree(ctx.tree, baseDir(ctx))) };
  if (!own || !view.page) return [];
  const profiles: Profiles = { layers: [], problems: [], seen: new Set() };
  collectProfiles(ctx, view.page.harness.extends, (index) => ({ file: view.pagePath, path: `harness.extends.${index}` }), profiles);
  if (profiles.problems.length > 0) return profiles.problems;
  const effective = tryCompose([...(baseLayer ? [baseLayer] : []), ...profiles.layers, own]);
  if (typeof effective === 'string') return [problem('PRD013', view.pagePath, 'harness.extends', effective)];
  return EFFECTIVE_CHECKS.flatMap((check) => check(ctx, view, effective));
}
