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

// Utils
export * from './utils';

// createAgent() convenience API (LOU-H1)
export * from './createAgent';

// Skills: progressive disclosure of instructions (LOU-Y2)
export * from './skills';

// Declarative agent spec file format (LOU-H9)
export * from './spec';

// Deployment adapter registry (LOU-I1). Only the interface + registry are
// exported here; the built-in adapters (node-server, cloudflare-worker,
// docker) are wired up by the `loushy build` CLI (src/cli/build.ts).
export * from './deploy/types';
