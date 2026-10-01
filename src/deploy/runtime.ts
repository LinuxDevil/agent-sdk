/**
 * Node runtime for generated deployment servers (LOU-I2/I4, LOU-D14).
 *
 * The server.ts that the node-server/docker adapters scaffold imports
 * `@loushy/build-ai-agent/deploy-runtime`; at build time that import is
 * resolved to this file (see sdkRuntimePlugin in ./bundle.ts) and bundled
 * into dist/server.js, so the built server is self-contained.
 *
 * Provider/tool resolution is exactly specToAgent()'s (and so `loushy
 * dev`'s): real providers via resolveProvider() + env vars, 'mock' via
 * LLMProviderRegistry (importing specToAgent also registers 'mock').
 */
export { agentSpecSchema } from '../spec/schema';
export type { AgentSpec } from '../spec/schema';
export { createDeployedAgent, createDeployedServer, storeFromEnv } from './nodeServer';
export { createAgent } from '../createAgent';
export { resolveAgentDir } from '../agentDir';
export type { DeployedServerOptions } from './nodeServer';
