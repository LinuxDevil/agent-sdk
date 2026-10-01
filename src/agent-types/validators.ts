import { AgentConfig, AgentType } from '../types';

function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === '';
}

/**
 * Validate agent configuration
 */
export function validateAgentConfig(config: Partial<AgentConfig>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (isBlank(config.name)) {
    errors.push(
      "Agent name is required. Example: AgentBuilder.create().setName('my-agent')...build()"
    );
  }

  if (!config.agentType) {
    errors.push(
      'Agent type is required. Example: AgentBuilder.create().setType(AgentType.SmartAssistant)...build()'
    );
  } else if (!Object.values(AgentType).includes(config.agentType)) {
    errors.push(`Invalid agent type: ${config.agentType}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate agent tools configuration
 */
export function validateAgentTools(tools: Record<string, any>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const [key, config] of Object.entries(tools)) {
    if (!config.tool) {
      errors.push(`Tool configuration for '${key}' is missing 'tool' property`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
