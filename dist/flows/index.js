'use strict';

var nanoid = require('nanoid');
var zod = require('zod');

// src/flows/FlowBuilder.ts
var FlowBuilder = class _FlowBuilder {
  flow = {};
  /**
   * Set flow ID
   */
  setId(id) {
    this.flow.id = id;
    return this;
  }
  /**
   * Set flow code (unique identifier)
   */
  setCode(code) {
    this.flow.code = code;
    return this;
  }
  /**
   * Set flow name
   */
  setName(name) {
    this.flow.name = name;
    return this;
  }
  /**
   * Set flow description
   */
  setDescription(description) {
    this.flow.description = description;
    return this;
  }
  /**
   * Add an input variable
   */
  addInput(input) {
    if (!this.flow.inputs) {
      this.flow.inputs = [];
    }
    this.flow.inputs.push(input);
    return this;
  }
  /**
   * Set all input variables
   */
  setInputs(inputs) {
    this.flow.inputs = inputs;
    return this;
  }
  /**
   * Set the flow definition
   */
  setFlow(flow) {
    this.flow.flow = flow;
    return this;
  }
  /**
   * Add an agent definition
   */
  addAgent(agent) {
    if (!this.flow.agents) {
      this.flow.agents = [];
    }
    this.flow.agents.push(agent);
    return this;
  }
  /**
   * Set all agents
   */
  setAgents(agents) {
    this.flow.agents = agents;
    return this;
  }
  /**
   * Build the flow
   */
  build() {
    this.validate();
    return {
      id: this.flow.id || nanoid.nanoid(),
      code: this.flow.code,
      name: this.flow.name,
      description: this.flow.description,
      inputs: this.flow.inputs || [],
      flow: this.flow.flow,
      agents: this.flow.agents || []
    };
  }
  /**
   * Validate the flow configuration
   */
  validate() {
    if (!this.flow.code) {
      throw new Error("Flow code is required");
    }
    if (!this.flow.name) {
      throw new Error("Flow name is required");
    }
    if (this.flow.inputs) {
      const names = /* @__PURE__ */ new Set();
      for (const input of this.flow.inputs) {
        if (!input.name) {
          throw new Error("Input variable name is required");
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
  static from(flow) {
    const builder = new _FlowBuilder();
    builder.flow = { ...flow };
    return builder;
  }
  /**
   * Create a new builder instance
   */
  static create() {
    return new _FlowBuilder();
  }
};

// src/flows/FlowExecutor.ts
var FlowExecutor = class {
  /**
   * Execute a flow
   */
  static async execute(flow, context, onEvent) {
    const events = [];
    const variables2 = { ...context.variables };
    let steps = 0;
    const startEvent = {
      type: "flow-start",
      timestamp: /* @__PURE__ */ new Date(),
      data: { flowCode: flow.code, flowName: flow.name }
    };
    events.push(startEvent);
    onEvent?.(startEvent);
    try {
      const output = await this.executeNode(
        flow.flow,
        { ...context, variables: variables2, currentDepth: 0 },
        events,
        onEvent
      );
      steps = events.filter((e) => e.type === "step-complete").length;
      const completeEvent = {
        type: "flow-complete",
        timestamp: /* @__PURE__ */ new Date(),
        data: { output, steps },
        variables: variables2
      };
      events.push(completeEvent);
      onEvent?.(completeEvent);
      return {
        success: true,
        output,
        variables: variables2,
        steps,
        events
      };
    } catch (error) {
      const errorEvent = {
        type: "flow-error",
        timestamp: /* @__PURE__ */ new Date(),
        error
      };
      events.push(errorEvent);
      onEvent?.(errorEvent);
      return {
        success: false,
        output: null,
        variables: variables2,
        steps: events.filter((e) => e.type === "step-complete").length,
        events,
        error
      };
    }
  }
  /**
   * Execute a single flow node
   */
  static async executeNode(node, context, events, onEvent) {
    const maxDepth = context.maxDepth || 100;
    const currentDepth = context.currentDepth || 0;
    if (currentDepth > maxDepth) {
      throw new Error(`Maximum flow depth ${maxDepth} exceeded`);
    }
    const stepId = node.id || `step-${Date.now()}`;
    const startEvent = {
      type: "step-start",
      timestamp: /* @__PURE__ */ new Date(),
      stepId,
      stepType: node.type
    };
    events.push(startEvent);
    onEvent?.(startEvent);
    try {
      let result;
      switch (node.type) {
        case "sequence":
          result = await this.executeSequence(node, context, events, onEvent);
          break;
        case "parallel":
          result = await this.executeParallel(node, context, events, onEvent);
          break;
        case "oneOf":
          result = await this.executeOneOf(node, context, events, onEvent);
          break;
        case "forEach":
          result = await this.executeForEach(node, context, events, onEvent);
          break;
        case "evaluator":
          result = await this.executeEvaluator(node, context, events, onEvent);
          break;
        case "llmCall":
          result = await this.executeLLMCall(node, context, events, onEvent);
          break;
        case "toolCall":
          result = await this.executeToolCall(node, context, events, onEvent);
          break;
        case "setVariable":
          result = await this.executeSetVariable(node, context, events, onEvent);
          break;
        case "return":
          result = this.executeReturn(node, context);
          break;
        case "end":
          result = this.executeEnd(node, context);
          break;
        case "throw":
          throw new Error(this.interpolate(node.message || "Flow error", context.variables));
        default:
          throw new Error(`Unknown node type: ${node.type}`);
      }
      const completeEvent = {
        type: "step-complete",
        timestamp: /* @__PURE__ */ new Date(),
        stepId,
        stepType: node.type,
        data: result
      };
      events.push(completeEvent);
      onEvent?.(completeEvent);
      return result;
    } catch (error) {
      const errorEvent = {
        type: "step-error",
        timestamp: /* @__PURE__ */ new Date(),
        stepId,
        stepType: node.type,
        error
      };
      events.push(errorEvent);
      onEvent?.(errorEvent);
      throw error;
    }
  }
  /**
   * Execute sequence node
   */
  static async executeSequence(node, context, events, onEvent) {
    const steps = node.steps || [];
    let lastResult = null;
    for (const step of steps) {
      lastResult = await this.executeNode(
        step,
        { ...context, currentDepth: (context.currentDepth || 0) + 1 },
        events,
        onEvent
      );
    }
    return lastResult;
  }
  /**
   * Execute parallel node
   */
  static async executeParallel(node, context, events, onEvent) {
    const steps = node.steps || [];
    const results = await Promise.all(
      steps.map(
        (step) => this.executeNode(
          step,
          { ...context, currentDepth: (context.currentDepth || 0) + 1 },
          events,
          onEvent
        )
      )
    );
    return results;
  }
  /**
   * Execute oneOf (conditional) node
   */
  static async executeOneOf(node, context, events, onEvent) {
    const options = node.options || [];
    for (const option of options) {
      if (option.condition) {
        const conditionMet = this.evaluateCondition(option.condition, context.variables);
        const conditionEvent = {
          type: "condition-evaluated",
          timestamp: /* @__PURE__ */ new Date(),
          data: { condition: option.condition, result: conditionMet }
        };
        events.push(conditionEvent);
        onEvent?.(conditionEvent);
        if (conditionMet) {
          return await this.executeNode(
            option.step,
            { ...context, currentDepth: (context.currentDepth || 0) + 1 },
            events,
            onEvent
          );
        }
      } else {
        return await this.executeNode(
          option.step,
          { ...context, currentDepth: (context.currentDepth || 0) + 1 },
          events,
          onEvent
        );
      }
    }
    return null;
  }
  /**
   * Execute forEach loop node
   */
  static async executeForEach(node, context, events, onEvent) {
    const items = this.resolveValue(node.items, context.variables) || [];
    const itemVar = node.itemVariable || "item";
    const indexVar = node.indexVariable || "index";
    const results = [];
    for (let i = 0; i < items.length; i++) {
      context.variables[itemVar] = items[i];
      context.variables[indexVar] = i;
      const iterationEvent = {
        type: "loop-iteration",
        timestamp: /* @__PURE__ */ new Date(),
        data: { item: items[i], index: i }
      };
      events.push(iterationEvent);
      onEvent?.(iterationEvent);
      if (node.step) {
        const result = await this.executeNode(
          node.step,
          { ...context, currentDepth: (context.currentDepth || 0) + 1 },
          events,
          onEvent
        );
        results.push(result);
      }
    }
    return results;
  }
  /**
   * Execute evaluator node
   */
  static async executeEvaluator(node, context, events, onEvent) {
    const expression2 = node.expression || "";
    return this.evaluateExpression(expression2, context.variables);
  }
  /**
   * Execute LLM call node
   */
  static async executeLLMCall(node, context, events, onEvent) {
    const prompt = this.interpolate(node.prompt || "", context.variables);
    const model = node.model || context.agent.settings?.model || "gpt-4";
    const messages = [];
    if (context.agent.prompt) {
      messages.push({
        role: "system",
        content: context.agent.prompt
      });
    }
    messages.push({
      role: "user",
      content: prompt
    });
    const callEvent = {
      type: "llm-call",
      timestamp: /* @__PURE__ */ new Date(),
      data: { model, prompt }
    };
    events.push(callEvent);
    onEvent?.(callEvent);
    const result = await context.provider.generate({
      model,
      messages,
      temperature: node.temperature,
      maxTokens: node.maxTokens
    });
    const responseEvent = {
      type: "llm-response",
      timestamp: /* @__PURE__ */ new Date(),
      data: { text: result.text, usage: result.usage }
    };
    events.push(responseEvent);
    onEvent?.(responseEvent);
    if (node.outputVariable) {
      context.variables[node.outputVariable] = result.text;
      const varEvent = {
        type: "variable-set",
        timestamp: /* @__PURE__ */ new Date(),
        data: { variable: node.outputVariable, value: result.text }
      };
      events.push(varEvent);
      onEvent?.(varEvent);
    }
    return result.text;
  }
  /**
   * Execute tool call node
   */
  static async executeToolCall(node, context, events, onEvent) {
    if (!context.toolRegistry) {
      throw new Error("Tool registry not available");
    }
    const toolName = node.tool || "";
    const toolDesc = context.toolRegistry.get(toolName);
    if (!toolDesc || !toolDesc.tool) {
      throw new Error(`Tool '${toolName}' not found`);
    }
    const args = this.interpolateObject(node.arguments || {}, context.variables);
    const callEvent = {
      type: "tool-call",
      timestamp: /* @__PURE__ */ new Date(),
      data: { tool: toolName, arguments: args }
    };
    events.push(callEvent);
    onEvent?.(callEvent);
    const result = toolDesc.tool.execute ? await toolDesc.tool.execute(args, {}) : null;
    const resultEvent = {
      type: "tool-result",
      timestamp: /* @__PURE__ */ new Date(),
      data: { tool: toolName, result }
    };
    events.push(resultEvent);
    onEvent?.(resultEvent);
    if (node.outputVariable) {
      context.variables[node.outputVariable] = result;
      const varEvent = {
        type: "variable-set",
        timestamp: /* @__PURE__ */ new Date(),
        data: { variable: node.outputVariable, value: result }
      };
      events.push(varEvent);
      onEvent?.(varEvent);
    }
    return result;
  }
  /**
   * Execute setVariable node
   */
  static async executeSetVariable(node, context, events, onEvent) {
    const variableName = node.variable || "";
    const value = this.resolveValue(node.value, context.variables);
    context.variables[variableName] = value;
    const varEvent = {
      type: "variable-set",
      timestamp: /* @__PURE__ */ new Date(),
      data: { variable: variableName, value }
    };
    events.push(varEvent);
    onEvent?.(varEvent);
    return value;
  }
  /**
   * Execute return node
   */
  static executeReturn(node, context) {
    return this.resolveValue(node.value, context.variables);
  }
  /**
   * Execute end node
   */
  static executeEnd(node, context) {
    return this.resolveValue(node.value, context.variables);
  }
  /**
   * Interpolate string with variables
   */
  static interpolate(template, variables2) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return variables2[key]?.toString() || "";
    });
  }
  /**
   * Interpolate object with variables
   */
  static interpolateObject(obj, variables2) {
    if (typeof obj === "string") {
      return this.interpolate(obj, variables2);
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.interpolateObject(item, variables2));
    }
    if (obj && typeof obj === "object") {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.interpolateObject(value, variables2);
      }
      return result;
    }
    return obj;
  }
  /**
   * Resolve a value (can be literal or variable reference)
   */
  static resolveValue(value, variables2) {
    if (typeof value === "string" && value.startsWith("$")) {
      const varName = value.substring(1);
      return variables2[varName];
    }
    return value;
  }
  /**
   * Evaluate a condition
   */
  static evaluateCondition(condition, variables) {
    try {
      const interpolated = this.interpolate(condition, variables);
      return !!eval(interpolated);
    } catch {
      return false;
    }
  }
  /**
   * Evaluate an expression
   */
  static evaluateExpression(expression, variables) {
    try {
      const interpolated = this.interpolate(expression, variables);
      return eval(interpolated);
    } catch (error) {
      throw new Error(`Failed to evaluate expression: ${expression}`);
    }
  }
};
function convertToFlowDefinition(step) {
  switch (step.type) {
    // ------------------------------------
    // STEP - Basic agent execution
    // ------------------------------------
    case "step":
      return {
        id: nanoid.nanoid(),
        agent: step.agent,
        input: step.input
      };
    // ------------------------------------
    // SEQUENCE - Execute steps in order
    // ------------------------------------
    case "sequence":
      return {
        id: nanoid.nanoid(),
        agent: "sequenceAgent",
        input: step.steps.map((child) => convertToFlowDefinition(child))
      };
    // ------------------------------------
    // PARALLEL - Execute steps concurrently
    // ------------------------------------
    case "parallel":
      return {
        id: nanoid.nanoid(),
        agent: "parallelAgent",
        input: step.steps.map((child) => convertToFlowDefinition(child))
      };
    // ------------------------------------
    // ONE-OF - Conditional branching
    // ------------------------------------
    case "oneOf":
      const flows = step.branches.map((b) => convertToFlowDefinition(b.flow));
      const conditions = step.branches.map((b) => b.when);
      return {
        id: nanoid.nanoid(),
        agent: "oneOfAgent",
        input: flows,
        conditions
      };
    // ------------------------------------
    // FOR-EACH - Iterate over items
    // ------------------------------------
    case "forEach":
      return {
        id: nanoid.nanoid(),
        agent: "forEachAgent",
        item: step.item,
        input: convertToFlowDefinition(step.inputFlow)
      };
    // ------------------------------------
    // EVALUATOR - Self-improvement loop
    // ------------------------------------
    case "evaluator":
      return {
        id: nanoid.nanoid(),
        agent: "optimizeAgent",
        criteria: step.criteria,
        max_iterations: step.max_iterations,
        input: convertToFlowDefinition(step.subFlow)
      };
    // ------------------------------------
    // BEST-OF-ALL - Run multiple and pick best
    // ------------------------------------
    case "bestOfAll":
      return {
        id: nanoid.nanoid(),
        agent: "bestOfAllAgent",
        criteria: step.criteria,
        input: step.steps.map((child) => convertToFlowDefinition(child))
      };
    // ------------------------------------
    // TOOL - Direct tool execution
    // ------------------------------------
    case "tool":
      return {
        id: nanoid.nanoid(),
        agent: "toolAgent",
        input: JSON.stringify({
          toolName: step.toolName,
          toolOptions: step.toolOptions
        })
      };
    // ------------------------------------
    // UI-COMPONENT - UI rendering step
    // ------------------------------------
    case "uiComponent":
      return {
        id: nanoid.nanoid(),
        agent: "uiComponentAgent",
        input: JSON.stringify({
          componentName: step.componentName,
          componentProps: step.componentProps
        })
      };
    // ------------------------------------
    // CONDITION - If-then-else
    // ------------------------------------
    case "condition":
      return {
        id: nanoid.nanoid(),
        agent: "oneOfAgent",
        input: [
          convertToFlowDefinition(step.trueFlow),
          convertToFlowDefinition(step.falseFlow)
        ],
        conditions: [step.condition, `!(${step.condition})`]
      };
    // ------------------------------------
    // LOOP - While loop
    // ------------------------------------
    case "loop":
      return {
        id: nanoid.nanoid(),
        agent: "forEachAgent",
        item: "iteration",
        input: convertToFlowDefinition(step.loopFlow),
        maxIterations: step.maxIterations,
        condition: step.condition
      };
    default:
      return {
        id: nanoid.nanoid(),
        agent: "unknownAgent",
        input: ""
      };
  }
}
function convertFromFlowDefinition(flowDef) {
  const agent = flowDef.agent;
  switch (agent) {
    case "sequenceAgent":
      return {
        type: "sequence",
        steps: Array.isArray(flowDef.input) ? flowDef.input.map((child) => convertFromFlowDefinition(child)) : []
      };
    case "parallelAgent":
      return {
        type: "parallel",
        steps: Array.isArray(flowDef.input) ? flowDef.input.map((child) => convertFromFlowDefinition(child)) : []
      };
    case "oneOfAgent":
      const conditions = flowDef.conditions || [];
      const flows = Array.isArray(flowDef.input) ? flowDef.input : [];
      return {
        type: "oneOf",
        branches: flows.map((flow, i) => ({
          when: conditions[i] || "",
          flow: convertFromFlowDefinition(flow)
        }))
      };
    case "forEachAgent":
      return {
        type: "forEach",
        item: flowDef.item || "",
        inputFlow: convertFromFlowDefinition(flowDef.input)
      };
    case "optimizeAgent":
      return {
        type: "evaluator",
        criteria: flowDef.criteria || "",
        max_iterations: flowDef.max_iterations,
        subFlow: convertFromFlowDefinition(flowDef.input)
      };
    case "bestOfAllAgent":
      return {
        type: "bestOfAll",
        criteria: flowDef.criteria || "",
        steps: Array.isArray(flowDef.input) ? flowDef.input.map((child) => convertFromFlowDefinition(child)) : []
      };
    case "toolAgent":
      try {
        const parsed = JSON.parse(flowDef.input);
        return {
          type: "tool",
          toolName: parsed.toolName || "",
          toolOptions: parsed.toolOptions || {}
        };
      } catch {
        return {
          type: "step",
          agent: "toolAgent",
          input: flowDef.input
        };
      }
    case "uiComponentAgent":
      try {
        const parsed = JSON.parse(flowDef.input);
        return {
          type: "uiComponent",
          componentName: parsed.componentName || "",
          componentProps: parsed.componentProps || {}
        };
      } catch {
        return {
          type: "step",
          agent: "uiComponentAgent",
          input: flowDef.input
        };
      }
    default:
      return {
        type: "step",
        agent: agent || "defaultAgent",
        input: typeof flowDef.input === "string" ? flowDef.input : JSON.stringify(flowDef.input)
      };
  }
}
function extractVariableNames(str) {
  const regex = /@([a-zA-Z0-9_]+)/g;
  const result = [];
  let match;
  while ((match = regex.exec(str)) !== null) {
    result.push(match[1]);
  }
  return result;
}
function replaceVariablesInString(str, variables2) {
  let result = str;
  for (const [name, value] of Object.entries(variables2)) {
    const pattern = new RegExp(`@${name}`, "g");
    result = result.replace(pattern, value);
  }
  return result;
}
function injectVariables(flowDef, variables2) {
  if (typeof flowDef.input === "string") {
    flowDef.input = replaceVariablesInString(flowDef.input, variables2);
  }
  if (Array.isArray(flowDef.conditions)) {
    flowDef.conditions = flowDef.conditions.map(
      (cond) => replaceVariablesInString(cond, variables2)
    );
  }
  if (typeof flowDef.criteria === "string") {
    flowDef.criteria = replaceVariablesInString(flowDef.criteria, variables2);
  }
  const agent = flowDef.agent;
  switch (agent) {
    case "sequenceAgent":
    case "parallelAgent":
    case "bestOfAllAgent":
    case "oneOfAgent":
      if (Array.isArray(flowDef.input)) {
        flowDef.input.forEach((child) => injectVariables(child, variables2));
      }
      break;
    case "forEachAgent":
    case "optimizeAgent":
      if (flowDef.input && typeof flowDef.input === "object") {
        injectVariables(flowDef.input, variables2);
      }
      break;
  }
  return flowDef;
}
async function applyInputTransformation(flowDef, transformFn) {
  flowDef.input = await transformFn(flowDef);
  if (!flowDef.name) {
    flowDef.name = flowDef.agent;
  }
  const agent = flowDef.agent;
  switch (agent) {
    case "sequenceAgent":
    case "parallelAgent":
    case "bestOfAllAgent":
    case "oneOfAgent":
      if (Array.isArray(flowDef.input)) {
        await Promise.all(
          flowDef.input.map(
            (child) => applyInputTransformation(child, transformFn)
          )
        );
      }
      break;
    case "forEachAgent":
    case "optimizeAgent":
      if (flowDef.input && typeof flowDef.input === "object") {
        await applyInputTransformation(flowDef.input, transformFn);
      }
      break;
  }
}
function createDynamicZodSchemaForInputs(options) {
  const { availableInputs } = options;
  if (!availableInputs || availableInputs.length === 0) {
    return zod.z.object({});
  }
  const shape = {};
  for (const inputVar of availableInputs) {
    let fieldSchema;
    switch (inputVar.type) {
      case "shortText":
      case "longText":
      case "url":
        fieldSchema = zod.z.string().describe(inputVar.description || inputVar.name);
        break;
      case "number":
        fieldSchema = zod.z.number().describe(inputVar.description || inputVar.name);
        break;
      case "json":
        fieldSchema = zod.z.any().describe(inputVar.description || inputVar.name);
        break;
      case "fileBase64":
        fieldSchema = zod.z.string().describe(inputVar.description || inputVar.name);
        break;
      default:
        fieldSchema = zod.z.string().describe(inputVar.description || inputVar.name);
    }
    if (!inputVar.required) {
      fieldSchema = fieldSchema.optional();
    }
    shape[inputVar.name] = fieldSchema;
  }
  return zod.z.object(shape);
}
function validateFlowInput(input, variables2) {
  const errors = [];
  for (const variable of variables2) {
    if (variable.required && (input[variable.name] === void 0 || input[variable.name] === null)) {
      errors.push(`Required input variable '${variable.name}' is missing`);
    }
    if (input[variable.name] !== void 0) {
      const value = input[variable.name];
      switch (variable.type) {
        case "number":
          if (typeof value !== "number") {
            errors.push(`Input variable '${variable.name}' must be a number`);
          }
          break;
        case "shortText":
        case "longText":
        case "url":
        case "fileBase64":
          if (typeof value !== "string") {
            errors.push(`Input variable '${variable.name}' must be a string`);
          }
          break;
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors
  };
}
var INPUT_TYPE_LABELS = {
  shortText: "Short text",
  url: "URL",
  longText: "Long text",
  number: "Number",
  json: "JSON Object",
  fileBase64: "File (Base64)"
};

// src/flows/validators.ts
function validateFlow(flow) {
  const errors = [];
  if (!flow.code) {
    errors.push("Flow code is required");
  }
  if (!flow.name) {
    errors.push("Flow name is required");
  }
  if (flow.inputs) {
    const names = /* @__PURE__ */ new Set();
    for (const input of flow.inputs) {
      if (!input.name) {
        errors.push("Input variable name is required");
      } else {
        if (names.has(input.name)) {
          errors.push(`Duplicate input variable name: ${input.name}`);
        }
        names.add(input.name);
      }
      if (!input.type) {
        errors.push(`Input variable '${input.name}' must have a type`);
      }
    }
  }
  if (flow.agents) {
    const agentNames = /* @__PURE__ */ new Set();
    for (const agent of flow.agents) {
      if (!agent.name) {
        errors.push("Agent name is required");
      } else {
        if (agentNames.has(agent.name)) {
          errors.push(`Duplicate agent name: ${agent.name}`);
        }
        agentNames.add(agent.name);
      }
      if (!agent.model) {
        errors.push(`Agent '${agent.name}' must have a model specified`);
      }
      if (!agent.system) {
        errors.push(`Agent '${agent.name}' must have a system prompt`);
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors
  };
}
function validateAgentDefinition(agent) {
  const errors = [];
  if (!agent.name) {
    errors.push("Agent name is required");
  }
  if (!agent.model) {
    errors.push("Agent model is required");
  }
  if (!agent.system) {
    errors.push("Agent system prompt is required");
  }
  return {
    valid: errors.length === 0,
    errors
  };
}

exports.FlowBuilder = FlowBuilder;
exports.FlowExecutor = FlowExecutor;
exports.INPUT_TYPE_LABELS = INPUT_TYPE_LABELS;
exports.applyInputTransformation = applyInputTransformation;
exports.convertFromFlowDefinition = convertFromFlowDefinition;
exports.convertToFlowDefinition = convertToFlowDefinition;
exports.createDynamicZodSchemaForInputs = createDynamicZodSchemaForInputs;
exports.extractVariableNames = extractVariableNames;
exports.injectVariables = injectVariables;
exports.replaceVariablesInString = replaceVariablesInString;
exports.validateAgentDefinition = validateAgentDefinition;
exports.validateFlow = validateFlow;
exports.validateFlowInput = validateFlowInput;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map