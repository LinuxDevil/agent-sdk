import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { resolveAgentDir } from '../agentDir';
import { explainImportError } from '../agentDir/importModule';
import { createAgent, type CreateAgentConfig } from '../createAgent';
import { ConfigurationError } from '../execution/errors';
import {
  admitProtectedCases,
  casesFromFailures,
  casesFromRecoveries,
  createShadowHook,
  formatImproveResult,
  improveAgent,
  probeCapturedCases,
  protectedCasesFromPasses,
  renderTranscript,
  type CapturedCase,
  type CaseCheck,
  type Harness,
  type ImproveOptions,
  type RecoveryEvidence,
} from '../improve';
import { scoreCase } from '../improve/cases';
import { agentInputOf } from '../improve/recoveries';
import type { HealCycle } from '../improve/cycles';
import { guardApproval } from '../improve/approveGuard';
import { readCorpus } from '../improve/corpus';
import { healOnce } from '../improve/heal';
import { corpusCases } from '../improve/healApply';
import { caseProbe, unscored } from '../improve/healState';
import { watchAgent } from '../improve/watch';
import { writtenHash } from '../improve/harnessWriter';
import { readAgentHarness } from '../improve/revisions';
import { loadImproveSettings, type ImproveSettings, type ImproveSettingsOverrides } from '../improve/settings';
import { createAlerter, resolveAlertConfig, type Alerter } from '../observe/alerts';
import { openDb } from '../observe/store';
import type { AgentInput, LLMProvider } from '../providers';
import { defineSkill } from '../skills/defineSkill';
import { memoryStore } from '../storage/agentStore';
import { exitCodeFor, parseCommand, stringValue, usageError, type CommandSpec } from './args';
import { detectTarget, agentModuleConfig, type DevTarget } from './devReload';
import { isImproveAdmin, runImproveAdmin, type PrepareGuard } from './improveAdmin';
import { dbPathOf, resolveAgent, sinceMs } from './observe';

const USAGE =
  'Usage: lousho improve <agent-dir|agent.ts> --check <module> [--model provider/model] [--editor provider/model] [--db path] [--since <N>d|<N>h|<N>m] [--agent X] [--protect traceId]... [--read-only tool]... [--max-tokens n] [--out file] [--with-recoveries] [--approval auto|manual] [--proposers 1-4] [--mode agg|seq] [--select] [--no-parallel-editors] [--dry-run] [--watch [--interval 15m]]\n       lousho improve revisions|rollback|audit|pending|approve|reject|pause|resume|status <agent-dir> ...';

