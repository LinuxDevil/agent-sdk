import { CoreMessage } from 'ai';
import { ToolConfiguration } from './tool';
import { AgentFlow } from './flow';

/**
 * Agent type identifiers
 */
export enum AgentType {
  SmartAssistant = 'smart-assistant',
  SurveyAgent = 'survey-agent',
  CommerceAgent = 'commerce-agent',
  Flow = 'flow',
}

/**
 * Agent type descriptor
 */
export interface AgentTypeDescriptor {
  type: AgentType;
  description: Record<string, string>;
  requiredTabs: string[];
  supportsUserFacingUI: boolean;
  displayName: Record<string, string>;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  id?: string;
  name: string;
  agentType: AgentType;
  locale?: string;
  prompt?: string;
  expectedResult?: any;
  tools?: Record<string, ToolConfiguration>;
  flows?: AgentFlow[];
  events?: any[];
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
}

/**
 * Agent execution options
 */
export interface AgentExecutionOptions {
  streaming?: boolean;
  sessionId: string;
  messages: CoreMessage[];
  attachments?: any[];
  locale?: string;
  timezone?: string;
  currentDateTime?: string;
}

/**
 * Agent execution result
 */
export interface AgentExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
  sessionId: string;
  tokensUsed?: number;
  duration?: number;
}

/**
 * Agent definition for flows
 */
export interface AgentDefinition {
  name: string;
  id?: string;
  model: string;
  system: string;
  tools: ToolSetting[];
}

/**
 * Tool setting in agent definition
 */
export interface ToolSetting {
  name: string;
  options: any;
}
