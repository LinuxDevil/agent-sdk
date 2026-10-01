/**
 * LOU-T2: the `env` binding name a Worker deployment must declare (in
 * `wrangler.toml`, see `adapters/cloudflare.ts`'s scaffolded config) to opt
 * in to durable execution - a KV namespace bound under this name lets a
 * paused run's Checkpoint survive across requests/isolates, the same way a
 * filesystem- or StorageService-backed CheckpointStore does off-Worker (see
 * LocalStorageCheckpointStore in src/execution/checkpoint.ts and
 * apps/agent-forge/server/checkpointStore.ts's FileCheckpointStore).
 * Mirrors `providerEnvKey()` in runtime.worker.ts: a documented, fixed
 * binding name a consumer wires up themselves rather than something this SDK
 * provisions for them.
 *
 * Lives in its own dependency-free module so both the Node-side cloudflare
 * scaffold and the Node-free Worker runtime can share one definition.
 */
export const CHECKPOINT_KV_BINDING = 'AGENT_CHECKPOINTS';
