/**
 * Sandboxed execution of user-authored hook code (LOU-Q2).
 *
 * A hook's `code` (edited in the Inspector's CodeMirror editor, see
 * src/hooks/hookTemplates.ts and graph/types.ts's `AgentNodeHookInstance`)
 * is arbitrary JS a user typed into this local dev tool. It must NOT run
 * with full host privileges in this process - the same constraint LOU-K2
 * already solved for tool execution (see src/tools/built-in/sandboxFetch.ts
 * in the core SDK for the established pattern this file follows).
 *
 * Rather than inventing a second, unsandboxed eval path, this reuses the
 * exact same seam: a `SandboxAdapter` (src/security/sandboxCore.ts)'s
 * `run()` method. The hook's code and its (JSON-serializable) `ctx` are
 * base64-JSON-encoded into an env var, and a small Node one-liner run via
 * `sandbox.run('node', ['-e', SCRIPT], ...)` wraps the code as an async
 * function body, invokes it with `ctx`, and prints the returned ctx as one
 * JSON line on stdout - mirroring sandboxHttpFetch()'s
 * encode-request/run-child/decode-response shape precisely.
 *
 * Under NoopSandbox (this server's default, zero-isolation adapter) this
 * still only grants the hook whatever a plain child `node` process can do
 * on this host - not full access to this server process's memory/state -
 * and a real isolation backend (SubprocessSandbox/Docker, LOU-F6) gets a
 * chance to mediate it exactly like it would for a sandboxed tool.
 */

import type { SandboxAdapter } from '@lousho/build-ai-agent';

/** Generic ctx payload shape a hook script receives/returns (LOU-Q1's HookContext family, minus non-serializable fields like `messages`/`toolCall`). */
export type HookSandboxCtx = Record<string, unknown>;

/**
 * Node one-liner run inside the sandbox. Reads `{code, ctx}` from
 * AGENT_FORGE_HOOK_REQUEST, builds `async function __hook(ctx) { <code> }`
 * via the Function constructor (NOT eval - same reasoning as
 * sandboxFetch.ts's script: this runs in its own disposable child process,
 * not this server's process), calls it with `ctx`, and writes exactly one
 * JSON line - the hook's returned ctx (or the original ctx, if the hook
 * mutated it in place and returned nothing) - to stdout.
 */
const HOOK_SCRIPT = `
const req = JSON.parse(Buffer.from(process.env.AGENT_FORGE_HOOK_REQUEST, 'base64').toString('utf-8'));
(async () => {
  try {
    const fn = new Function('ctx', 'return (async () => {\\n' + req.code + '\\n})();');
    const returned = await fn(req.ctx);
    const result = (returned && typeof returned === 'object') ? returned : req.ctx;
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(String((error && error.stack) || error));
    process.exitCode = 1;
  }
})();
`;

export interface HookSandboxOptions {
  /** Milliseconds before the sandboxed hook execution is killed. Defaults to 5s - hooks are meant to be small, fast, synchronous-feeling checks. */
  timeoutMs?: number;
}

/**
 * Runs `code` (a hook's function BODY - see AgentNodeHookInstance.code) as
 * `async (ctx) => { ...code...; }` inside `sandbox`, and resolves with the
 * (possibly mutated/replaced) `ctx` it returns.
 *
 * Throws (never resolves to a value carrying an error) if the sandboxed
 * process exits non-zero or its stdout isn't parsable JSON - matching this
 * codebase's fail-loud philosophy for hook errors (see HookRegistry's doc
 * comment in the core SDK: a hook error must abort the step, not be
 * silently swallowed).
 */
export async function sandboxRunHook(
  sandbox: SandboxAdapter,
  code: string,
  ctx: HookSandboxCtx,
  options: HookSandboxOptions = {}
): Promise<HookSandboxCtx> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const encoded = Buffer.from(JSON.stringify({ code, ctx }), 'utf-8').toString('base64');

  const result = await sandbox.run('node', ['-e', HOOK_SCRIPT], {
    env: { AGENT_FORGE_HOOK_REQUEST: encoded },
    timeoutMs,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Sandboxed hook failed: ${result.stderr || `exit code ${result.exitCode}`}`);
  }

  try {
    return JSON.parse(result.stdout) as HookSandboxCtx;
  } catch {
    throw new Error(`Sandboxed hook returned unparsable output: ${result.stdout}`);
  }
}
