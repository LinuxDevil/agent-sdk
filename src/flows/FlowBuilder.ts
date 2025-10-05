import { nanoid } from 'nanoid';
import { EditorStep, AgentFlow, FlowInputVariable } from '../types';

/**
 * FlowBuilder
 * Fluent API for building flow definitions
 */
export class FlowBuilder {
  private flow: Partial<AgentFlow> = {};

  /**
   * Set flow ID
   */
  public setId(id: string): this {
    this.flow.id = id;
    return this;
  }

  /**
   * Set flow code (unique identifier)
   */
  public setCode(code: string): this {
    this.flow.code = code;
    return this;
  }

  /**
   * Set flow name
   */
  public setName(name: string): this {
    this.flow.name = name;
    return this;
  }

  /**
   * Set flow description
   */
  public setDescription(description: string): this {
    this.flow.description = description;
    return this;
  }

  /**
   * Add an input variable
   */
  public addInput(input: FlowInputVariable): this {
    if (!this.flow.inputs) {
      this.flow.inputs = [];
    }
    this.flow.inputs.push(input);
    return this;
  }

  /**
   * Set all input variables
   */
  public setInputs(inputs: FlowInputVariable[]): this {
    this.flow.inputs = inputs;
    return this;
  }

  /**
   * Set the flow definition
   */
  public setFlow(flow: EditorStep): this {
    this.flow.flow = flow;
    return this;
  }

  /**
   * Add an agent definition
   */
  public addAgent(agent: any): this {
    if (!this.flow.agents) {
      this.flow.agents = [];
    }
    this.flow.agents.push(agent);
    return this;
  }

  /**
   * Set all agents
   */
  public setAgents(agents: any[]): this {
    this.flow.agents = agents;
    return this;
  }

  /**
   * Build the flow
   */
  public build(): AgentFlow {
    this.validate();

    return {
      id: this.flow.id || nanoid(),
      code: this.flow.code!,
      name: this.flow.name!,
      description: this.flow.description,
      inputs: this.flow.inputs || [],
      flow: this.flow.flow,
      agents: this.flow.agents || [],
    };
  }

  /**
   * Validate the flow configuration
   */
  private validate(): void {
    if (!this.flow.code) {
      throw new Error('Flow code is required');
    }
    if (!this.flow.name) {
      throw new Error('Flow name is required');
    }

    // Validate input variables
    if (this.flow.inputs) {
      const names = new Set<string>();
      for (const input of this.flow.inputs) {
        if (!input.name) {
          throw new Error('Input variable name is required');
        }
        if (names.has(input.name)) {
          throw new Error(`Duplicate input variable name: ${input.name}`);
        }
        names.add(input.name);
      }
    }
  }

  /**
   * Create a builder from existing flow
   */
  public static from(flow: AgentFlow): FlowBuilder {
    const builder = new FlowBuilder();
    builder.flow = { ...flow };
    return builder;
  }

  /**
   * Create a new builder instance
   */
  public static create(): FlowBuilder {
    return new FlowBuilder();
  }
}
