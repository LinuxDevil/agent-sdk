# 0001-sandboxing: isolated tool execution

## Summary

A driver interface for running untrusted tool code outside the agent's own process context. v1 ships an `isolated-vm` driver (in process V8 isolate); the seam leaves room for Docker or E2B sidecars later.

## Decision

`sandbox({ driver })` is a public API: a driver runs a function or module in an isolated context with controlled globals and a result channel. `defineTool` gains an optional `sandbox` field so a tool can declare it runs isolated. The `isolate` driver wraps `isolated-vm`; it is an optional dependency, so core users never install it.

## Surface

```ts
const box = sandbox({ driver: 'isolate', memoryMb: 128, timeoutMs: 5_000 });
const result = await box.run(userCode, { args: [input] });
// run(code: string, opts?): Promise<unknown> — code and args cross the
// boundary by structured clone; the returned value must clone back.
```

- `driver`: `'isolate'` in v1; `'docker'` and `'e2b'` reserved.
- `memoryMb`, `timeoutMs`: resource guards enforced by the driver; a timeout or OOM kill maps to an observation with `status: "error"` and `sandbox.error` (`timeout` | `oom` | `driver`) in `attrs`.
- Sandbox runs emit `observations` of kind `tool` with `sandbox.driver` in `attrs`, so isolated execution shows in traces.
- Stated plainly on the API: `isolate` is an *execution* boundary, not a security boundary; an OOM can take the host process. Do not run code you would not run yourself; hostile code needs the future container driver.

## Deferred to its FEATURE spec

- The capability model inside the isolate (which globals and modules reach it; default deny list).
- Whether `pc_*` style machine tools can ever route through a sandbox (probably never; they are the host by design).
- Docker and E2B driver contracts.

## Rationale

`isolated-vm` is the fast in process isolate and is maintained, though in maintenance mode with known limits (no multi process isolation, OOM can crash the host) (basis: landscape check). That is acceptable for "run this LLM written snippet" cases and unacceptable for truly hostile code, which is exactly why the driver seam matters more than the engine: swapping to containers is a config change, not an API break (basis: TanStack AI isolate driver pattern).
