import { ToolConfiguration } from './tool';
import { AgentFlow } from './flow';

/**
 * Agent settings. `model` is the model id the agent calls (it wins over the
 * provider's default); other keys are kept for the caller.
 */
export interface AgentSettings {
  model?: string;
  [key: string]: unknown;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  id?: string;
  name: string;
  locale?: string;
  prompt?: string;
  expectedResult?: unknown;
  tools?: Record<string, ToolConfiguration>;
  flows?: AgentFlow[];
  events?: unknown[];
  settings?: AgentSettings;
  metadata?: Record<string, unknown>;
}