const HELP = `${USAGE}

Experimental. Runs one self-healing cycle on an agent directory. It captures failed runs of the
agent's current harness revision from your own local observe database, has editors propose edits
to its instructions and skills with improveAgent(), gates them, and replays the winner on fresh
runs (the canary). In auto mode (the default) a proposal that passes is written to instructions.md
and skills/<name>/SKILL.md, then the corpus guard replays the protected cases and rolls back on a
regression. In manual mode it is queued for 'lousho improve approve'. Every step is audited in
.lousho/audit.jsonl, and improve.json's daily caps, the cooldown after a rollback and the
.lousho/improve.stop kill switch apply. In auto mode only a failure seen in two or more runs
becomes a case (improve.json trigger.requireRecurring). Ctrl-C stops the cycle between steps; an
apply and its guard always finish. --dry-run only prints the review card and writes nothing; it
reads every failed run, whatever its revision, and ignores the kill switch and the daily caps.
An agent module, or instructions that don't live in instructions.md, always run dry.

Runs replay each case's recorded input through the agent and are not traced. Tools other than
load_skill and read_skill_file are simulated and never run unless --read-only names them, so only
name tools that are safe to call again. Every run and editor call is billed to your models.

Options:
  --check <module>          required: a .js/.ts module whose default export is a CaseCheck,
                            (input, answer) => boolean | null | { passed, failure? }, that
                            scores each answer; failure names the check a failed one missed
  --model provider/model    run the agent on another model
  --editor provider/model   the editors' model (default: --model, else the agent's model)
  --db path                 the observe database (default ~/.lousho/observe.db)
  --since <N>d              only failed runs within the last N days (or <N>h / <N>m)
  --agent X                 only failed runs of this agent (agent_id or name)
  --protect traceId         a run that went well and must keep passing (repeatable); joins
                            the gate only after it passes 6 of 6 fresh runs
  --read-only tool          a tool that is safe to run for real while replaying (repeatable)
  --max-tokens n            stop once n tokens are spent on agent runs and editor calls,
                            checked after each, so the last one can go over; the result is
                            then budget-exceeded with nothing proposed (exit 0). Unset by
                            default: no cap. Admitting --protect traces is not counted
  --with-recoveries         also show the editors each failed run's .heal retry from
                            agent.recover() whose answer passes --check, as evidence
                            only: it never counts as a run and never protects a case
  --out file                also write the proposal to this new file: the review card, or the
                            JSON result for a .json path
  --approval auto|manual    the approval mode, over LOUSHO_IMPROVE_APPROVAL and improve.json
                            (default auto). Manual queues a passing proposal for a person, and
                            keeps an edit that quotes a failed check, flagged on the card
  --proposers <1-4>         k invariant and k domain editors, or k rounds with --mode seq,
                            over improve.json's editors.proposers (default 1); each costs
                            about one more set of editor sessions and proposal runs
  --mode agg|seq            agg proposes side by side; seq runs rounds that build on each
                            other (default agg, or improve.json's editors.mode)
  --select                  gate every candidate and let an advisory selector choose among
                            those that pass (improve.json editors.select)
  --no-parallel-editors     run the editors and their probes one at a time, for a
                            rate-limited model (improve.json editors.parallel)
  --dry-run                 print the review card and change nothing, from every failed run
                            whatever its revision, as before self-healing
  --watch                   keep running: every --interval (default 15m) check the kill
                            switch, take the one-watcher lease, run the post-apply monitor,
                            the corpus guard every guard.everyHours, then a cycle within
                            the daily caps. --agent names the agent whose runs the monitor
                            judges (default: the agent's name). Ctrl-C stops after the step
  --interval <N>m           the tick interval for --watch, as <N>s, <N>m or <N>h
  -h, --help                show this help

Revisions, rollback, the audit log and pending proposals (run one with --help for its flags):
  lousho improve revisions <agent-dir> [--json]
  lousho improve rollback <agent-dir> --by <name> [--to <revision>] [--reason text]
  lousho improve audit <agent-dir> [--verify] [--json]
  lousho improve pending <agent-dir> [--json]
  lousho improve approve <agent-dir> <id> --by <name> [--check <module>] [--model provider/model]
                         [--read-only tool]... [--no-guard]
  lousho improve reject <agent-dir> <id> --by <name> [--reason text]
  lousho improve pause <agent-dir> [--reason text] [--by <name>]   write the kill switch file
  lousho improve resume <agent-dir> [--by <name>]                  remove it
  lousho improve status <agent-dir> [--json]                        mode, revision, monitor, budget left

See docs/improve.md.`;

const SPEC: CommandSpec = {
  command: 'improve',
  usage: USAGE,
  positionals: 1,
  options: {
    check: { type: 'string' },
    model: { type: 'string' },
    editor: { type: 'string' },
    db: { type: 'string' },
    since: { type: 'string' },
    agent: { type: 'string' },
    protect: { type: 'string', multiple: true },
    'read-only': { type: 'string', multiple: true },
    out: { type: 'string' },
    'max-tokens': { type: 'string' },
    'with-recoveries': { type: 'boolean' },
    approval: { type: 'string' },
    proposers: { type: 'string' },
    mode: { type: 'string' },
    select: { type: 'boolean' },
    'no-parallel-editors': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    watch: { type: 'boolean' },
    interval: { type: 'string' },
  },
};

