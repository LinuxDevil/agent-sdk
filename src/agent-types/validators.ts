import { AgentConfig, AgentType } from '../types';

function isBlank(value: string | undefined): boolean {
  return !value || value.trim() === '';
}

/**
 * Validate agent configuration
 *
 * `agentType` is optional; it is only checked when present.
 *
 * @deprecated Has no runtime effect and will be removed in the next minor release.
 */
export function validateAgentConfig(config: Partial<AgentConfig>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (isBlank(config.name)) {
    errors.push(
      "Agent name is required. Example: AgentBuilder.create().setName('my-agent')...build()"
    );
  }

  if (config.agentType !== undefined && !Object.values(AgentType).includes(config.agentType)) {
    errors.push(`Invalid agent type: ${config.agentType}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate agent tools configuration
 *
 * @deprecated Has no runtime effect and will be removed in the next minor release.
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
