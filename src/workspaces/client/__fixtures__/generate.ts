import { createHash } from 'node:crypto';
import { attachmentsSchema } from '../../contracts/agentRefs';
import { applyOps } from '../../contracts/authoringOps';
import { baseHarnessLayer, type HarnessLayer, type WorkspaceTree } from '../../contracts/baseHarness';
import { composeHarness, type EffectiveHarness } from '../../contracts/compose';
import { formatArtifactUri, type ArtifactRef, type PageRunEvent } from '../../contracts/execution';
import { harnessProfileSchema, harnessSchema, type Harness } from '../../contracts/harness';
import { mainHarnessSchema } from '../../contracts/mainHarness';
import { pageSchema, type PageManifest } from '../../contracts/page';
import { pageUiSchema } from '../../contracts/ui';
import { validateWorkspace, type WorkspaceProblem } from '../../contracts/validate';
import { workspaceManifestSchema } from '../../contracts/workspace';
import { readFixtureTree } from '../../__fixtures__/readTree';
import type {
  AttachmentView,
  DraftDiffView,
  DraftFileDiff,
  DraftView,
  HistoryEntryView,
  PageDetail,
  ProblemView,
  ProposalView,
  WireRunEvent,
  WorkspaceDetail,
} from '../wireTypes';
import type { WorkspaceRouteName } from '../wire';
import type { AuthoringOp } from '../../contracts/authoringOps';

const WORKSPACE = 'marketing';
const PAGE = 'instagram-videos';
const RUN_ID = 'run-0001';
const DRAFT_ID = 'draft-0001';
const PROPOSAL_ID = 'proposal-0001';
const AT = '2026-11-10T09:00:00.000Z';
const BY = 'ali';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const revisionOf = (tree: WorkspaceTree): string => `rev-${sha256(JSON.stringify(Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)))).slice(0, 12)}`;

const textsFor = (tree: WorkspaceTree, dir: string, harness: Harness): Record<string, string> =>
  Object.fromEntries((harness.instructions ?? []).map((file) => [file, String(tree[`${dir}/${file}`] ?? '')]));

function profileLayers(tree: WorkspaceTree, refs: readonly string[], seen: Set<string>): HarnessLayer[] {
  return refs.flatMap((ref) => {
    if (seen.has(ref)) return [];
    seen.add(ref);
    const dir = `harness-profiles/${ref.replace(/^workspace:/, '')}`;
    const harness = harnessProfileSchema.parse(tree[`${dir}/harness.json`]);
    return [{ source: ref, harness, texts: textsFor(tree, dir, harness) }, ...profileLayers(tree, harness.extends ?? [], seen)];
  });
}

function pageLayers(tree: WorkspaceTree, page: PageManifest): HarnessLayer[] {
  const dir = `pages/${page.id}`;
  const harness = harnessSchema.parse({ ...asRecord(tree[`${dir}/harness/harness.json`]), extends: page.harness.extends });
  const base = baseHarnessLayer(tree);
  return [...(base ? [base] : []), ...profileLayers(tree, page.harness.extends, new Set()), { source: 'page', harness, texts: textsFor(tree, dir, harness) }];
}

interface PageFacts {
  page: PageManifest;
  layers: HarnessLayer[];
  effective: EffectiveHarness;
}

function factsOf(tree: WorkspaceTree, id: string): PageFacts {
  const page = pageSchema.parse(tree[`pages/${id}/page.json`]);
  const layers = pageLayers(tree, page);
  return { page, layers, effective: composeHarness(layers) };
}

const problemView = (problem: WorkspaceProblem): ProblemView => ({ ...problem });

function agentView(tree: WorkspaceTree, attachment: { as: string; ref: string }): Pick<AttachmentView, 'agentOwned'> {
  const dir = `agents/${attachment.ref.replace(/^workspace:/, '')}`;
  const names = (folder: string, suffix: string): string[] =>
    Object.keys(tree)
      .filter((path) => path.startsWith(`${dir}/${folder}/`) && path.endsWith(suffix))
      .map((path) => path.slice(dir.length + folder.length + 2).replace(/\/.*$/, '').replace(suffix, ''));
  return {
    agentOwned: {
      instructions: String(tree[`${dir}/instructions.md`] ?? ''),
      skills: [...new Set(names('skills', ''))].sort(),
      tools: names('tools', '.ts').sort(),
    },
  };
}

