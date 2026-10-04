import { AgentFlow, FlowAgentDefinition } from '../types/flow';

/**
 * Whether `value` is a `createAgent()` result (a `SimpleAgent`): a live agent
 * that runs itself through `send()`/`stream()`, not a plain data config.
 * Flow APIs take plain data - `FlowExecutionContext.agent` is an
 * `AgentConfig` (`{ name, prompt?, settings }`) and `FlowBuilder.addAgent` a
 * `FlowAgentDefinition` (`{ name, model, system, tools }`) - so a SimpleAgent
 * passed to either was silently accepted while its instructions were dropped
 * (LOU-R14). Both reject it with a coded `SDKError` instead.
 */
export function isCreateAgentResult(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { send?: unknown }).send === 'function';
}

/**
 * Errors for a missing or already-seen name. Records the name in `seen` so later
 * duplicates are caught. `label` is e.g. "Agent" or "Input variable".
 */
function uniqueNameErrors(name: string | undefined, seen: Set<string>, label: string): string[] {
  if (!name) {
    return [`${label} name is required`];
  }
  const errors = seen.has(name) ? [`Duplicate ${label.toLowerCase()} name: ${name}`] : [];
  seen.add(name);
  return errors;
}

function validateInputVariables(inputs: AgentFlow['inputs'] | undefined): string[] {
  if (!inputs) return [];

  const errors: string[] = [];
  const names = new Set<string>();
  for (const input of inputs) {
    errors.push(...uniqueNameErrors(input.name, names, 'Input variable'));

    if (!input.type) {
      errors.push(`Input variable '${input.name}' must have a type`);
    }
  }
  return errors;
}

function validateAgentEntry(agent: FlowAgentDefinition, agentNames: Set<string>): string[] {
  const errors = uniqueNameErrors(agent.name, agentNames, 'Agent');

  if (!agent.model) {
    errors.push(`Agent '${agent.name}' must have a model specified`);
  }

  if (!agent.system) {
    errors.push(`Agent '${agent.name}' must have a system prompt`);
  }
  return errors;
}

function validateAgents(agents: AgentFlow['agents'] | undefined): string[] {
  if (!agents) return [];

  const agentNames = new Set<string>();
  return agents.flatMap((agent) => validateAgentEntry(agent, agentNames));
}

/**
 * Validate flow configuration
 */
export function validateFlow(flow: Partial<AgentFlow>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!flow.code) {
    errors.push('Flow code is required');
  }

  if (!flow.name) {
    errors.push('Flow name is required');
  }

  errors.push(...validateInputVariables(flow.inputs), ...validateAgents(flow.agents));

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate agent definition
 */
export function validateAgentDefinition(agent: Partial<FlowAgentDefinition>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!agent.name) {
    errors.push('Agent name is required');
  }

  if (!agent.model) {
    errors.push('Agent model is required');
  }

  if (!agent.system) {
    errors.push('Agent system prompt is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
