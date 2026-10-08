/**
 * Record/replay for `lousho eval` (LOU-D46). When the CLI sets
 * `LOUSHO_EVAL_CASSETTES`, every model call an eval case makes goes through
 * `recordReplay()`, one cassette per case and provider, committed next to the
 * eval file at `__cassettes__/<eval>/<case>.json`.
 *
 * The hook: `setProviderInterceptor()` (src/providers/interception.ts), the
 * seam the run loop consults for every model call. While a case runs, the
 * interceptor answers with the case's record/replay wrapper for the run's
 * provider, so top-level runs, streamed runs, sub-agents and approval resumes
 * are all covered with no change to the executor. The running case is found
 * with AsyncLocalStorage, so eval files need no change and concurrent cases
 * never share a cassette.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setProviderInterceptor } from '../providers/interception';
import type { LLMProvider } from '../providers/llm';
import { recordReplay } from '../testing/recordReplay';
import type { EvalResult } from './evalResult';
import { SDKError } from '../execution/errors';

/** `record`, `replay`, or `auto` (replay a case whose cassette exists, run the rest live). */
export const CASSETTES_ENV = 'LOUSHO_EVAL_CASSETTES';
/** With `record`: write cassettes here (`--drift`) instead of next to the eval file. */
export const DRIFT_DIR_ENV = 'LOUSHO_EVAL_DRIFT_DIR';
/** The `--config` `lousho eval` was given (cwd-relative), so re-record hints can repeat it. */
export const CONFIG_ENV = 'LOUSHO_EVAL_CONFIG';

type Mode = 'record' | 'replay' | 'auto';

/** The case being run: its eval, its display label, and what identifies it for its cassette. */
export interface EvalCaseInfo {
  file: string | undefined;
  name: string;
  /** Display label (a label taken from `input` is truncated). */
  label?: string;
  /** The untruncated label the cassette name is derived from; defaults to `label`. */
  key?: string;
  /** Position in `cases`, so two cases with the same label are told apart. */
  index?: number;
}

interface CaseRun {
  file: string;
  name: string;
  label?: string;
  key?: string;
  index?: number;
  mode: Mode;
  driftDir?: string;
  /** Real provider -> the wrapper this case uses for it. */
  wrappers: Map<LLMProvider, LLMProvider>;
  /** Committed cassette paths the case recorded or replayed. */
  used: string[];
}

const activeCase = new AsyncLocalStorage<CaseRun>();
const wrappers = new WeakSet<LLMProvider>();
/** Cassette path -> the case that recorded it in this run, to catch two cases sharing one file. */
const recordedBy = new Map<string, { id: string; label: string }>();
let installed = false;

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'case';
}

function providerSuffix(index: number): string {
  return index > 0 ? `.${index + 1}` : '';
}

/**
 * The committed cassette for a case's `index`-th (0-based) provider:
 * `<case>-<hash>.json`, then `<case>-<hash>.2.json`, ... The hash covers the
 * full label, so labels that slug or truncate alike still get their own file.
 */
export function cassettePath(evalFile: string, evalName: string, caseLabel: string | undefined, index = 0): string {
  const base =
    caseLabel === undefined
      ? 'default'
      : `${slug(caseLabel).slice(0, 48).replace(/-+$/, '')}-${createHash('sha256').update(caseLabel).digest('hex').slice(0, 8)}`;
  return path.join(path.dirname(evalFile), '__cassettes__', slug(evalName), `${base}${providerSuffix(index)}.json`);
}

/** The cassette name older SDKs wrote (`<slug of the display label>.json`); still read when it is the only one present. */
export function legacyCassettePath(evalFile: string, evalName: string, caseLabel: string | undefined, index = 0): string {
  const base = slug(caseLabel ?? 'default') + providerSuffix(index);
  return path.join(path.dirname(evalFile), '__cassettes__', slug(evalName), `${base}.json`);
}

/** Where `--drift` re-records the case whose committed cassette is `committed`. */
export function driftCassettePath(driftDir: string, committed: string): string {
  return path.join(driftDir, `${createHash('sha256').update(path.resolve(committed)).digest('hex').slice(0, 16)}.json`);
}

