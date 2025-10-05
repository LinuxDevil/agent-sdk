import { describe, it, expect } from 'vitest';
import { AgentBuilder } from './AgentBuilder';
import { AgentType } from '../types';

describe('AgentBuilder', () => {
  it('should build a basic agent', () => {
    const agent = new AgentBuilder()
      .setType(AgentType.SmartAssistant)
      .setName('Test Agent')
      .setPrompt('You are a test agent')
      .build();

    expect(agent.name).toBe('Test Agent');
    expect(agent.agentType).toBe(AgentType.SmartAssistant);
    expect(agent.prompt).toBe('You are a test agent');
    expect(agent.id).toBeDefined();
    expect(agent.locale).toBe('en');
  });

  it('should throw error when name is missing', () => {
    expect(() => {
      new AgentBuilder()
        .setType(AgentType.SmartAssistant)
        .build();
    }).toThrow('Agent name is required');
  });

  it('should throw error when type is missing', () => {
    expect(() => {
      new AgentBuilder()
        .setName('Test Agent')
        .build();
    }).toThrow('Agent type is required');
  });

  it('should add tools correctly', () => {
    const agent = new AgentBuilder()
      .setType(AgentType.SmartAssistant)
      .setName('Test Agent')
      .addTool('calendar', {
        tool: 'calendarSchedule',
        options: { timezone: 'UTC' }
      })
      .build();

    expect(agent.tools).toHaveProperty('calendar');
    expect(agent.tools!.calendar.tool).toBe('calendarSchedule');
    expect(agent.tools!.calendar.options).toEqual({ timezone: 'UTC' });
  });

  it('should remove tools correctly', () => {
    const agent = new AgentBuilder()
      .setType(AgentType.SmartAssistant)
      .setName('Test Agent')
      .addTool('calendar', {
        tool: 'calendarSchedule',
        options: {}
      })
      .removeTool('calendar')
      .build();

    expect(agent.tools).not.toHaveProperty('calendar');
  });

  it('should set custom ID', () => {
    const customId = 'my-custom-id';
    const agent = new AgentBuilder()
      .setType(AgentType.SmartAssistant)
      .setName('Test Agent')
      .setId(customId)
      .build();

    expect(agent.id).toBe(customId);
  });

  it('should set locale', () => {
    const agent = new AgentBuilder()
      .setType(AgentType.SmartAssistant)
      .setName('Test Agent')
      .setLocale('ar')
      .build();

    expect(agent.locale).toBe('ar');
  });

  it('should set metadata', () => {
    const metadata = { key: 'value', number: 123 };
    const agent = new AgentBuilder()
      .setType(AgentType.SmartAssistant)
      .setName('Test Agent')
      .setMetadata(metadata)
      .build();

    expect(agent.metadata).toEqual(metadata);
  });

  it('should load from existing config', () => {
    const existingConfig = {
      id: 'existing-id',
      name: 'Existing Agent',
      agentType: AgentType.SurveyAgent,
      locale: 'en',
      prompt: 'Existing prompt',
      tools: {},
      flows: [],
      events: [],
      settings: {},
      metadata: {}
    };

    const agent = AgentBuilder.from(existingConfig).build();

    expect(agent.id).toBe('existing-id');
    expect(agent.name).toBe('Existing Agent');
    expect(agent.agentType).toBe(AgentType.SurveyAgent);
  });

  it('should create using static create method', () => {
    const builder = AgentBuilder.create();
    expect(builder).toBeInstanceOf(AgentBuilder);
  });
});
