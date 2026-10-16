/**
 * Build AI Agent SDK
 * Framework-agnostic SDK for building AI agents
 * 
 * @packageDocumentation
 */

// Version
export { VERSION } from './version';

// The executor API (AgentBuilder, AgentExecutor, resume functions,
// ToolRegistry) moved to '@lousho/build-ai-agent/executor'.

// Type exports
export * from './types';

// Tools (ToolRegistry moved to '@lousho/build-ai-agent/executor')
export * from './tools/rootTools';

// Flows moved to '@lousho/build-ai-agent/flows'.



// Providers
export * from './providers';

// Execution
export * from './execution';

// Evals
export * from './evals';

// Security
export * from './security';

// Storage moved to '@lousho/build-ai-agent/utils'.


// Token estimation and model registry
export * from './models';

// Context compaction
export * from './context';

// Utils: the error helpers stay on the root; encryption, StorageService and
// the validators moved to '@lousho/build-ai-agent/utils'.
export * from './utils/errors';
export * from './utils/errorCodes';

// createAgent() convenience API
export * from './createAgent';
// Also named-re-exported explicitly. Under true-ESM importers that
// consume the TypeScript source through a CJS interop layer (.mts via tsx),
// `export *` barrels are not statically resolvable and their names fail with
// "does not provide an export named 'createAgent'"; an explicit named
// re-export is seen by cjs-module-lexer and imports fine. The bundled dist
// entries are unaffected either way.
export { createAgent } from './createAgent';
// Handoffs: hand the conversation to another agent
export * from './handoffs';
// Who is calling: the helpers live in '@lousho/build-ai-agent/auth'; the type rides in SendOptions.
export type { Principal } from './auth/types';
export type { AgentApprovals, ApproveToolCall, ResolveApprovalOptions } from './createAgentApprovals';
export type { PendingRun } from './agentPending';
export type { RecoverOptions, RunRecovery } from './agentRecover';
// One store for sessions, checkpoints and approvals: createAgent({ store })
export { memoryStore, type AgentStore, type MemoryStoreOptions } from './storage/agentStore';
export { fileStore, type FileStore, type FileStoreOptions, type FileStorePruneOptions, type FileStorePruneResult } from './storage/fileStore';
// OAuth token storage: AgentStore.tokens
export * from './oauth';

// Sessions: multi-turn conversations for createAgent()
export * from './session';

// AGENTS.md / CLAUDE.md auto-loading
export * from './projectInstructions';

// Skills: progressive disclosure of instructions
export * from './skills';

// Memory slots: scoped long-term memory for createAgent()
export * from './memory';
// kvMemory(): a memory provider bound to the Worker's KV namespace at request
// time, for the memory/ files of a cloudflare-worker agent directory (#298).
export { kvMemory, type KVMemoryOptions } from './deploy/workerMemory';

// Sub-agents: the `subagents` option and its `task` tool
export * from './subagents';

// Filesystem agent loader: an agent as a directory
export * from './agentDir';

// Claude-Code-compatible project context (CLAUDE.md, .claude/{skills,agents,rules,scratchpad})
export * from './claude';

export * from './decisions';

// Schedules: defineSchedule() and startSchedules()
export * from './schedules';

// Channels: inbound surfaces mapped to sessions, replies back to the surface
export * from './channels';

// Agent Client Protocol server for editors such as Zed (`lousho acp`)
export { serveAcp, type ServeAcpOptions } from './acp/serveAcp';

// Declarative agent spec file format
export * from './spec';

// Deployment adapter registry. Only the interface + registry are
// exported here; the built-in adapters (node-server, cloudflare-worker,
// docker) are wired up by the `lousho build` CLI (src/cli/build.ts).
export * from './deploy/types';

// AI SDK UI stream adapter: Fetch/Worker-safe, no node:* imports.
export * from './server/uiMessageStream';

// Route handler for Next.js and other Fetch-API frameworks.
export * from './server/routeHandler';
