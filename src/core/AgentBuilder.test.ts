import { describe, it, expect } from 'vitest';
import { AgentBuilder } from './AgentBuilder';

describe('AgentBuilder', () => {
  it('should throw error when name is missing', () => {
    expect(() => {
      new AgentBuilder().build();
    }).toThrow('Agent name is required');
  });

  it('builds an agent with a name only', () => {
    const agent = new AgentBuilder().setName('Test Agent').build();

    expect(agent.name).toBe('Test Agent');
    expect(agent.id).toBeDefined();
    expect(agent.locale).toBe('en');
  });

  it('names the missing field and shows a corrective snippet (LOU-H12)', () => {
    expect(() => {
      new AgentBuilder().build();
    }).toThrow(/Agent name is required\. Example: AgentBuilder\.create\(\)\.setName\('my-agent'\)/);
  });

  it('should add tools correctly', () => {
    const agent = new AgentBuilder()
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

  it('rejects a tool entry without a `tool` property (LOUSHO_VALIDATION_FAILED)', () => {
    expect(() => {
      new AgentBuilder()
        .setName('Test Agent')
        .setTools({ calendar: {} as never })
        .build();
    }).toThrow(expect.objectContaining({ code: 'LOUSHO_VALIDATION_FAILED' }));
    expect(() => {
      new AgentBuilder()
        .setName('Test Agent')
        .setTools({ calendar: {} as never })
        .build();
    }).toThrow("Tool configuration for 'calendar' is missing 'tool' property");
  });

  it('should remove tools correctly', () => {
    const agent = new AgentBuilder()
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
      .setName('Test Agent')
      .setId(customId)
      .build();

    expect(agent.id).toBe(customId);
  });

  it('should set locale', () => {
    const agent = new AgentBuilder()
      .setName('Test Agent')
      .setLocale('ar')
      .build();

    expect(agent.locale).toBe('ar');
  });

  it('should set metadata', () => {
    const metadata = { key: 'value', number: 123 };
    const agent = new AgentBuilder()
      .setName('Test Agent')
      .setMetadata(metadata)
      .build();

    expect(agent.metadata).toEqual(metadata);
  });

  it('should load from existing config', () => {
    const existingConfig = {
      id: 'existing-id',
      name: 'Existing Agent',
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
    expect(agent.prompt).toBe('Existing prompt');
  });

  it('should create using static create method', () => {
    const builder = AgentBuilder.create();
    expect(builder).toBeInstanceOf(AgentBuilder);
  });
});
