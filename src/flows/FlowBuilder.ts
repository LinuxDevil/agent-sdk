import { newId } from '../utils/id';
import { EditorStep, AgentFlow, FlowInputVariable } from '../types';
import { SDKError } from '../execution/errors';

/** Throw on the first input variable with a missing or duplicate name. */
function assertUniqueInputNames(inputs: FlowInputVariable[]): void {
  const names = new Set<string>();
  for (const input of inputs) {
    if (!input.name) {
      throw new SDKError('Input variable name is required', 'LOUSHY_FLOW_INVALID');
    }
    if (names.has(input.name)) {
      throw new SDKError(`Duplicate input variable name: ${input.name}`, 'LOUSHY_FLOW_INVALID');
    }
    names.add(input.name);
  }
}

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
      id: this.flow.id || newId(),
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
      throw new SDKError('Flow code is required', 'LOUSHY_FLOW_INVALID');
    }
    if (!this.flow.name) {
      throw new SDKError('Flow name is required', 'LOUSHY_FLOW_INVALID');
    }

    // Validate input variables
    if (this.flow.inputs) {
      assertUniqueInputNames(this.flow.inputs);
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