/** Parsed `lousho improve` arguments. */
export interface ImproveArgs {
  path: string;
  check: string;
  model?: string;
  editor?: string;
  db?: string;
  since?: number;
  agent?: string;
  protect: string[];
  readOnly: string[];
  out?: string;
  maxTokens?: number;
  withRecoveries?: boolean;
  /** The approval mode from `--approval`. */
  approval?: ImproveSettings['approval'];
  /** Editor options from `--proposers`, `--mode`, `--select` and `--no-parallel-editors`, over improve.json. */
  editors: Partial<ImproveSettings['editors']>;
  /** `--dry-run`: print the card and write nothing. */
  dryRun?: boolean;
  /** `--watch`: keep running cycles on a timer. */
  watch?: boolean;
  /** `--interval`, in milliseconds. */
  intervalMs?: number;
  help?: boolean;
}

export interface ImproveIo {
  stdout: Writable;
  stderr: Writable;
  /** `createAgent()` options that win over what the target says (tests pass a mock provider). */
  overrides?: CreateAgentConfig;
  /** The editors' provider, instead of `--editor` (tests pass a mock). */
  editor?: LLMProvider;
  /** Resolves when `--watch` should stop, instead of SIGINT or SIGTERM (tests pass one). */
  stop?: Promise<unknown>;
}

const listValue = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

function maxTokensOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const tokens = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(tokens) || tokens < 1) throw usageError(SPEC, `--max-tokens must be a positive integer, not '${text}'.`);
  return tokens;
}

const INTERVAL_UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

function intervalOf(text: string | undefined): Pick<ImproveArgs, 'intervalMs'> {
  if (text === undefined) return {};
  const match = /^(\d+)([smh])$/.exec(text);
  const count = Number(match?.[1] ?? 0);
  if (match === null || count <= 0) throw usageError(SPEC, `--interval must be a positive duration like '15m', '30s' or '1h', not '${text}'.`);
  return { intervalMs: count * INTERVAL_UNIT_MS[match[2]] };
}

function approvalOf(text: string | undefined): Pick<ImproveArgs, 'approval'> {
  if (text === undefined) return {};
  if (text !== 'auto' && text !== 'manual') throw usageError(SPEC, `--approval must be 'auto' or 'manual', not '${text}'.`);
  return { approval: text };
}

function editorsOf(values: Record<string, unknown>): ImproveArgs['editors'] {
  const proposers = stringValue(values.proposers as string | undefined);
  const mode = stringValue(values.mode as string | undefined);
  if (proposers !== undefined && !/^[1-4]$/.test(proposers)) throw usageError(SPEC, `--proposers must be a whole number from 1 to 4, not '${proposers}'.`);
  if (mode !== undefined && mode !== 'agg' && mode !== 'seq') throw usageError(SPEC, `--mode must be 'agg' or 'seq', not '${mode}'.`);
  return {
    ...(proposers !== undefined && { proposers: Number(proposers) }),
    ...(mode !== undefined && { mode }),
    ...(values.select === true && { select: true }),
    ...(values['no-parallel-editors'] === true && { parallel: false }),
  };
}

/** Parses the arguments after `improve`; throws `LOUSHO_CONFIG_INVALID` for a missing path or `--check`, an unknown flag, a bad `--since` or a bad `--max-tokens`. */
export function parseImproveArgs(args: string[]): ImproveArgs {
  const { values, positionals, help } = parseCommand(SPEC, args);
  if (help) return { path: '', check: '', protect: [], readOnly: [], editors: {}, help };
  if (positionals.length !== 1) throw usageError(SPEC, 'a path is required (an agent directory or a .ts/.js agent module).');
  const check = stringValue(values.check);
  if (check === undefined) {
    throw usageError(SPEC, '--check <module> is required: a module whose default export is a CaseCheck that scores an answer. lousho improve never guesses what a good answer is.');
  }
  return {
    path: positionals[0],
    check,
    model: stringValue(values.model),
    editor: stringValue(values.editor),
    db: stringValue(values.db),
    since: sinceMs(SPEC, values.since),
    agent: stringValue(values.agent),
    protect: listValue(values.protect),
    readOnly: listValue(values['read-only']),
    out: stringValue(values.out),
    maxTokens: maxTokensOf(stringValue(values['max-tokens'])),
    withRecoveries: values['with-recoveries'] === true,
    dryRun: values['dry-run'] === true,
    watch: values.watch === true,
    ...intervalOf(stringValue(values.interval)),
    ...approvalOf(stringValue(values.approval)),
    editors: editorsOf(values),
  };
}