function attachmentViews(tree: WorkspaceTree, id: string): AttachmentView[] {
  return attachmentsSchema.parse(tree[`pages/${id}/agents.json`]).agents.map((attachment) => ({
    as: attachment.as,
    ref: attachment.ref,
    ...agentView(tree, attachment),
    pageOwned: attachment,
  }));
}

function pageDetail(tree: WorkspaceTree, revision: string, id: string): PageDetail {
  const { page, effective } = factsOf(tree, id);
  return { workspaceId: WORKSPACE, id, revision, manifest: page, harnessHash: effective.hash };
}

const stringKeys = (value: unknown): string[] => Object.keys(asRecord(value ?? {}));

function fieldChanges(before: unknown, after: unknown): { path: string; before?: unknown; after?: unknown }[] {
  const keys = [...new Set([...stringKeys(before), ...stringKeys(after)])].sort();
  return keys
    .filter((key) => JSON.stringify(asRecord(before ?? {})[key]) !== JSON.stringify(asRecord(after ?? {})[key]))
    .map((key) => ({ path: key, before: asRecord(before ?? {})[key], after: asRecord(after ?? {})[key] }));
}

function fileDiff(file: string, before: unknown, after: unknown): DraftFileDiff {
  const change = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
  if (file.endsWith('.json')) return { file, change, kind: 'json', changes: fieldChanges(before, after) };
  return { file, change, kind: 'prose', text: `-${String(before ?? '')}\n+${String(after ?? '')}` };
}

function diffTrees(before: WorkspaceTree, after: WorkspaceTree, manifestPages: readonly string[]): DraftDiffView {
  const files = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = files.filter((file) => JSON.stringify(before[file]) !== JSON.stringify(after[file]));
  const hashes = manifestPages
    .map((id) => ({ page: id, before: factsOf(before, id).effective.hash, after: factsOf(after, id).effective.hash }))
    .filter((entry) => entry.before !== entry.after);
  return { files: changed.map((file) => fileDiff(file, before[file], after[file])), changedHarnessHashes: hashes };
}

const DRAFT_OPS: AuthoringOp[] = [{ op: 'set_page_field', page: PAGE, field: 'description', value: 'Makes a vertical Instagram video from a topic and a tone.' }];

const treeValidator = (tree: WorkspaceTree): { path: string; message: string; file: string; severity: 'error' | 'warning' | 'info' }[] =>
  validateWorkspace(tree).map((problem) => ({ path: problem.path, message: problem.message, file: problem.file, severity: problem.severity }));

function draftView(tree: WorkspaceTree, revision: string, pages: readonly string[]): DraftView {
  const applied = applyOps(tree, DRAFT_OPS, { validate: treeValidator });
  return {
    id: DRAFT_ID,
    workspaceId: WORKSPACE,
    baseRevision: revision,
    createdBy: BY,
    updatedAt: AT,
    operations: DRAFT_OPS,
    diff: diffTrees(tree, applied.tree, pages),
    problems: [],
  };
}

function artifact(): ArtifactRef {
  const content = '# Script\n\nHook, three beats, call to action.\n';
  return { name: 'script.md', mediaType: 'text/markdown', uri: formatArtifactUri({ workspace: WORKSPACE, runId: RUN_ID, name: 'script.md' }), bytes: content.length, sha256: sha256(content) };
}

function runEvents(effective: EffectiveHarness): WireRunEvent[] {
  const labels = { page: PAGE, attachment: 'script', harnessHash: effective.hash, executionType: 'workflow' as const, stepKind: 'workflow-step' as const, stepIndex: 0 };
  const events: PageRunEvent[] = [
    { type: 'started', page: PAGE, harnessHash: effective.hash, executionType: 'workflow' },
    { type: 'step', phase: 'start', ...labels },
    { type: 'progress', message: 'Writing the script', fraction: 0.5 },
    { type: 'artifact', artifact: artifact() },
    { type: 'step', phase: 'done', ...labels },
    { type: 'finished', status: 'ok' },
  ];
  return events.map((event, id) => ({ id, runId: RUN_ID, event }));
}

