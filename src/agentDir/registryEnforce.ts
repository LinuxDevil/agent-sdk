/**
 * Runtime enforcement of the installed permission manifest (#272, the
 * follow-up to M7a's install-time check).
 *
 * `lousho add` records what it installed in `<agent-dir>/lousho-registry.json`
 * (addReceipt.ts): each item's declared `permissions` and the sha256 of every
 * file. When `loadAgentDir()` reads the directory, {@link verifyReceipt}
 * re-hashes those files; a file that changed or went missing makes its item
 * `unattested`, which is reported (a warning line per item; the load itself is
 * not refused - the files are the owner's to edit). {@link confineToolsToReceipt}
 * then wraps every tool a receipt item owns so a run stays inside the last
 * accepted manifest - attested or not, a stale receipt never widens what the
 * code may do:
 *
 * - `exec: true` or `needsApproval: true` in the manifest - and any
 *   `unattested` item, whose stale receipt no longer certifies the modified
 *   code: the tool's calls always wait for approval (its own `needsApproval`
 *   may still deny, never silently approve);
 * - `network`: calls through `globalThis.fetch` made while the tool's
 *   `execute`/`sandboxExecute` runs are limited to the declared host patterns;
 * - `env`: `process.env` reads while the tool runs see only the declared names;
 * - a `requiresSandbox` tool gets a narrowed adapter: `run()` is refused
 *   without `exec`, `writeFile()` without `filesystem: "write"`, and a command's
 *   environment is the base set plus the declared variables only.
 *
 * The in-process guards work through the ambient `fetch` and `process.env`,
 * tracked per call with AsyncLocalStorage so unrelated code is untouched. They
 * cannot cover what JS cannot intercept: `http`/`net`/`axios` traffic, the
 * filesystem, or a reference taken at module scope (`const f = fetch`). The
 * static check at install already refuses the visible forms of those; what
 * remains is the documented limit of a manifest, not a sandbox.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { RECEIPT_FILE, readReceipt, type Receipt, type ReceiptEntry } from '../cli/addReceipt';
import { SDKError } from '../execution/errors';
import { enforceApproval, hasEnforcedApproval } from '../execution/permissions';
import type { ApproveToolCall } from '../createAgentApprovals';
import { isPartialStream } from '../execution/toolPartials';
import { commandEnv } from '../security/commandEnv';
import { matchesHost } from '../security/hostPattern';
import type { SandboxAdapter, SandboxRunOptions } from '../security/sandboxCore';
import { legacyAiTool } from '../tools/toolContract';
import type { DefinedTool } from '../tools/defineTool';
import type { ApprovalCheckContext, ApprovalOutcome, ToolDescriptor, ToolExecutionContext } from '../types';
import { isFile, readText } from './fsUtil';
import type { LoadedTool } from './collectTools';

/** Whether a receipt item's files are still exactly what `lousho add` wrote. */
export type Attestation = 'attested' | 'unattested';

/** One receipt item's state at load time. */
export interface RegistryItemStatus {
  name: string;
  type: ReceiptEntry['type'];
  /** 'unattested' when a file changed or went missing since the install that wrote the receipt. */
  status: Attestation;
  /** Receipt paths whose sha256 no longer matches (sorted as in the receipt). */
  modified: string[];
  /** Receipt paths no longer on disk. */
  missing: string[];
  /** The manifest accepted at install; enforced on this item's tools either way. */
  permissions: ReceiptEntry['permissions'];
  /** The receipt paths this item owns (forward slashes, as the receipt records them). */
  files: string[];
}

/** What {@link verifyReceipt} found in an agent directory. */
export interface RegistryStatus {
  /** The receipt file (absolute path). */
  file: string;
  /** Why the receipt could not be read, when it could not be (items is then empty). */
  error?: string;
  items: RegistryItemStatus[];
}

const sha256 = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Reads `dir`'s install receipt and re-hashes every file it lists. `undefined`
 * when there is no receipt; a receipt that exists but cannot be parsed comes
 * back as `{ error }` rather than throwing, so a broken file never stops the
 * owner's directory from loading - it is reported instead.
 */