async function loadConfig(target: DevTarget): Promise<CreateAgentConfig> {
  if (target.kind === 'dir') return (await resolveAgentDir(target.path, { store: memoryStore() })).config;
  if (target.kind === 'module') {
    const config = await agentModuleConfig(target.path, 'improve');
    if (config) return config;
    throw new ConfigurationError(`lousho improve: ${target.path} exports an agent that was not built with createAgent(), so its instructions can't be read.`, 'path');
  }
  throw usageError(SPEC, 'takes an agent directory or a .ts/.js agent module, not a spec file.');
}

function baseHarness(config: CreateAgentConfig): Harness {
  const { instructions, prompt } = config as { instructions?: unknown; prompt?: unknown };
  if (prompt !== undefined) throw new ConfigurationError("lousho improve: the agent's instructions come from the prompt registry; improve the text there instead.", 'prompt');
  if (typeof instructions !== 'string') throw new ConfigurationError("lousho improve: the agent's instructions must be plain text, not a function.", 'instructions');
  const skills = Object.fromEntries((config.skills ?? []).map((skill) => [skill.name, { description: skill.description, content: skill.content }]));
  return { instructions, skills };
}

async function loadCheck(file: string): Promise<CaseCheck> {
  const resolved = path.resolve(file);
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(resolved).href)) as { default?: unknown };
  } catch (error) {
    throw explainImportError(resolved, error);
  }
  if (typeof mod.default !== 'function') throw new ConfigurationError(`lousho improve: ${file}'s default export must be a CaseCheck function, (input, answer) => boolean | null | { passed, failure? }.`, 'check');
  return mod.default as CaseCheck;
}

const inside = (file: string, dir: string): boolean => {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

function assertOutUsable(out: string, target: DevTarget, config: CreateAgentConfig): void {
  const resolved = path.resolve(out);
  if (fs.existsSync(resolved)) throw usageError(SPEC, `--out ${out} already exists; pick a new file, so nothing is overwritten.`);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) throw usageError(SPEC, `--out ${out}: the folder ${parent} does not exist.`);
  const file = path.join(fs.realpathSync(parent), path.basename(resolved));
  const guarded = target.kind === 'dir' ? [target.path] : [target.path, ...(config.skills ?? []).flatMap((skill) => (skill.directory ? [skill.directory] : []))];
  if (guarded.some((dir) => inside(file, fs.realpathSync(dir)))) throw usageError(SPEC, `--out must be outside the agent's files; ${out} is not.`);
}

function readable(captured: CapturedCase, decoded: Map<string, AgentInput>): CapturedCase {
  const message = agentInputOf(captured.input);
  const input = typeof message === 'string' ? message : captured.input;
  decoded.set(input, message);
  return { ...captured, input };
}

const SKILL_TOOLS = ['load_skill', 'read_skill_file'];

function skillsOf(harness: Harness, directories: ReadonlyMap<string, string | undefined>) {
  return Object.entries(harness.skills).map(([name, skill]) => {
    const directory = directories.get(name);
    return defineSkill({ name, ...skill, ...(directory && { directory }) });
  });
}

function runCaseWith(config: CreateAgentConfig, args: Pick<ImproveArgs, 'model' | 'readOnly'>, io: ImproveIo, decoded: ReadonlyMap<string, AgentInput>) {
  const {
    store: _store,
    approvalStore: _approvalStore,
    exporter: _exporter,
    onEvent: _onEvent,
    ...rest
  } = { ...config, ...io.overrides, ...(args.model && { model: args.model, provider: undefined }) };
  const directories = new Map((config.skills ?? []).map((skill) => [skill.name, skill.directory]));
  const hooks = [createShadowHook({ readOnly: [...SKILL_TOOLS, ...args.readOnly] }), ...(rest.hooks ?? [])];
  return async (harness: Harness, input: string) => {
    const agent = createAgent({ ...rest, instructions: harness.instructions, skills: skillsOf(harness, directories), hooks } as CreateAgentConfig);
    try {
      return caseRun(await agent.send(decoded.get(input) ?? agentInputOf(input)));
    } finally {
      await agent.close().catch(() => undefined);
    }
  };
}

