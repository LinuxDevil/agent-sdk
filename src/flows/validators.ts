import { AgentFlow, FlowAgentDefinition } from '../types';

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

  // Validate input variables
  if (flow.inputs) {
    const names = new Set<string>();
    for (const input of flow.inputs) {
      if (!input.name) {
        errors.push('Input variable name is required');
      } else {
        if (names.has(input.name)) {
          errors.push(`Duplicate input variable name: ${input.name}`);
        }
        names.add(input.name);
      }

      if (!input.type) {
        errors.push(`Input variable '${input.name}' must have a type`);
      }
    }
  }

  // Validate agents
  if (flow.agents) {
    const agentNames = new Set<string>();
    for (const agent of flow.agents) {
      if (!agent.name) {
        errors.push('Agent name is required');
      } else {
        if (agentNames.has(agent.name)) {
          errors.push(`Duplicate agent name: ${agent.name}`);
        }
        agentNames.add(agent.name);
      }

      if (!agent.model) {
        errors.push(`Agent '${agent.name}' must have a model specified`);
      }

      if (!agent.system) {
        errors.push(`Agent '${agent.name}' must have a system prompt`);
      }
    }
  }

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
