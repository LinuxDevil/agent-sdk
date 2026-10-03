import { newId } from '../utils/id';
import { EditorStep, AgentFlow, FlowAgentDefinition, FlowInputVariable } from '../types';
import { SDKError } from '../execution/errors';
import { isCreateAgentResult } from './validators';

/** Throw on the first input variable with a missing or duplicate name. */
function assertUniqueInputNames(inputs: FlowInputVariable[]): void {
  const names = new Set<string>();
  for (const input of inputs) {
    if (!input.name) {
      throw new SDKError('Input variable name is required', 'LOUSHO_FLOW_INVALID');
    }
    if (names.has(input.name)) {
      throw new SDKError(`Duplicate input variable name: ${input.name}`, 'LOUSHO_FLOW_INVALID');
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
   * Add an agent definition. `agent` is a plain
   * `{ name, model, system, tools }` definition (`FlowAgentDefinition`) - a
   * `createAgent()` agent runs itself and is rejected by `build()`.
   */
  public addAgent(agent: FlowAgentDefinition): this {
    if (!this.flow.agents) {
      this.flow.agents = [];
    }
    this.flow.agents.push(agent);
    return this;
  }

  /**
   * Set all agents
   */
  public setAgents(agents: FlowAgentDefinition[]): this {
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
      throw new SDKError('Flow code is required', 'LOUSHO_FLOW_INVALID');
    }
    if (!this.flow.name) {
      throw new SDKError('Flow name is required', 'LOUSHO_FLOW_INVALID');
    }

    // Validate input variables
    if (this.flow.inputs) {
      assertUniqueInputNames(this.flow.inputs);
    }

    // LOU-R14: a createAgent() agent runs itself; `agents` entries are the
    // plain data a flow's steps run under ({ name, model, system, tools }),
    // and its instructions are not readable from a flow. Reject it instead
    // of silently building a flow that drops them.
    for (const agent of this.flow.agents ?? []) {
      if (isCreateAgentResult(agent)) {
        throw new SDKError(
          `FlowBuilder: 'agents' entries are plain { name, model, system, tools } ` +
            `definitions (FlowAgentDefinition), not createAgent() agents - their ` +
            `instructions are not readable from a flow. ` +
            `Example: .addAgent({ name: 'summarizer', model: 'openai/gpt-4o-mini', system: 'You summarize.', tools: [] })`,
          'LOUSHO_FLOW_INVALID'
        );
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