function caseRun(run: Awaited<ReturnType<ReturnType<typeof createAgent>['send']>>) {
  return { answer: run.text ?? '', transcript: renderTranscript(run.messages), tokens: run.usage?.totalTokens ?? 0, ended: run.finishReason };
}

function unscoredOnError(probe: ImproveOptions['probe'], errors: Set<string>): ImproveOptions['probe'] {
  return async (harness, caseId, repeat) => {
    try {
      return await probe(harness, caseId, repeat);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.add(message);
      return { passed: null, transcript: '', tokens: 0, ended: `error: ${message}` };
    }
  };
}

function openObserveDb(args: ImproveArgs) {
  const file = dbPathOf(args.db);
  if (!fs.existsSync(file)) throw new ConfigurationError(`lousho improve: no observe database at ${file}. Run your agent with LOUSHO_OBSERVE=1 and 'lousho observe start' first, or pass --db.`, 'db');
  return openDb(file);
}

function readCases(args: ImproveArgs): { failures: CapturedCase[]; passes: CapturedCase[] } {
  const db = openObserveDb(args);
  try {
    const agent = args.agent === undefined ? undefined : resolveAgent(SPEC, db, args.agent);
    const filter = { since: args.since, agent };
    const recovered = new Map(args.withRecoveries ? casesFromRecoveries(db, filter).map((captured) => [captured.id, captured]) : []);
    const failures = casesFromFailures(db, filter).map((captured) => recovered.get(captured.id) ?? captured);
    return { failures, passes: protectedCasesFromPasses(db, args.protect) };
  } finally {
    db.close();
  }
}

function capture(args: ImproveArgs, io: ImproveIo): { failures: CapturedCase[]; passes: CapturedCase[]; decoded: Map<string, AgentInput> } {
  const { failures, passes } = readCases(args);
  const failed = new Set(failures.map((captured) => captured.traceId));
  for (const id of args.protect) {
    if (failed.has(id)) io.stderr.write(`lousho improve: ${id} is a failed run, so it can't be protected; it stays a case to learn from.\n`);
    else if (!passes.some((captured) => captured.traceId === id)) io.stderr.write(`lousho improve: no trace ${id} with a recorded input to protect.\n`);
  }
  const decoded = new Map<string, AgentInput>();
  const protectable = passes.filter((captured) => !failed.has(captured.traceId));
  return { failures: failures.map((captured) => readable(captured, decoded)), passes: protectable.map((captured) => readable(captured, decoded)), decoded };
}

function checkedRecoveries(failures: readonly CapturedCase[], passes: readonly CapturedCase[], check: CaseCheck): RecoveryEvidence[] {
  const protectedTraces = new Set(passes.map((captured) => captured.traceId));
  return failures.flatMap(({ input, recovery }) => (recovery && !protectedTraces.has(recovery.traceId) && scoreCase(check, input, recovery.answer).passed === true ? [recovery] : []));
}

function editorOf(args: ImproveArgs, config: CreateAgentConfig, io: ImproveIo): ImproveOptions['editor'] {
  if (io.editor) return { provider: io.editor };
  const model = args.editor ?? args.model ?? (typeof config.model === 'string' ? config.model : undefined);
  if (model === undefined) throw usageError(SPEC, "--editor provider/model is required: the agent doesn't name a model string to default to.");
  return { model };
}

async function withoutObserve<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.LOUSHO_OBSERVE;
  process.env.LOUSHO_OBSERVE = '0';
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.LOUSHO_OBSERVE;
    else process.env.LOUSHO_OBSERVE = saved;
  }
}

