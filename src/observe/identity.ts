/**
 * Reporter identity: the stable `agent_id` and fallback `session_id` a
 * reporting process carries across restarts.
 *
 * - `agent_id` is a generated UUID persisted in the PROJECT's `.lousho/`
 *   directory (not `~/.lousho` - reporters run in arbitrary project dirs):
 *   `.lousho/identity/<name>@<project>.json`. Same agent + project + dir →
 *   same identity, so a restarted process keeps its registry row.
 * - `session_id` is `sha256(agent_id + cwd)` kept in the same file: it only
 *   applies to spans that carry no `gen_ai.conversation.id` (non-session
 *   runs), and it is what lets a restarted process rejoin its own session
 *   stream.
 *
 * This module is imported by `createAgent`/`AgentExecutor`, which also ship
 * in the Worker bundle - so the fs/crypto/os/path builtins are loaded
 * lazily through `process.getBuiltinModule` (the sqlite driver's pattern),
 * and every node-only feature degrades to an in-memory identity instead of
 * breaking non-Node runtimes.
 */

/** The slices of the builtins used here, typed so the lazy loads stay honest. */
interface FsLike {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string, encoding: 'utf8'): void;
}
interface CryptoLike {
  createHash(name: 'sha256'): { update(text: string): { digest(enc: 'hex'): string } };
}
interface OsLike {
  hostname(): string;
}
interface PathLike {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}

// Named to match the worker leak check's exempted call pattern (see
// WORKER_SAFE_BUILTIN_PROBE in src/deploy/adapters/cloudflare.ts): the
// the builtin id literals below stay out of the flagged set only while they
// appear as this function's argument. Do not rename.
function getBuiltinModule<T>(name: string): T | undefined {
  // Reporters bundled for non-Node runtimes have no fs; identity falls back to memory.
  if (typeof process === 'undefined') return undefined;
  return (process.getBuiltinModule?.(name) as T | undefined) ?? undefined;
}

const lazyFs = () => getBuiltinModule('node:fs') as FsLike | undefined;
const lazyCrypto = () => getBuiltinModule('node:crypto') as CryptoLike | undefined;
const lazyOs = () => getBuiltinModule('node:os') as OsLike | undefined;
const lazyPath = () =>
  (getBuiltinModule('node:path') as PathLike | undefined) ?? {
        // POSIX-join fallback for runtimes without the path builtin (identity paths are relative anyway).
    join: (...parts: string[]) => parts.filter(Boolean).join('/'),
    resolve: (p: string) => p,
  };

/** `<name>@<project>` made safe for a file name (`:` is illegal on Windows, `/` is a separator). */
function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
}

/** FNV-1a, for when the crypto builtin is unavailable; session ids are labels, not secrets. */
function fallbackHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').repeat(4);
}

function sha256Hex(text: string): string {
  const crypto = lazyCrypto();
  if (crypto) return crypto.createHash('sha256').update(text).digest('hex');
  return fallbackHash(text);
}

export interface ReporterIdentity {
  agentId: string;
  /** The fallback `session_id` for observations that carry no `gen_ai.conversation.id`. */
  sessionId: string;
  project: string;
  /** The identity file, when the fs was available to persist it. */
  file?: string;
}

const memoryIdentities = new Map<string, ReporterIdentity>();

/**
 * The project label on every row this reporter emits:
 * `LOUSHO_OBSERVE_PROJECT` (pass it in), else the cwd's package.json `name`,
 * else 'default'.
 */
export function resolveProject(envProject: string | undefined, cwd: string): string {
  if (envProject) return envProject;
  const fs = lazyFs();
  const p = lazyPath();
  if (fs) {
    try {
      const pkgFile = p.join(cwd, 'package.json');
      if (fs.existsSync(pkgFile)) {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { name?: unknown };
        if (typeof pkg.name === 'string' && pkg.name) return pkg.name;
      }
    } catch {
      // an unreadable package.json is no reason to lose telemetry
    }
  }
  return 'default';
}

function dirnameOf(file: string): string {
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return slash > 0 ? file.slice(0, slash) : '.';
}

/**
 * Load or mint this agent's identity under `<cwd>/.lousho/identity/`. The
 * file is written once; two reporters of one process share the in-memory map
 * so they agree even before the first flush.
 */
export function resolveIdentity(options: { name: string; project: string; cwd: string }): ReporterIdentity {
  const key = `${options.name}@${options.project}@${options.cwd}`;
  const cached = memoryIdentities.get(key);
  if (cached) return cached;

  const fs = lazyFs();
  const p = lazyPath();
  const file = fs
    ? p.join(p.resolve(options.cwd), '.lousho', 'identity', `${safeFilePart(options.name)}@${safeFilePart(options.project)}.json`)
    : undefined;

  if (fs && file) {
    try {
      if (fs.existsSync(file)) {
        const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { agent_id?: unknown; session_id?: unknown };
        if (typeof stored.agent_id === 'string' && stored.agent_id) {
          const identity: ReporterIdentity = {
            agentId: stored.agent_id,
            sessionId:
              typeof stored.session_id === 'string' && stored.session_id
                ? stored.session_id
                : sha256Hex(`${stored.agent_id}:${options.cwd}`),
            project: options.project,
            file,
          };
          memoryIdentities.set(key, identity);
          return identity;
        }
      }
    } catch {
      // a corrupt identity file is replaced, never fatal
    }
  }

  const agentId = globalThis.crypto.randomUUID();
  const identity: ReporterIdentity = {
    agentId,
    sessionId: sha256Hex(`${agentId}:${options.cwd}`),
    project: options.project,
    ...(file ? { file } : {}),
  };
  if (fs && file) {
    try {
      fs.mkdirSync(dirnameOf(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ agent_id: identity.agentId, session_id: identity.sessionId }, null, 2), 'utf8');
    } catch (error) {
      // A lost identity means this process re-registers as a new agent on restart: warn, never throw into a run.
      console.warn(
        `[lousho] observe: could not persist agent identity at ${file} (${error instanceof Error ? error.message : String(error)}); this process re-registers as a new agent on restart.`
      );
    }
  }
  memoryIdentities.set(key, identity);
  return identity;
}

/** `os.hostname()` when the runtime has it. */
export function hostName(): string | undefined {
  try {
    return lazyOs()?.hostname();
  } catch {
    return undefined;
  }
}
