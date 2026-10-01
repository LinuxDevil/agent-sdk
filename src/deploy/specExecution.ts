/**
 * Turns a validated AgentSpec into the per-request-invariant part of
 * AgentExecutor.execute()'s ExecuteOptions (LOU-I2/I3).
 *
 * Deliberately free of Node builtins (and of any provider/tool module):
 * the provider and tool resolvers are injected, so the Node runtime
 * (src/deploy/runtime.ts) and the Cloudflare Worker runtime
 * (src/deploy/runtime.worker.ts) share this one mapping while each
 * resolving providers/tools in a way that works on its own platform.
 */
import { AgentBuilder } from '../core/AgentBuilder';
import { ToolConfiguration, ToolDescriptor } from '../types';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ExecuteOptions } from '../execution/AgentExecutor';
import { LLMProvider } from '../providers/llm';
import { AgentSpec } from '../spec/schema';

export interface SpecResolvers {
  resolveProvider: (type: string, model: string) => LLMProvider;
  resolveTool: (name: string) => ToolDescriptor;
}

export type PreparedExecution = Pick<ExecuteOptions, 'agent' | 'provider' | 'toolRegistry'>;

export function prepareSpecExecution(spec: AgentSpec, resolvers: SpecResolvers): PreparedExecution {
  const provider = resolvers.resolveProvider(spec.provider.type, spec.provider.model);

  const toolNames = spec.tools || [];
  let toolRegistry: ToolRegistry | undefined;
  const toolsConfig: Record<string, ToolConfiguration> = {};
  if (toolNames.length > 0) {
    toolRegistry = new ToolRegistry();
    for (const name of toolNames) {
      toolRegistry.register(name, resolvers.resolveTool(name));
      toolsConfig[name] = { tool: name };
    }
  }

  const agent = AgentBuilder.create()
    .setName(spec.name)
    .setPrompt(spec.prompt)
    .setTools(toolsConfig)
    .build();

  return { agent, provider, toolRegistry };
}