async function proposeOnly(args: ImproveArgs, io: ImproveIo, target: DevTarget, config: CreateAgentConfig, harness: Harness): Promise<number> {
  const settings = loadImproveSettings(target.kind === 'dir' ? target.path : path.dirname(target.path), overridesOf(args));
  const { approval } = settings;
  const { proposers, mode, select, parallel } = settings.editors;
  const quotedChecks = approval === 'manual' ? 'flag' : 'reject';
  const editor = editorOf(args, config, io);
  const check = await loadCheck(args.check);
  const { failures, passes, decoded } = capture(args, io);
  if (failures.length === 0) {
    io.stdout.write('lousho improve: No failed runs with a recorded input match, so there is nothing to learn from.\n');
    return 0;
  }
  const budget = args.maxTokens === undefined ? 'no token budget; pass --max-tokens <n> to cap the spend' : `stops once ${args.maxTokens} tokens are spent (--max-tokens)`;
  io.stderr.write(
    `lousho improve: ${failures.length} failed run(s) to learn from and ${passes.length} to protect: at least ${3 * failures.length + 6 * passes.length} agent runs plus the editors' calls, all billed to your models; ${budget}.\n`
  );
  const recoveries = checkedRecoveries(failures, passes, check);
  if (args.withRecoveries) io.stderr.write(`lousho improve: ${recoveries.length} with a .heal retry that passed your check, shown to the editors as evidence only.\n`);
  const errors = new Set<string>();
  const probe = unscoredOnError(probeCapturedCases([...failures, ...passes], runCaseWith(config, args, io, decoded), check), errors);
  const result = await withoutObserve(async () => {
    const { admitted, refused } = await admitProtectedCases({ harness, cases: passes, probe });
    for (const { id, passed, scored } of refused) io.stderr.write(`lousho improve: ${id} was not protected: it passed ${passed} of ${scored} scored runs.\n`);
    return improveAgent({
      harness,
      cases: failures.map((c) => c.id),
      holdout: admitted.map((c) => c.id),
      probe,
      editor,
      quotedChecks,
      proposers,
      mode,
      select,
      parallelEditors: parallel,
      ...(args.maxTokens !== undefined && { maxTokens: args.maxTokens }),
      ...(recoveries.length > 0 && { recoveries }),
    });
  });
  const card = formatImproveResult(result);
  io.stdout.write(card);
  if (args.out !== undefined) {
    fs.writeFileSync(path.resolve(args.out), args.out.toLowerCase().endsWith('.json') ? `${JSON.stringify(result, null, 2)}\n` : card, { flag: 'wx' });
    io.stderr.write(`lousho improve: wrote the proposal to ${args.out}. Nothing was applied.\n`);
  }
  for (const message of errors) io.stderr.write(`lousho improve: a run failed and was left unscored: ${message}\n`);
  if (result.outcome === 'budget-exceeded') io.stderr.write(`lousho improve: the --max-tokens ${args.maxTokens} budget ran out before a result; nothing was proposed. Raise --max-tokens to let it finish.\n`);
  return result.outcome === 'outage' ? 1 : 0;
}

function dryRunReason(target: DevTarget, harness: Harness): string | undefined {
  if (target.kind !== 'dir') return `${target.path} is an agent module, whose files can't be changed in place`;
  try {
    if (writtenHash(readAgentHarness(target.path)) !== writtenHash(harness)) return "the agent's instructions or skills don't all come from instructions.md and skills/<name>/SKILL.md";
  } catch (error) {
    if (error instanceof ConfigurationError) return error.message;
    throw error;
  }
  return undefined;
}

const NEXT_STEP: Partial<Record<HealCycle['outcome'], string>> = {
  pending: "Approve it with 'lousho improve approve <agent-dir> <id> --by <name>', or reject it with 'lousho improve reject'.",
  applied: "See 'lousho improve audit <agent-dir>'; undo it with 'lousho improve rollback <agent-dir> --by <name>'.",
  paused: "Remove .lousho/improve.stop, unset LOUSHO_IMPROVE=off or set enabled to true in improve.json to resume.",
};