export async function verifyReceipt(dir: string): Promise<RegistryStatus | undefined> {
  const file = path.join(dir, RECEIPT_FILE);
  if (!(await isFile(file))) return undefined;
  let receipt: Receipt;
  try {
    receipt = await readReceipt(dir);
  } catch (error) {
    return { file, error: message(error), items: [] };
  }
  const items: RegistryItemStatus[] = [];
  for (const [name, entry] of Object.entries(receipt.items)) {
    const modified: string[] = [];
    const missing: string[] = [];
    for (const recorded of entry.files) {
      const abs = path.join(dir, recorded.path);
      if (!(await isFile(abs))) {
        missing.push(recorded.path);
        continue;
      }
      const content = await readText(abs).catch(() => undefined);
      if (content === undefined || sha256(content) !== recorded.sha256) modified.push(recorded.path);
    }
    items.push({
      name,
      type: entry.type,
      status: modified.length > 0 || missing.length > 0 ? 'unattested' : 'attested',
      modified,
      missing,
      permissions: entry.permissions,
      files: entry.files.map((recorded) => recorded.path),
    });
  }
  return { file, items };
}

/** One warning line per unattested receipt item (and one for an unreadable receipt), for `loadAgentDir` to print. */
export function registryWarnings(status: RegistryStatus | undefined): string[] {
  if (status === undefined) return [];
  const lines: string[] = [];
  if (status.error !== undefined) {
    lines.push(
      `loadAgentDir: ${status.file} could not be read (${status.error}). ` +
        'Fix or remove it, or reinstall the items it recorded with `lousho add`.'
    );
  }
  for (const item of status.items) {
    if (item.status === 'attested') continue;
    const changes = [...item.modified.map((file) => `${file} was modified`), ...item.missing.map((file) => `${file} is missing`)].join('; ');
    lines.push(
      `loadAgentDir: registry item '${item.name}' no longer matches its install receipt (${changes}). ` +
        `Its declared permission manifest is still enforced. If the change was intended, reinstall with \`lousho add ${item.name} --overwrite\` to attest the current files.`
    );
  }
  return lines;
}

/** The runtime envelope one receipt item binds its tools to: the manifest accepted at install. */
interface Envelope {
  item: string;
  /** Lower-cased host patterns (`matchesHost`); empty means no egress through `fetch` at all. */
  network: readonly string[];
  /** The `process.env` names the item may see. */
  env: ReadonlySet<string>;
}

/** The envelope of the tool call currently running, if any. */
const currentEnvelope = new AsyncLocalStorage<Envelope>();

let guardsInstalled = false;
/** The environment the proxy wraps (the real one, for the SDK's own use). */
let realEnv: NodeJS.ProcessEnv = process.env;

/** Whether `prop` may be read on `process.env` under `envelope` (Windows env names compare case-insensitively). */
function envVisible(envelope: Envelope | undefined, prop: string | symbol): boolean {
  if (envelope === undefined || typeof prop !== 'string') return true;
  if (envelope.env.has(prop)) return true;
  return process.platform === 'win32' && envelope.env.has(prop.toUpperCase());
}

const envTraps: ProxyHandler<NodeJS.ProcessEnv> = {
  get(target, prop, receiver) {
    if (!envVisible(currentEnvelope.getStore(), prop)) return undefined;
    return Reflect.get(target, prop, receiver);
  },
  has(target, prop) {
    if (!envVisible(currentEnvelope.getStore(), prop)) return false;
    return Reflect.has(target, prop);
  },
  ownKeys(target) {
    const keys = Reflect.ownKeys(target);
    const envelope = currentEnvelope.getStore();
    return envelope === undefined ? keys : keys.filter((key) => envVisible(envelope, key));
  },
  getOwnPropertyDescriptor(target, prop) {
    if (!envVisible(currentEnvelope.getStore(), prop)) return undefined;
    return Reflect.getOwnPropertyDescriptor(target, prop);
  },
};

function urlOf(input: Parameters<typeof fetch>[0]): URL | undefined {
  try {
    return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  } catch {
    return undefined;
  }
}

