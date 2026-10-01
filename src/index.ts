/**
 * Build AI Agent SDK
 * Framework-agnostic SDK for building AI agents
 * 
 * @packageDocumentation
 */

// Version
export const VERSION = '1.0.0-alpha.8';

// Core exports
export * from './core';

// Type exports
export * from './types';

// Agent types
export * from './agent-types';

// Tools
export * from './tools';

// Flows
export * from './flows';

// Data
export * from './data';

// Providers
export * from './providers';

// Execution
export * from './execution';

// Evals
export * from './evals';

// Security
export * from './security';

// Storage
export * from './storage';

// Templates
export * from './templates';

// Token estimation and model registry (LOU-W1)
export * from './models';

// Context compaction (LOU-W2)
export * from './context';

// Utils
export * from './utils';

// createAgent() convenience API (LOU-H1)
export * from './createAgent';
export type { AgentApprovals, ApproveToolCall } from './createAgentApprovals';
// One store for sessions, checkpoints and approvals: createAgent({ store }) (LOU-D30)
export { memoryStore, type AgentStore, type MemoryStoreOptions } from './storage/agentStore';

// Sessions: multi-turn conversations for createAgent() (LOU-W4)
export * from './session';

// AGENTS.md / CLAUDE.md auto-loading (LOU-W7)
export * from './projectInstructions';

// Skills: progressive disclosure of instructions (LOU-Y2)
export * from './skills';

// Memory slots: scoped long-term memory for createAgent() (LOU-W6)
export * from './memory';

// Sub-agents: the `subagents` option and its `task` tool (LOU-Y3)
export * from './subagents';

// Filesystem agent loader: an agent as a directory (LOU-Y5)
export * from './agentDir';

// Schedules: defineSchedule() and startSchedules() (LOU-P8)
export * from './schedules';

// Channels: inbound surfaces mapped to sessions, replies back to the surface (LOU-P7)
export * from './channels';

// Agent Client Protocol server for editors such as Zed (`loushy acp`, LOU-Z6)
export { serveAcp, type ServeAcpOptions } from './acp/serveAcp';

// Declarative agent spec file format (LOU-H9)
export * from './spec';

// Deployment adapter registry (LOU-I1). Only the interface + registry are
// exported here; the built-in adapters (node-server, cloudflare-worker,
// docker) are wired up by the `loushy build` CLI (src/cli/build.ts).
export * from './deploy/types';

// AI SDK UI stream adapter (LOU-P1): Fetch/Worker-safe, no node:* imports.
export * from './server/uiMessageStream';

// Route handler for Next.js and other Fetch-API frameworks (LOU-P4).
export * from './server/routeHandler';