function displayName(run: Pick<CaseRun, 'name' | 'label'>): string {
  return run.label ? `${run.name} [${run.label}]` : run.name;
}

/** The command that re-records `file`, repeating the `--config` the run was given. */
function recordCommand(file: string): string {
  const config = process.env[CONFIG_ENV];
  return `npx lousho eval --record${config ? ` --config ${config}` : ''} ${path.relative(process.cwd(), file)}`;
}

/** The committed cassette a case uses: the hashed name, or a legacy-named one recorded by an older SDK. */
function committedCassette(run: CaseRun, index: number): string {
  const current = cassettePath(run.file, run.name, run.key ?? run.label, index);
  const reads = run.mode !== 'record' || run.driftDir !== undefined;
  if (!reads || fs.existsSync(current)) return current;
  const legacy = legacyCassettePath(run.file, run.name, run.label, index);
  return fs.existsSync(legacy) ? legacy : current;
}

/** Two different cases recording to one cassette would silently overwrite each other: fail the second. */
function claimForRecording(run: CaseRun, cassette: string): void {
  const id = JSON.stringify([path.resolve(run.file), run.name, run.index ?? null, run.key ?? run.label ?? null]);
  const owner = recordedBy.get(cassette);
  if (owner && owner.id !== id) {
    throw new SDKError(
      `lousho eval --record: "${displayName(run)}" would record to ${path.relative(process.cwd(), cassette)}, ` +
        `which "${owner.label}" already recorded in this run. Give each case a distinct \`label\`.`,
      'LOUSHO_CASSETTE_INVALID'
    );
  }
  recordedBy.set(cassette, { id, label: displayName(run) });
}

function wrapperFor(run: CaseRun, provider: LLMProvider): LLMProvider {
  if (wrappers.has(provider)) return provider;
  const existing = run.wrappers.get(provider);
  if (existing) return existing;
  const committed = committedCassette(run, run.wrappers.size);
  const cassette = run.driftDir ? driftCassettePath(run.driftDir, committed) : committed;
  const exists = fs.existsSync(cassette);
  if (run.mode === 'replay' && !exists) {
    throw new SDKError(
      `lousho eval --replay: no cassette for "${displayName(run)}" at ${path.relative(process.cwd(), cassette)}. ` +
        `Record it with: ${recordCommand(run.file)}`,
      'LOUSHO_CASSETTE_INVALID'
    );
  }
  let wrapper = provider;
  if (run.mode === 'record' || exists) {
    if (run.mode === 'record') claimForRecording(run, cassette);
    wrapper = recordReplay(provider, {
      cassette,
      mode: run.mode === 'record' ? 'record' : 'replay',
      rerecordHint: `If the change is intentional, re-record it with: ${recordCommand(run.file)}`,
    });
    wrappers.add(wrapper);
    run.used.push(committed);
  }
  run.wrappers.set(provider, wrapper);
  return wrapper;
}

function installHook(): void {
  if (installed) return;
  installed = true;
  setProviderInterceptor((provider) => {
    const run = activeCase.getStore();
    return run ? wrapperFor(run, provider) : provider;
  });
}

function cassetteMode(): Mode | undefined {
  const mode = process.env[CASSETTES_ENV];
  return mode === 'record' || mode === 'replay' || mode === 'auto' ? mode : undefined;
}

/**
 * Runs one eval case under the cassette mode `lousho eval` asked for and
 * notes the cassettes it used on the result. Without a mode (a plain
 * `vitest run`) it just runs `runCase`.
 */
export async function withEvalCassettes(
  info: EvalCaseInfo,
  runCase: () => Promise<EvalResult>
): Promise<EvalResult> {
  const mode = cassetteMode();
  if (!mode || !info.file) return runCase();
  installHook();
  const driftDir = process.env[DRIFT_DIR_ENV] || undefined;
  const run: CaseRun = { ...info, file: info.file, mode, driftDir, wrappers: new Map(), used: [] };
  const result = await activeCase.run(run, runCase);
  return run.used.length > 0 ? { ...result, cassettes: run.used } : result;
}