function runView(effective: EffectiveHarness, lastEventId: number): Record<string, unknown> {
  return {
    runId: RUN_ID,
    workspaceId: WORKSPACE,
    pageId: PAGE,
    status: 'ok',
    startedAt: AT,
    endedAt: AT,
    input: { pageId: PAGE, task: 'A 30 second video about composting.' },
    result: {
      status: 'ok',
      artifacts: [artifact()],
      summary: 'Wrote the script.',
      usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200, costUsd: 0.002 },
      runId: RUN_ID,
      traceId: `trace-${effective.hash.slice(0, 8)}`,
    },
    lastEventId,
  };
}

function proposal(): ProposalView {
  return {
    id: PROPOSAL_ID,
    pageId: PAGE,
    status: 'pending',
    summary: 'Tighten the hook in the task prose.',
    diff: [{ file: `pages/${PAGE}/harness/task.md`, change: 'modified', kind: 'prose', text: '-Open with a greeting.\n+Open with the question.' }],
    evidence: ['run-0001 scored 0.6 on the hook criterion'],
    heldOut: { passed: true, score: 0.8, summary: '4 of 5 held-out cases passed.' },
    createdAt: AT,
  };
}

function history(revision: string): HistoryEntryView[] {
  return [{ revision, at: AT, by: BY, kind: 'authoring', summary: 'Initial import of the Marketing workspace.' }];
}

function responses(tree: WorkspaceTree): Record<WorkspaceRouteName, unknown> {
  const manifest = workspaceManifestSchema.parse(tree['workspace.json']);
  const revision = revisionOf(tree);
  const pages = manifest.pages.map((id) => pageDetail(tree, revision, id));
  const { layers, effective } = factsOf(tree, PAGE);
  const events = runEvents(effective);
  const problems = validateWorkspace(tree).map(problemView);
  const draft = draftView(tree, revision, manifest.pages);
  const summary = { id: manifest.id, name: manifest.name, description: manifest.description, domain: manifest.domain, revision, pageCount: pages.length, hasMainAgent: manifest.mainAgent !== undefined };
  const detail: WorkspaceDetail = { ...summary, manifest, pages };
  const written = { revision, problems: [] };
  const started = { runId: RUN_ID };
  const run = runView(effective, events.length - 1);
  const pending = proposal();
  return {
    listWorkspaces: [summary],
    getWorkspace: detail,
    listPages: pages,
    getPage: pages[0],
    getEffectiveHarness: { pageId: PAGE, revision, effective, layers, provenance: effective.provenance, hash: effective.hash },
    getMainHarness: { revision, harness: mainHarnessSchema.parse(tree['main-agent/harness/main-harness.json']) },
    getAttachments: attachmentViews(tree, PAGE),
    getPageUi: { pageId: PAGE, revision, ui: pageUiSchema.parse(tree[`pages/${PAGE}/ui/page.ui.json`]) },
    getProblems: problems,
    getHistory: history(revision),
    setPolicy: written,
    writeSharedFile: written,
    writeProfile: written,
    applyOps: { draftId: DRAFT_ID, problems: [], diff: draft.diff },
    listDrafts: [draft],
    getDraft: draft,
    applyDraft: written,
    rebaseDraft: draft,
    discardDraft: written,
    startPageRun: started,
    startWorkspaceRun: started,
    streamRunEvents: events,
    cancelRun: { ...run, status: 'cancelled' },
    approveRun: run,
    getRun: run,
    getRunTrace: { runId: RUN_ID, traceId: `trace-${effective.hash.slice(0, 8)}`, spans: [{ spanId: 'span-1', name: 'page', startedAt: AT, endedAt: AT }] },
    getArtifact: { artifact: artifact(), text: '# Script\n\nHook, three beats, call to action.\n' },
    listProposals: [pending],
    getProposal: pending,
    approveProposal: { ...pending, status: 'first-approved' },
    rejectProposal: { ...pending, status: 'rejected' },
    startImproveRun: started,
  };
}

export const WIRE_FIXTURES_SCHEMA = 'lousho.workspace-wire-fixtures/1';

export function generateWireFixtures(): string {
  const tree = readFixtureTree('marketing');
  return `${JSON.stringify({ schema: WIRE_FIXTURES_SCHEMA, workspaceId: WORKSPACE, responses: responses(tree) }, null, 2)}\n`;
}
