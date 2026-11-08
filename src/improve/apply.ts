import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { ConfigurationError } from '../execution/errors';
import { withFileLock } from '../storage/fileLock';
import { appendAudit, cleanActor, type AuditEntry } from './audit';
import { SKILL_NAME, validateHarness } from './harness';
import { harnessHash, listRevisions, readHarnessState, snapshotRevision } from './revisions';
import type { Harness, ImproveResult } from './types';

/** Who let a proposal through: the gate in auto mode, or a named person. */
export type Approval =
  | {
      /** Applied without a person. */
      mode: 'auto';
      /** The loop stage that passed it. */
      by: 'gate' | 'canary';
    }
  | {
      /** Applied because a person approved it. */
      mode: 'manual';
      /** The name of the person who approved it. */
      approvedBy: string;
    };

/** A gated proposal and the harness it was made against. */
export interface ApplyInput {
  /** The improvement result; only a `proposal` with a harness can be applied. */
  result: ImproveResult;
  /** The harness the proposal was made against; the directory must still hold it. */
  base: Harness;
  /** The self-healing cycle that made the proposal. */
  cycle?: string;
  /** The instructions length limit the proposal was gated with (default 8000). */
  maxAlwaysOnChars?: number;
}

/** The revisions before and after an apply, and the files it changed, relative to the agent directory. */
export interface ApplyResult {
  /** The revision before the write. */
  from: string;
  /** The revision after the write. */
  to: string;
  /** The files written or removed, such as `instructions.md` and `skills/<name>/SKILL.md`. */
  written: string[];
}

interface HarnessState {
  harness: Harness;
  readOnly: string[];
}

interface Step {
  rel: string;
  file: string;
  next?: string;
  prev?: string;
}

const DEFAULT_MAX_ALWAYS_ON = 8000;
const TEMP = '.lousho-tmp';
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const STALE_FIELD = 'base';

function refusal(message: string, field = 'proposal'): ConfigurationError {
  return new ConfigurationError(`applyProposal: ${message}`, field);
}

function normal(harness: Harness): Harness {
  const skills = Object.entries(harness.skills).map(([name, skill]) => [name, { description: skill.description.trim(), content: skill.content.trim() }]);
  return { instructions: harness.instructions.trim(), skills: Object.fromEntries(skills) as Harness['skills'] };
}

const sameHarness = (a: Harness, b: Harness): boolean => harnessHash(normal(a)) === harnessHash(normal(b));

function sameSkill(a: Harness['skills'][string] | undefined, b: Harness['skills'][string] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.description.trim() === b.description.trim() && a.content.trim() === b.content.trim();
}

