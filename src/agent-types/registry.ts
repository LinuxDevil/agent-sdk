import { AgentType, AgentTypeDescriptor } from '../types';

/**
 * Agent types registry
 * Contains all available agent type descriptors
 *
 * @deprecated Has no runtime effect and will be removed in the next minor release.
 */
export const agentTypesRegistry: AgentTypeDescriptor[] = [
  {
    type: AgentType.SmartAssistant,
    description: { en: 'General-purpose agent that can use tools.' },
    supportsUserFacingUI: true,
    requiredTabs: ['prompt', 'expectedResult'],
    displayName: { en: 'Smart assistant [Chat]' },
  },
  {
    type: AgentType.SurveyAgent,
    description: { en: 'Collects information from users and adapts follow-up questions.' },
    supportsUserFacingUI: true,
    requiredTabs: ['prompt', 'expectedResult'],
    displayName: { en: 'Survey agent [Chat]' },
  },
  {
    type: AgentType.CommerceAgent,
    description: { en: 'Sells products or services from a catalog.' },
    supportsUserFacingUI: true,
    requiredTabs: ['prompt', 'expectedResult'],
    displayName: { en: 'Sales assistant [Chat]' },
  },
  {
    type: AgentType.Flow,
    description: { en: 'Runs multi-step scenarios called by an API or other agents.' },
    supportsUserFacingUI: true,
    requiredTabs: [],
    displayName: { en: 'App / Workflow [API]' },
  },
];

/**
 * Get agent type descriptor by type
 *
 * @deprecated Has no runtime effect and will be removed in the next minor release.
 */
export function getAgentTypeDescriptor(type: AgentType): AgentTypeDescriptor | undefined {
  return agentTypesRegistry.find(descriptor => descriptor.type === type);
}

/**
 * Get all agent type descriptors
 *
 * @deprecated Has no runtime effect and will be removed in the next minor release.
 */
export function getAllAgentTypeDescriptors(): AgentTypeDescriptor[] {
  return [...agentTypesRegistry];
}

/**
 * Check if agent type is valid
 *
 * @deprecated Has no runtime effect and will be removed in the next minor release.
 */
export function isValidAgentType(type: string): type is AgentType {
  return agentTypesRegistry.some(descriptor => descriptor.type === type);
}