/** `input` as a printable `scheme://host` (no path or query, which could hold secrets). */
function describeTarget(input: Parameters<typeof fetch>[0]): string {
  const url = urlOf(input);
  return url === undefined ? String(input) : `${url.protocol}//${url.host}`;
}

/** A `fetch` that, inside a confined tool call, lets only the envelope's hosts through. */
function confinedFetch(realFetch: typeof fetch): typeof fetch {
  return (input, init) => {
    const envelope = currentEnvelope.getStore();
    if (envelope === undefined) return realFetch(input, init);
    const url = urlOf(input);
    const host = url !== undefined && (url.protocol === 'http:' || url.protocol === 'https:') ? url.hostname.toLowerCase() : undefined;
    if (host !== undefined && matchesHost(envelope.network, host)) return realFetch(input, init);
    const allowed = envelope.network.length > 0 ? `allows only ${envelope.network.join(', ')}` : 'declares no network access';
    return Promise.reject(
      new Error(`registry item '${envelope.item}' may not fetch ${describeTarget(input)}: its permission manifest ${allowed}.`)
    );
  };
}

/**
 * Installs the two ambient guards exactly once: `globalThis.fetch` checks the
 * current call's envelope against the declared hosts, and `process.env` shows
 * only the declared names. Outside a confined call both pass straight through.
 */
function installGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    Object.defineProperty(globalThis, 'fetch', {
      value: confinedFetch(originalFetch),
      writable: true,
      configurable: true,
    });
  }
  realEnv = process.env;
  process.env = new Proxy(realEnv, envTraps);
}

/** Runs `fn` with `envelope` in force for it and its async continuations. */
function runConfined<T>(envelope: Envelope, fn: () => T): T {
  installGuards();
  return currentEnvelope.run(envelope, fn);
}

/**
 * `execute` may resolve to an async generator (N13b): its body runs when the
 * runtime iterates it, outside this function's own `runConfined` scope, so each
 * `next()` of a wrapping iterator is confined instead.
 */
function confineStream(envelope: Envelope, value: unknown): unknown {
  if (!isPartialStream(value)) return value;
  const inner = value[Symbol.asyncIterator]();
  return (async function* () {
    try {
      for (;;) {
        const step = await runConfined(envelope, () => inner.next());
        if (step.done) return;
        yield step.value;
      }
    } finally {
      await runConfined(envelope, () => inner.return?.(undefined));
    }
  })();
}

/**
 * The approval policy of a tool whose manifest asks for it (`exec: true` or
 * `needsApproval: true`): the call always asks. The tool's own `needsApproval`
 * still runs first so a deny stays a deny; anything else becomes `'ask'`.
 */
function enforcedApproval(own: ToolDescriptor['needsApproval']): NonNullable<ToolDescriptor['needsApproval']> {
  // Enforced: no permission rule or mode turns the 'ask' into a run, and the directory's own approver defers it.
  return enforceApproval(async (args: unknown, ctx: ApprovalCheckContext): Promise<ApprovalOutcome> => {
    const outcome = typeof own === 'function' ? await own(args, ctx) : own;
    if (outcome === 'deny' || (typeof outcome === 'object' && outcome !== null)) return outcome;
    return 'ask';
  });
}

/**
 * The adapter a confined `sandboxExecute` sees: commands need `exec: true`,
 * file writes need `filesystem: "write"`, and a command's environment is the
 * SDK's usual non-secret base plus the declared variables only - never the
 * whole host environment.
 */