function frontmatterOf(text: string | undefined): Record<string, unknown> {
  const match = text === undefined ? null : FRONTMATTER.exec(text);
  if (!match) return {};
  try {
    const meta: unknown = parseYaml(match[1]);
    return typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function skillText(name: string, skill: Harness['skills'][string], prev: string | undefined): string {
  const meta = toYaml({ ...frontmatterOf(prev), name, description: skill.description.trim() }, { lineWidth: 0 });
  return `---\n${meta.trimEnd()}\n---\n\n${skill.content.trim()}\n`;
}

function existing(file: string, rel: string): string | undefined {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw refusal(`${rel} is not a regular file, so it can't be replaced.`);
  return fs.readFileSync(file, 'utf8');
}

function guardPath(root: string, rel: string): string {
  let at = root;
  for (const part of rel.split('/')) {
    at = path.join(at, part);
    if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw refusal(`${rel} goes through a symlink, which could lead outside the agent directory; only real files inside it can change.`);
  }
  const relative = path.relative(root, at);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw refusal(`${rel} resolves outside the agent directory.`);
  return at;
}

function guardFolder(root: string, name: string): void {
  const folder = path.join(root, 'skills', name);
  if (!fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return;
  const extra = fs.readdirSync(folder).find((entry) => entry !== 'SKILL.md' && entry !== `SKILL.md${TEMP}` && !JUNK_FILES.has(entry));
  if (extra !== undefined) throw refusal(`skills/${name} holds ${extra} as well as SKILL.md, so it is read-only.`);
}

function step(root: string, rel: string, next: (prev: string | undefined) => string | undefined): Step {
  const file = guardPath(root, rel);
  const prev = existing(file, rel);
  return { rel, file, next: next(prev), prev };
}

function skillStep(root: string, name: string, skill: Harness['skills'][string] | undefined): Step {
  if (!SKILL_NAME.test(name)) throw refusal(`'${name}' is not a valid skill name: use lowercase letters, digits and hyphens.`);
  guardPath(root, `skills/${name}`);
  guardFolder(root, name);
  return step(root, `skills/${name}/SKILL.md`, (prev) => (skill ? skillText(name, skill, prev) : undefined));
}

function planWrites(root: string, next: Harness, current: Harness): Step[] {
  const steps: Step[] = [];
  if (next.instructions.trim() !== current.instructions.trim()) steps.push(step(root, 'instructions.md', () => `${next.instructions.trim()}\n`));
  const names = [...new Set([...Object.keys(next.skills), ...Object.keys(current.skills)])].sort();
  for (const name of names) {
    if (!sameSkill(next.skills[name], current.skills[name])) steps.push(skillStep(root, name, next.skills[name]));
  }
  return steps;
}

function guardReadOnly(next: Harness, current: HarnessState): void {
  const touched = current.readOnly.find((name) => !sameSkill(next.skills[name], current.harness.skills[name]));
  if (touched !== undefined) throw refusal(`skill '${touched}' is read-only (its folder holds more than SKILL.md, or its name differs from its folder), so it can't be changed or removed.`);
}

function makeDirs(folder: string, created: string[]): void {
  const missing: string[] = [];
  for (let at = folder; !fs.existsSync(at); at = path.dirname(at)) missing.unshift(at);
  fs.mkdirSync(folder, { recursive: true });
  created.push(...missing);
}

function removeEmpty(folders: readonly string[]): void {
  for (const folder of [...folders].reverse()) {
    try {
      fs.rmdirSync(folder);
    } catch {
      continue;
    }
  }
}

function removeSkill(file: string): void {
  const folder = path.dirname(file);
  fs.rmSync(file);
  for (const junk of JUNK_FILES) fs.rmSync(path.join(folder, junk), { force: true });
  fs.rmdirSync(folder);
}

function restore(done: readonly Step[]): void {
  for (const item of [...done].reverse()) {
    if (item.prev === undefined) {
      fs.rmSync(item.file, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(item.file), { recursive: true });
    fs.writeFileSync(item.file, item.prev);
  }
}

function cleanUp(steps: readonly Step[], created: readonly string[]): void {
  for (const item of steps) fs.rmSync(`${item.file}${TEMP}`, { force: true });
  removeEmpty(created);
}

function stage(steps: readonly Step[], created: string[]): void {
  for (const item of steps) {
    if (item.next === undefined) continue;
    makeDirs(path.dirname(item.file), created);
    fs.writeFileSync(`${item.file}${TEMP}`, item.next);
  }
}

function swap(item: Step): void {
  if (item.next === undefined) removeSkill(item.file);
  else fs.renameSync(`${item.file}${TEMP}`, item.file);
}

function commit(steps: readonly Step[]): void {
  const created: string[] = [];
  const done: Step[] = [];
  try {
    stage(steps, created);
    for (const item of steps) {
      done.push(item);
      swap(item);
    }
  } catch (error) {
    restore(done);
    cleanUp(steps, created);
    throw error;
  }
}

function verifyWritten(dir: string, steps: readonly Step[], next: Harness): void {
  let written: Harness | undefined;
  try {
    written = readHarnessState(dir).harness;
  } catch {
    written = undefined;
  }
  if (written && sameHarness(written, next)) return;
  restore(steps);
  removeEmpty([...new Set(steps.filter((item) => item.prev === undefined).map((item) => path.dirname(item.file)))]);
  throw refusal('the written files read back as a different harness, so the old files were put back.');
}

function writeHarnessFiles(dir: string, next: Harness, current: HarnessState): string[] {
  guardReadOnly(next, current);
  const steps = planWrites(fs.realpathSync(dir), next, current.harness);
  commit(steps);
  verifyWritten(dir, steps, next);
  return steps.map((item) => item.rel).sort();
}

function actorOf(approval: Approval): AuditEntry['actor'] {
  if (approval.mode === 'auto') return approval.by;
  if (typeof approval.approvedBy !== 'string' || approval.approvedBy.trim() === '') throw refusal('manual approval needs the name of the person who approved it.', 'approvedBy');
  return cleanActor(`person:${approval.approvedBy.trim()}`);
}

function checkedProposal(input: ApplyInput, current: Harness, approval: Approval): Harness {
  const { result, base } = input;
  if (result.outcome !== 'proposal' || !result.harness) throw refusal(`only a proposal with a harness can be applied; this result is '${result.outcome}'.`, 'result');
  if (!sameHarness(current, base)) throw refusal('the proposal is stale: the agent directory changed after the proposal was made. Run improve again.', STALE_FIELD);
  if (sameHarness(result.harness, current)) throw refusal('the proposal changes nothing.', 'result');
  const failedChecks = approval.mode === 'auto' ? result.failedChecks : undefined;
  const limits = { maxAlwaysOnChars: input.maxAlwaysOnChars ?? DEFAULT_MAX_ALWAYS_ON, ...(failedChecks && { failedChecks }) };
  const errors = validateHarness(result.harness, base, limits);
  if (errors.length > 0) throw refusal(`the proposal fails validation at write time: ${errors.join(' ')}`, 'result');
  return result.harness;
}

function snapshotBase(dir: string, id: string): string {
  const latest = listRevisions(dir)[0];
  return snapshotRevision(dir, 'baseline', latest && latest.id !== id ? latest.id : undefined).id;
}

function caseEvidence(result: ImproveResult): NonNullable<AuditEntry['evidence']>['cases'] {
  return result.cases?.map((verdict) => ({ caseId: verdict.caseId, base: `${verdict.base.passed}/${verdict.base.scored}`, final: `${verdict.final.passed}/${verdict.final.scored}` }));
}

async function writeProposal(dir: string, input: ApplyInput, approval: Approval, actor: AuditEntry['actor']): Promise<ApplyResult> {
  let from: string | undefined;
  try {
    const current = readHarnessState(dir);
    from = harnessHash(current.harness);
    const next = checkedProposal(input, current.harness, approval);
    from = snapshotBase(dir, from);
    const written = writeHarnessFiles(dir, next, current);
    const to = snapshotRevision(dir, 'apply', from).id;
    return { from, to, written };
  } catch (error) {
    const stale = error instanceof ConfigurationError && error.field === STALE_FIELD;
    await appendAudit(dir, { actor, action: stale ? 'stale' : 'reject', ...(from && { from }), ...(input.cycle && { cycle: input.cycle }), reason: (error as Error).message });
    throw error;
  }
}

/** Writes a gated proposal's instructions and skills into an agent directory, records revisions and one audit entry, and returns both revision ids. */
export async function applyProposal(dir: string, input: ApplyInput, approval: Approval): Promise<ApplyResult> {
  const actor = actorOf(approval);
  const lousho = path.join(dir, '.lousho');
  fs.mkdirSync(lousho, { recursive: true });
  return withFileLock(path.join(lousho, 'apply.lock'), async () => {
    const applied = await writeProposal(dir, input, approval, actor);
    const evidence = { gate: input.result.reason, cases: caseEvidence(input.result) };
    await appendAudit(dir, { actor, action: 'apply', from: applied.from, to: applied.to, ...(input.cycle && { cycle: input.cycle }), reason: `Applied ${applied.written.join(', ')}.`, evidence });
    return applied;
  });
}