function reportCycle(cycle: HealCycle, args: ImproveArgs, io: ImproveIo): void {
  if (cycle.result) io.stdout.write(formatImproveResult(cycle.result));
  const next = NEXT_STEP[cycle.outcome];
  io.stdout.write(`lousho improve: ${cycle.outcome}: ${cycle.reason}${next ? ` ${next}` : ''}\n`);
  for (const message of cycle.errors ?? []) io.stderr.write(`lousho improve: a run failed and was left unscored: ${message}\n`);
  if (args.out === undefined) return;
  if (!cycle.result) {
    io.stderr.write(`lousho improve: no proposal was made, so ${args.out} was not written.\n`);
    return;
  }
  const card = formatImproveResult(cycle.result);
  try {
    fs.writeFileSync(path.resolve(args.out), args.out.toLowerCase().endsWith('.json') ? `${JSON.stringify(cycle.result, null, 2)}\n` : card, { flag: 'wx' });
    io.stderr.write(`lousho improve: wrote the proposal to ${args.out}.\n`);
  } catch (error) {
    io.stderr.write(`lousho improve: could not write ${args.out}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function overridesOf(args: ImproveArgs): ImproveSettingsOverrides {
  return { ...(args.approval && { approval: args.approval }), editors: args.editors };
}

async function cycleInputs(args: ImproveArgs, io: ImproveIo, dir: string, config: CreateAgentConfig) {
  const settings = loadImproveSettings(dir, overridesOf(args));
  const editor = editorOf(args, config, io);
  const check = await loadCheck(args.check);
  return { settings, editor, check, db: openObserveDb(args) };
}

async function healDir(args: ImproveArgs, io: ImproveIo, dir: string, config: CreateAgentConfig): Promise<number> {
  const { settings, editor, check, db } = await cycleInputs(args, io, dir, config);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  try {
    const agent = args.agent === undefined ? undefined : resolveAgent(SPEC, db, args.agent);
    const budget = args.maxTokens === undefined ? "within improve.json's token caps" : `stopping once ${args.maxTokens} tokens are spent (--max-tokens)`;
    const write = settings.approval === 'auto' ? 'applies a proposal that passes the gate and the canary' : 'queues a proposal that passes the gate and the canary for a person';
    io.stderr.write(`lousho improve: running one self-healing cycle in ${settings.approval} mode, which ${write}; agent runs and editor calls are billed to your models, ${budget}. Pass --dry-run to change nothing.\n`);
    const cycle = await withoutObserve(() =>
      healOnce({
        dir,
        db,
        check,
        runCase: runCaseWith(config, args, io, new Map()),
        editor,
        settings,
        trigger: 'manual',
        protect: args.protect,
        withRecoveries: args.withRecoveries === true,
        ...(agent !== undefined && { agent }),
        ...(args.since !== undefined && { since: args.since }),
        ...(args.maxTokens !== undefined && { maxTokens: args.maxTokens }),
        signal: controller.signal,
      })
    );
    reportCycle(cycle, args, io);
    return cycle.outcome === 'outage' ? 1 : 0;
  } finally {
    process.off('SIGINT', interrupt);
    db.close();
  }
}

function alertsFor(args: ImproveArgs): { alerter?: Alerter } {
  const config = resolveAlertConfig(dbPathOf(args.db));
  return config.webhooks.length > 0 ? { alerter: createAlerter(config) } : {};
}

function stopRequested(io: ImproveIo): { stopped: Promise<unknown>; dispose(): void } {
  if (io.stop) return { stopped: io.stop, dispose: () => undefined };
  let done: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    done = resolve;
  });
  process.once('SIGINT', done);
  process.once('SIGTERM', done);
  return {
    stopped,
    dispose: () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
    },
  };
}

async function watchDir(args: ImproveArgs, io: ImproveIo, dir: string, config: CreateAgentConfig): Promise<number> {
  const { settings, editor, check, db } = await cycleInputs(args, io, dir, config);
  const name = args.agent ?? config.name;
  if (name === undefined) throw usageError(SPEC, "--watch needs --agent: the agent doesn't name itself, so the monitor can't find its runs.");
  const stop = stopRequested(io);
  try {
    const agent = resolveAgent(SPEC, db, name);
    io.stderr.write(`lousho improve: watching ${dir} in ${settings.approval} mode every ${(args.intervalMs ?? 900_000) / 1000}s; 'lousho improve pause ${dir}' or Ctrl-C stops it.\n`);
    await withoutObserve(async () => {
      const watcher = watchAgent({
        dir,
        db,
        check,
        runCase: runCaseWith(config, args, io, new Map()),
        editor,
        settings,
        reloadSettings: () => loadImproveSettings(dir, overridesOf(args)),
        registry: path.join(path.dirname(dbPathOf(args.db)), 'watchers.json'),
        agent,
        protect: args.protect,
        withRecoveries: args.withRecoveries === true,
        ...(args.since !== undefined && { since: args.since }),
        ...(args.intervalMs !== undefined && { intervalMs: args.intervalMs }),
        ...alertsFor(args),
        log: (line) => io.stderr.write(line),
        onCycle: (cycle) => io.stdout.write(`lousho improve: ${cycle.outcome}: ${cycle.reason}\n`),
        onError: (error) => io.stderr.write(`lousho improve: a watch tick failed: ${error instanceof Error ? error.message : String(error)}\n`),
      });
      await stop.stopped;
      await watcher.stop();
    });
    return 0;
  } finally {
    stop.dispose();
    db.close();
  }
}

function assertWatchArgs(args: ImproveArgs, target: DevTarget, forced: string | undefined): void {
  if (!args.watch) {
    if (args.intervalMs !== undefined) throw usageError(SPEC, '--interval only applies with --watch.');
    return;
  }
  if (args.maxTokens !== undefined || args.out !== undefined) throw usageError(SPEC, '--watch takes its token budget from improve.json and writes no --out file; drop --max-tokens and --out.');
  if (args.dryRun || forced || target.kind !== 'dir') throw usageError(SPEC, `--watch needs an agent directory whose instructions live in instructions.md, and can't be a dry run${forced ? `: ${forced}` : ''}.`);
}

async function improve(args: ImproveArgs, io: ImproveIo): Promise<number> {
  const target = detectTarget(args.path, 'improve');
  const config = await loadConfig(target);
  if (args.out !== undefined) assertOutUsable(args.out, target, config);
  const harness = baseHarness(config);
  const forced = args.dryRun ? undefined : dryRunReason(target, harness);
  assertWatchArgs(args, target, forced);
  if (forced) io.stderr.write(`lousho improve: this is a dry run, because ${forced}. Nothing will be applied.\n`);
  if (args.dryRun || forced || target.kind !== 'dir') return proposeOnly(args, io, target, config, harness);
  return args.watch ? watchDir(args, io, target.path, config) : healDir(args, io, target.path, config);
}

function approveGuardOf(io: ImproveIo): PrepareGuard {
  return async (dir, flags) => {
    const config = await loadConfig({ kind: 'dir', path: dir });
    const check = await loadCheck(flags.check);
    const { runs } = loadImproveSettings(dir).guard;
    const errors = new Set<string>();
    const probe = unscored(caseProbe(corpusCases(readCorpus(dir)), runCaseWith(config, flags, io, new Map()), check), errors, undefined);
    return async (applied) => {
      const result = await withoutObserve(() => guardApproval(dir, applied, { probe, runs }));
      for (const message of errors) io.stderr.write(`lousho improve approve: a guard run failed and was left unscored: ${message}\n`);
      return result;
    };
  };
}

/** Runs `lousho improve` with the arguments after `improve`; resolves with the exit code. */
export async function runImprove(args: string[], io: ImproveIo = { stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  try {
    if (isImproveAdmin(args)) return await runImproveAdmin(args, { ...io, prepareGuard: approveGuardOf(io) });
    const parsed = parseImproveArgs(args);
    if (parsed.help) {
      io.stdout.write(`${HELP}\n`);
      return 0;
    }
    return await improve(parsed, io);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return exitCodeFor(error);
  }
}