function confineSandbox(sandbox: SandboxAdapter, item: RegistryItemStatus): SandboxAdapter {
  const declared = new Set(item.permissions.env ?? []);
  return {
    name: `${sandbox.name}+receipt(${item.name})`,
    async run(cmd: string, args: string[], opts: SandboxRunOptions = {}) {
      if (item.permissions.exec !== true) {
        throw new SDKError(`registry item '${item.name}' does not declare 'exec' in its permission manifest; running '${cmd}' is refused.`, 'LOUSHO_REGISTRY_MANIFEST_MISMATCH');
      }
      const chosen = Object.fromEntries(Object.entries(opts.env ?? {}).filter(([name]) => declared.has(name)));
      // The base set (PATH, HOME, temp dirs) is read from the real environment:
      // inside this call the ambient process.env shows only the declared names.
      const env = commandEnv({ env: chosen }, { host: { env: realEnv, platform: process.platform } });
      return sandbox.run(cmd, args, { ...opts, env, inheritEnv: false });
    },
    async writeFile(file: string, content: string) {
      if (item.permissions.filesystem !== 'write') {
        throw new SDKError(
          `registry item '${item.name}' declares filesystem '${item.permissions.filesystem ?? 'none'}', not 'write'; writing '${file}' is refused.`,
          'LOUSHO_REGISTRY_MANIFEST_MISMATCH'
        );
      }
      return sandbox.writeFile(file, content);
    },
  };
}

/** `tool` bound to `item`'s accepted manifest. The shape (and name) is unchanged; only the behaviour is narrowed. */
function confineTool(tool: DefinedTool, item: RegistryItemStatus): DefinedTool {
  const envelope: Envelope = {
    item: item.name,
    network: (item.permissions.network ?? []).map((host) => host.toLowerCase()),
    env: new Set(item.permissions.env ?? []),
  };
  const execute = (args: unknown, ctx: ToolExecutionContext) =>
    runConfined(envelope, async () => confineStream(envelope, await tool.execute(args as never, ctx)));
  const originalSandboxExecute = tool.sandboxExecute;
  const sandboxExecute =
    originalSandboxExecute === undefined
      ? undefined
      : (args: unknown, sandbox: SandboxAdapter, ctx?: ToolExecutionContext) =>
            runConfined(envelope, () => originalSandboxExecute(args, confineSandbox(sandbox, item), ctx));
  // 'exec' / 'needsApproval' ask for approval by declaration; an unattested item asks too - the stale
  // receipt must not silently certify the modified code, and an approval prompt is what surfaces it.
  const mustAsk = item.status === 'unattested' || item.permissions.exec === true || item.permissions.needsApproval === true;
  const needsApproval = mustAsk ? enforcedApproval(tool.needsApproval) : tool.needsApproval;
  return {
    ...tool,
    execute,
    needsApproval,
    sandboxExecute,
    tool: legacyAiTool(tool.description, tool.input, execute),
  } as DefinedTool;
}

/**
 * Wraps every tool whose source file a receipt item owns, so its calls run
 * inside that item's accepted manifest. Tools and directories the receipt does
 * not cover (the owner's own files, `overrides.tools`) are returned unchanged.
 */
export function confineToolsToReceipt(dir: string, tools: LoadedTool[], status: RegistryStatus | undefined): LoadedTool[] {
  if (status === undefined || status.items.length === 0) return tools;
  const owner = new Map<string, RegistryItemStatus>();
  for (const item of status.items) {
    for (const file of item.files) owner.set(file, item);
  }
  return tools.map((loaded) => {
    const relative = path.relative(dir, loaded.file).split(path.sep).join('/');
    const item = owner.get(relative);
    return item === undefined ? loaded : { ...loaded, tool: confineTool(loaded.tool, item) };
  });
}

/**
 * The directory's own approver, restricted to the calls the receipt does not
 * enforce: it comes from the same directory as the tools, so it may not
 * certify them. An enforced call is deferred - it waits for a human
 * (`agent.approvals.resolve()`) or an approver the host passes in code.
 * `host` is that in-code approver as a sub-agent directory inherits it: it
 * decides the enforced calls (a sub-agent's pause has no `resolve()` handle).
 * Undefined when there is neither an approver nor an enforced call to route.
 */
export function deferEnforcedApprovals(approve: ApproveToolCall | undefined, tools: LoadedTool[], host?: ApproveToolCall): ApproveToolCall | undefined {
  const enforced = new Set(tools.filter((loaded) => hasEnforcedApproval(loaded.tool)).map((loaded) => loaded.tool.name));
  if (enforced.size === 0 || (approve === undefined && host === undefined)) return approve;
  return (request) => {
    if (enforced.has(request.toolName)) return host === undefined ? 'defer' : host(request);
    return approve === undefined ? 'defer' : approve(request);
  };
}
