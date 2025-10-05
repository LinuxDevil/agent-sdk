'use strict';

var nanoid = require('nanoid');
var zod = require('zod');
var ai = require('ai');
var openai = require('@ai-sdk/openai');
var ollamaAiProvider = require('ollama-ai-provider');

// src/core/ConfigManager.ts
var ConfigManager = class {
  config;
  constructor(config) {
    this.validate(config);
    this.config = config;
  }
  /**
   * Get configuration
   */
  getConfig() {
    return { ...this.config };
  }
  /**
   * Update configuration
   */
  updateConfig(updates) {
    this.config = { ...this.config, ...updates };
    this.validate(this.config);
  }
  /**
   * Get specific config value
   */
  get(key) {
    return this.config[key];
  }
  /**
   * Validate configuration
   */
  validate(config) {
    if (!config.databaseIdHash) {
      throw new Error("databaseIdHash is required in SDK configuration");
    }
  }
};

// src/types/common.ts
var DataLoadingStatus = /* @__PURE__ */ ((DataLoadingStatus2) => {
  DataLoadingStatus2["Idle"] = "idle";
  DataLoadingStatus2["Loading"] = "loading";
  DataLoadingStatus2["Success"] = "success";
  DataLoadingStatus2["Error"] = "error";
  return DataLoadingStatus2;
})(DataLoadingStatus || {});

// src/types/agent.ts
var AgentType = /* @__PURE__ */ ((AgentType2) => {
  AgentType2["SmartAssistant"] = "smart-assistant";
  AgentType2["SurveyAgent"] = "survey-agent";
  AgentType2["CommerceAgent"] = "commerce-agent";
  AgentType2["Flow"] = "flow";
  return AgentType2;
})(AgentType || {});

// src/types/flow.ts
var FlowChunkType = /* @__PURE__ */ ((FlowChunkType2) => {
  FlowChunkType2["FlowStart"] = "flowStart";
  FlowChunkType2["FlowStepStart"] = "flowStepStart";
  FlowChunkType2["FlowFinish"] = "flowFinish";
  FlowChunkType2["Generation"] = "generation";
  FlowChunkType2["GenerationEnd"] = "generationEnd";
  FlowChunkType2["ToolCalls"] = "toolCalls";
  FlowChunkType2["TextStream"] = "textStream";
  FlowChunkType2["FinalResult"] = "finalResult";
  FlowChunkType2["Error"] = "error";
  FlowChunkType2["Message"] = "message";
  FlowChunkType2["UIComponent"] = "uiComponent";
  return FlowChunkType2;
})(FlowChunkType || {});

// src/agent-types/registry.ts
var agentTypesRegistry = [
  {
    type: "smart-assistant" /* SmartAssistant */,
    description: {
      pl: "Inteligentni asystenci to **agenci og\xF3lnego przeznaczenia**. Mog\u0105 korzysta\u0107 z narz\u0119dzi, na przyk\u0142ad sprawdzaj\u0105c Tw\xF3j kalendarz lub rezerwuj\u0105c nowe wydarzenia. Mog\u0105 by\u0107 r\xF3wnie\u017C u\u017Cywane do ankiet (mieszane z innymi zadaniami), ale musz\u0105 by\u0107 dostosowane do tego na poziomie promptu.",
      en: "Smart assistants are **general-purpose agents**. They can use tools, for example, checking your calendar or booking new events. They can also be used for surveys (mixed with other tasks) but need to be fine-tuned for doing so at the prompt level."
    },
    supportsUserFacingUI: true,
    requiredTabs: ["prompt", "expectedResult"],
    displayName: {
      "pl": "Inteligentny asystent [Chat]",
      "en": "Smart assistant [Chat]"
    }
  },
  {
    type: "survey-agent" /* SurveyAgent */,
    description: {
      pl: "Agenci ankietowi s\u0142u\u017C\u0105 do zbierania informacji lub opinii od u\u017Cytkownik\xF3w. Na podstawie poprzednich odpowiedzi mog\u0105 **dynamicznie dostosowywa\u0107** kolejne pytania. Ci agenci zapisuj\u0105 odpowiedzi do dalszego przetwarzania w po\u017C\u0105danym formacie. Mog\u0105 zast\u0105pi\u0107 narz\u0119dzia takie jak **Formularze, Ankiety, Formularze zg\u0142oszeniowe** itp.",
      en: "Survey agents are used to collect information or opinions from users. Based on previous answers, they can **dynamically adjust** the next questions. These agents save the answers for further processing in the desired format. They can replace tools like **Forms, Polls, Intake forms** etc."
    },
    supportsUserFacingUI: true,
    requiredTabs: ["prompt", "expectedResult"],
    displayName: {
      "pl": "Agent przeprowadzaj\u0105cy ankiety [Chat]",
      "en": "Survey agent [Chat]"
    }
  },
  {
    type: "commerce-agent" /* CommerceAgent */,
    description: {
      pl: "Agenci handlowi s\u0142u\u017C\u0105 do **sprzeda\u017Cy produkt\xF3w lub us\u0142ug**. Mog\u0105 by\u0107 u\u017Cywane w **e-commerce**, **rezerwacji us\u0142ug**, **b2b/cpq**. Operuj\u0105 na **katalogu produkt\xF3w** i mog\u0105 by\u0107 u\u017Cywane do **sprzeda\u017Cy dodatkowej** lub **sprzeda\u017Cy krzy\u017Cowej** produkt\xF3w.",
      en: "Commerce agents are used to **sell products or services**. They can be used in **e-commerce**, **service booking**, **b2b/cpq** scenarios. They operate on the **product catalog** and can be used to **upsell** or **cross-sell** products."
    },
    supportsUserFacingUI: true,
    requiredTabs: ["prompt", "expectedResult"],
    displayName: {
      "pl": "Asystent sprzeda\u017Cy [Chat]",
      "en": "Sales assistant [Chat]"
    }
  },
  {
    type: "flow" /* Flow */,
    description: {
      pl: "Agenci oparte na przep\u0142ywach pozwalaj\u0105 na tworzenie **z\u0142o\u017Conych scenariuszy**. Mog\u0105 by\u0107 u\u017Cywane do **automatyzacji proces\xF3w** i rozwijania aplikacji, kt\xF3re s\u0105 wywo\u0142ywane przez API lub inne agenty, za pomoc\u0105 **j\u0119zyka naturalnego**. Mog\u0105 by\u0107 u\u017Cywane do **tworzenia drzew decyzyjnych** lub **integracji**.",
      en: "Flow-based agents let you create **complex scenarios**. They can be used to **automate processes** and develop apps that are called by API or other agents, using **natural language**. They can be used to **create decision trees** or **integrations**."
    },
    supportsUserFacingUI: true,
    requiredTabs: [],
    displayName: {
      "pl": "Aplikacja / Workflow [API]",
      "en": "App / Workflow [API]"
    }
  }
];
function getAgentTypeDescriptor(type) {
  return agentTypesRegistry.find((descriptor) => descriptor.type === type);
}
function getAllAgentTypeDescriptors() {
  return [...agentTypesRegistry];
}
function isValidAgentType(type) {
  return agentTypesRegistry.some((descriptor) => descriptor.type === type);
}

// src/agent-types/validators.ts
function validateAgentConfig(config) {
  const errors = [];
  if (!config.name || config.name.trim() === "") {
    errors.push("Agent name is required");
  }
  if (!config.agentType) {
    errors.push("Agent type is required");
  }
  if (config.agentType && !Object.values(AgentType).includes(config.agentType)) {
    errors.push(`Invalid agent type: ${config.agentType}`);
  }
  return {
    valid: errors.length === 0,
    errors
  };
}
function validateAgentTools(tools) {
  const errors = [];
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
var AgentBuilder = class _AgentBuilder {
  config = {};
  /**
   * Set agent type
   */
  setType(type) {
    this.config.agentType = type;
    return this;
  }
  /**
   * Set agent name
   */
  setName(name) {
    this.config.name = name;
    return this;
  }
  /**
   * Set agent ID
   */
  setId(id) {
    this.config.id = id;
    return this;
  }
  /**
   * Set system prompt
   */
  setPrompt(prompt) {
    this.config.prompt = prompt;
    return this;
  }
  /**
   * Add a tool
   */
  addTool(key, config) {
    if (!this.config.tools) {
      this.config.tools = {};
    }
    this.config.tools[key] = config;
    return this;
  }
  /**
   * Remove a tool
   */
  removeTool(key) {
    if (this.config.tools) {
      delete this.config.tools[key];
    }
    return this;
  }
  /**
   * Set all tools
   */
  setTools(tools) {
    this.config.tools = tools;
    return this;
  }
  /**
   * Add a flow
   */
  addFlow(flow) {
    if (!this.config.flows) {
      this.config.flows = [];
    }
    this.config.flows.push(flow);
    return this;
  }
  /**
   * Set all flows
   */
  setFlows(flows) {
    this.config.flows = flows;
    return this;
  }
  /**
   * Set expected result schema
   */
  setExpectedResult(schema) {
    this.config.expectedResult = schema;
    return this;
  }
  /**
   * Set locale
   */
  setLocale(locale) {
    this.config.locale = locale;
    return this;
  }
  /**
   * Set events
   */
  setEvents(events) {
    this.config.events = events;
    return this;
  }
  /**
   * Set settings
   */
  setSettings(settings) {
    this.config.settings = settings;
    return this;
  }
  /**
   * Set metadata
   */
  setMetadata(metadata) {
    this.config.metadata = metadata;
    return this;
  }
  /**
   * Build the agent configuration
   */
  build() {
    this.validate();
    return {
      id: this.config.id || nanoid.nanoid(),
      name: this.config.name,
      agentType: this.config.agentType,
      locale: this.config.locale || "en",
      prompt: this.config.prompt,
      expectedResult: this.config.expectedResult,
      tools: this.config.tools || {},
      flows: this.config.flows || [],
      events: this.config.events || [],
      settings: this.config.settings || {},
      metadata: this.config.metadata || {}
    };
  }
  /**
   * Validate configuration before building
   */
  validate() {
    const validation = validateAgentConfig(this.config);
    if (!validation.valid) {
      throw new Error(`Agent configuration validation failed: ${validation.errors.join(", ")}`);
    }
    if (this.config.tools) {
      const toolsValidation = validateAgentTools(this.config.tools);
      if (!toolsValidation.valid) {
        throw new Error(`Agent tools validation failed: ${toolsValidation.errors.join(", ")}`);
      }
    }
  }
  /**
   * Load from existing config
   */
  static from(config) {
    const builder = new _AgentBuilder();
    builder.config = { ...config };
    return builder;
  }
  /**
   * Create a new builder instance
   */
  static create() {
    return new _AgentBuilder();
  }
};

// src/tools/ToolRegistry.ts
var ToolRegistry = class {
  tools = /* @__PURE__ */ new Map();
  /**
   * Register a tool
   */
  register(name, descriptor) {
    if (this.tools.has(name)) {
      console.warn(`Tool '${name}' is already registered. Overwriting.`);
    }
    this.tools.set(name, descriptor);
  }
  /**
   * Register multiple tools at once
   */
  registerMany(tools) {
    Object.entries(tools).forEach(([name, descriptor]) => {
      this.register(name, descriptor);
    });
  }
  /**
   * Get a tool by name
   */
  get(name) {
    return this.tools.get(name);
  }
  /**
   * Check if a tool exists
   */
  has(name) {
    return this.tools.has(name);
  }
  /**
   * Get all tool names
   */
  list() {
    return Array.from(this.tools.keys());
  }
  /**
   * Get all tools
   */
  getAll() {
    const result = {};
    this.tools.forEach((descriptor, name) => {
      result[name] = descriptor;
    });
    return result;
  }
  /**
   * Remove a tool
   */
  unregister(name) {
    return this.tools.delete(name);
  }
  /**
   * Clear all tools
   */
  clear() {
    this.tools.clear();
  }
  /**
   * Get the number of registered tools
   */
  size() {
    return this.tools.size;
  }
};
var globalToolRegistry = new ToolRegistry();
var currentDateTool = {
  displayName: "Get current date",
  tool: ai.tool({
    description: "Get the current date and time in ISO format (UTC timezone)",
    parameters: zod.z.object({}),
    execute: async () => {
      return (/* @__PURE__ */ new Date()).toISOString();
    }
  })
};
var dayNameTool = {
  displayName: "Get day name",
  tool: ai.tool({
    description: "Get the name of the day (e.g., Monday, Tuesday) for a given date",
    parameters: zod.z.object({
      date: zod.z.string().describe("The date to get the day name for in ISO format (e.g., 2024-01-15)"),
      locale: zod.z.string().optional().describe("The locale to use for the day name (e.g., en-US, pl-PL). Defaults to en-US")
    }),
    execute: async ({ date, locale = "en-US" }) => {
      return new Date(date).toLocaleDateString(locale, { weekday: "long" });
    }
  })
};
async function makeHttpRequest({
  url,
  method,
  headers,
  body,
  options = {}
}) {
  try {
    const fetchOptions = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: body && method !== "GET" ? body : void 0
    };
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const data = await response.json();
      return JSON.stringify(data);
    } else {
      return await response.text();
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`HTTP request failed: ${error.message}`);
    }
    throw new Error("HTTP request failed with unknown error");
  }
}
function createHttpTool(options = {}) {
  return {
    displayName: "Make HTTP request",
    tool: ai.tool({
      description: "Makes HTTP requests to specified URLs with configurable method, headers, and body. Supports GET, POST, PUT, DELETE, and PATCH methods.",
      parameters: zod.z.object({
        url: zod.z.string().describe("The URL to make the request to (must be a valid HTTP/HTTPS URL)"),
        method: zod.z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).describe("The HTTP method to use"),
        headers: zod.z.record(zod.z.string()).optional().describe("Optional headers to include in the request as key-value pairs"),
        body: zod.z.string().optional().describe("The body of the request. For POST/PUT/PATCH, this should be a JSON string. Not used for GET/DELETE.")
      }),
      execute: async ({ url, method, headers, body }) => {
        return makeHttpRequest({ url, method, headers, body, options });
      }
    })
  };
}
var httpTool = createHttpTool();
async function sendEmail({
  from,
  to,
  subject,
  text,
  html,
  apiKey,
  apiUrl = "https://api.resend.com/emails"
}) {
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        text,
        html
      })
    });
    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Email sending failed (${response.status}): ${errorData}`);
    }
    const data = await response.json();
    return JSON.stringify(data);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to send email: ${error.message}`);
    }
    throw new Error("Failed to send email with unknown error");
  }
}
function createEmailTool(options) {
  const { apiKey, apiUrl, defaultFrom } = options;
  if (!apiKey) {
    throw new Error("Email tool requires an apiKey in options");
  }
  return {
    displayName: "Send email",
    tool: ai.tool({
      description: "Sends an email using the Resend.com API. Provide sender, recipients, subject, and content.",
      parameters: zod.z.object({
        from: zod.z.string().describe('The sender email address (e.g., "Sender Name <sender@example.com>"). Can use default if configured.').optional(),
        to: zod.z.array(zod.z.string()).describe('Array of recipient email addresses (e.g., ["user@example.com"])'),
        subject: zod.z.string().describe("The subject line of the email"),
        text: zod.z.string().describe("Plain text content of the email"),
        html: zod.z.string().describe("HTML content of the email")
      }),
      execute: async ({ from, to, subject, text, html }) => {
        const senderEmail = from || defaultFrom;
        if (!senderEmail) {
          throw new Error('Email "from" address is required. Provide it in the parameters or set defaultFrom in options.');
        }
        return sendEmail({
          from: senderEmail,
          to,
          subject,
          text,
          html,
          apiKey,
          apiUrl
        });
      }
    })
  };
}
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

// src/data/models.ts
var Agent = class _Agent {
  id;
  name;
  agentType;
  locale;
  prompt;
  expectedResult;
  tools;
  flows;
  events;
  settings;
  metadata;
  createdAt;
  updatedAt;
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.agentType = config.agentType;
    this.locale = config.locale || "en";
    this.prompt = config.prompt;
    this.expectedResult = config.expectedResult;
    this.tools = config.tools;
    this.flows = config.flows;
    this.events = config.events;
    this.settings = config.settings;
    this.metadata = config.metadata;
    this.createdAt = config.createdAt;
    this.updatedAt = config.updatedAt;
  }
  /**
   * Convert to AgentConfig for SDK usage
   */
  toConfig() {
    return {
      id: this.id,
      name: this.name,
      agentType: this.agentType,
      locale: this.locale,
      prompt: this.prompt,
      expectedResult: this.expectedResult,
      tools: this.tools,
      flows: this.flows,
      events: this.events,
      settings: this.settings,
      metadata: this.metadata
    };
  }
  /**
   * Create from AgentConfig
   */
  static fromConfig(config) {
    return new _Agent(config);
  }
};
var Session = class {
  id;
  agentId;
  data;
  messages;
  createdAt;
  updatedAt;
  constructor(data) {
    this.id = data.id;
    this.agentId = data.agentId;
    this.data = data.data;
    this.messages = data.messages;
    this.createdAt = data.createdAt || (/* @__PURE__ */ new Date()).toISOString();
    this.updatedAt = data.updatedAt || (/* @__PURE__ */ new Date()).toISOString();
  }
};
var Result = class {
  id;
  sessionId;
  agentId;
  result;
  success;
  error;
  tokensUsed;
  duration;
  createdAt;
  constructor(data) {
    this.id = data.id;
    this.sessionId = data.sessionId;
    this.agentId = data.agentId;
    this.result = data.result;
    this.success = data.success;
    this.error = data.error;
    this.tokensUsed = data.tokensUsed;
    this.duration = data.duration;
    this.createdAt = data.createdAt || (/* @__PURE__ */ new Date()).toISOString();
  }
};
var Memory = class {
  id;
  agentId;
  sessionId;
  content;
  embedding;
  metadata;
  createdAt;
  constructor(data) {
    this.id = data.id;
    this.agentId = data.agentId;
    this.sessionId = data.sessionId;
    this.content = data.content;
    this.embedding = data.embedding;
    this.metadata = data.metadata;
    this.createdAt = data.createdAt || (/* @__PURE__ */ new Date()).toISOString();
  }
  /**
   * Convenience getter for importance (from metadata)
   */
  get importance() {
    return this.metadata?.importance ?? 1;
  }
  /**
   * Convenience getter for access count (from metadata)
   */
  get accessCount() {
    return this.metadata?.accessCount ?? 0;
  }
  /**
   * Convenience getter for accessed at (from metadata)
   */
  get accessedAt() {
    return this.metadata?.accessedAt;
  }
};
var Attachment = class {
  id;
  displayName;
  description;
  mimeType;
  type;
  size;
  storageKey;
  filePath;
  content;
  metadata;
  createdAt;
  updatedAt;
  constructor(data) {
    this.id = data.id;
    this.displayName = data.displayName;
    this.description = data.description;
    this.mimeType = data.mimeType;
    this.type = data.type;
    this.size = data.size;
    this.storageKey = data.storageKey;
    this.filePath = data.filePath;
    this.content = data.content;
    this.metadata = data.metadata;
    this.createdAt = data.createdAt || (/* @__PURE__ */ new Date()).toISOString();
    this.updatedAt = data.updatedAt || (/* @__PURE__ */ new Date()).toISOString();
  }
};
var BaseMockRepository = class {
  items = /* @__PURE__ */ new Map();
  async findById(id) {
    return this.items.get(id) || null;
  }
  async findMany(filter) {
    const items = Array.from(this.items.values());
    if (!filter) return items;
    return items.filter((item) => {
      return Object.entries(filter).every(([key, value]) => {
        return item[key] === value;
      });
    });
  }
  async create(data) {
    const id = this.generateId();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const item = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now
    };
    this.items.set(id, item);
    return item;
  }
  async update(id, data) {
    const existing = this.items.get(id);
    if (!existing) {
      throw new Error(`Item with id ${id} not found`);
    }
    const updated = {
      ...existing,
      ...data,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.items.set(id, updated);
    return updated;
  }
  async delete(id) {
    return this.items.delete(id);
  }
  async count(filter) {
    const items = await this.findMany(filter);
    return items.length;
  }
  clear() {
    this.items.clear();
  }
};
var MockAgentRepository = class extends BaseMockRepository {
  generateId() {
    return nanoid.nanoid();
  }
  async findByType(type) {
    return Array.from(this.items.values()).filter(
      (agent) => agent.agentType === type
    );
  }
  async findByName(name) {
    const items = Array.from(this.items.values());
    return items.find((agent) => agent.name === name) || null;
  }
  async search(query) {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.items.values()).filter(
      (agent) => agent.name.toLowerCase().includes(lowerQuery) || agent.prompt?.toLowerCase().includes(lowerQuery)
    );
  }
  async findWithPagination(options) {
    const { page = 1, perPage = 10 } = options;
    const items = Array.from(this.items.values());
    const total = items.length;
    const start = (page - 1) * perPage;
    const end = start + perPage;
    const data = items.slice(start, end);
    return {
      data,
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      hasMore: end < total
    };
  }
};
var MockSessionRepository = class extends BaseMockRepository {
  generateId() {
    return nanoid.nanoid();
  }
  async findByAgentId(agentId) {
    return Array.from(this.items.values()).filter(
      (session) => session.agentId === agentId
    );
  }
  async findWithMessages(sessionId) {
    return this.findById(sessionId);
  }
  async addMessage(sessionId, message) {
    const session = await this.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const messages = session.messages || [];
    return this.update(sessionId, {
      messages: [...messages, message]
    });
  }
  async updateData(sessionId, data) {
    const session = await this.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return this.update(sessionId, {
      data: { ...session.data, ...data }
    });
  }
};
var MockResultRepository = class extends BaseMockRepository {
  generateId() {
    return nanoid.nanoid();
  }
  async findBySessionId(sessionId) {
    const items = Array.from(this.items.values());
    return items.find((result) => result.sessionId === sessionId) || null;
  }
  async findByAgentId(agentId) {
    return Array.from(this.items.values()).filter(
      (result) => result.agentId === agentId
    );
  }
  async findSuccessful() {
    return Array.from(this.items.values()).filter((result) => result.success);
  }
  async findFailed() {
    return Array.from(this.items.values()).filter((result) => !result.success);
  }
};
var MockMemoryRepository = class extends BaseMockRepository {
  generateId() {
    return nanoid.nanoid();
  }
  /**
   * Override create to return Memory class instances
   */
  async create(data) {
    const id = this.generateId();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const memory = new Memory({
      ...data,
      id,
      createdAt: data.createdAt || now
    });
    this.items.set(id, memory);
    return memory;
  }
  /**
   * Override update to maintain Memory class instances
   */
  async update(id, data) {
    const existing = this.items.get(id);
    if (!existing) {
      throw new Error(`Memory with id ${id} not found`);
    }
    const updated = new Memory({
      ...existing,
      ...data,
      id: existing.id,
      agentId: data.agentId || existing.agentId,
      content: data.content || existing.content,
      createdAt: existing.createdAt
    });
    this.items.set(id, updated);
    return updated;
  }
  async findByAgentId(agentId, limit) {
    const memories = Array.from(this.items.values()).filter(
      (memory) => memory.agentId === agentId
    );
    return limit ? memories.slice(0, limit) : memories;
  }
  async findBySessionId(sessionId) {
    return Array.from(this.items.values()).filter(
      (memory) => memory.sessionId === sessionId
    );
  }
  async search(agentId, query, limit = 10) {
    const lowerQuery = query.toLowerCase();
    const memories = Array.from(this.items.values()).filter(
      (memory) => memory.agentId === agentId && memory.content.toLowerCase().includes(lowerQuery)
    );
    return memories.slice(0, limit);
  }
  async searchByEmbedding(agentId, embedding, limit = 10) {
    const memories = Array.from(this.items.values()).filter((memory) => memory.agentId === agentId && memory.embedding).map((memory) => ({
      memory,
      similarity: this.cosineSimilarity(embedding, memory.embedding)
    })).sort((a, b) => b.similarity - a.similarity).slice(0, limit).map((item) => item.memory);
    return memories;
  }
  cosineSimilarity(a, b) {
    const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magA * magB);
  }
};
var MockAttachmentRepository = class extends BaseMockRepository {
  nextId = 1;
  generateId() {
    return this.nextId++;
  }
  async findByStorageKey(storageKey) {
    const items = Array.from(this.items.values());
    return items.find((att) => att.storageKey === storageKey) || null;
  }
  async findByType(type) {
    return Array.from(this.items.values()).filter((att) => att.type === type);
  }
  async findWithContent(id) {
    return this.findById(id);
  }
};

// src/providers/llm.ts
var LLMProviderRegistry = class {
  static providers = /* @__PURE__ */ new Map();
  /**
   * Register a provider
   */
  static register(name, factory) {
    this.providers.set(name.toLowerCase(), factory);
  }
  /**
   * Create provider instance
   */
  static create(name, config) {
    const factory = this.providers.get(name.toLowerCase());
    if (!factory) {
      throw new Error(`Provider '${name}' not found. Available: ${Array.from(this.providers.keys()).join(", ")}`);
    }
    return factory(config);
  }
  /**
   * Check if provider is registered
   */
  static has(name) {
    return this.providers.has(name.toLowerCase());
  }
  /**
   * Get all registered provider names
   */
  static getProviderNames() {
    return Array.from(this.providers.keys());
  }
  /**
   * Clear all providers (for testing)
   */
  static clear() {
    this.providers.clear();
  }
};

// src/providers/mock.ts
var MockLLMProvider = class {
  name = "mock";
  responseIndex = 0;
  responses;
  delay;
  simulateError;
  errorMessage;
  constructor(config) {
    this.responses = config.responses || ["This is a mock response."];
    this.delay = config.delay || 0;
    this.simulateError = config.simulateError || false;
    this.errorMessage = config.errorMessage || "Mock error";
  }
  async generate(options) {
    if (this.simulateError) {
      throw new Error(this.errorMessage);
    }
    if (this.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delay));
    }
    const text = this.getNextResponse();
    const toolCalls = this.extractToolCalls(options);
    return {
      text,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      usage: {
        promptTokens: this.countTokens(options.messages),
        completionTokens: this.countTokens([{ role: "assistant", content: text }]),
        totalTokens: this.countTokens(options.messages) + this.countTokens([{ role: "assistant", content: text }])
      },
      toolCalls: toolCalls.length > 0 ? toolCalls : void 0
    };
  }
  async stream(options) {
    if (this.simulateError) {
      throw new Error(this.errorMessage);
    }
    const text = this.getNextResponse();
    const words = text.split(" ");
    const fullStreamGenerator = async function* () {
      for (const word of words) {
        if (this.delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.delay));
        }
        const chunk = {
          type: "text-delta",
          textDelta: word + " "
        };
        yield chunk;
      }
      yield {
        type: "finish",
        finishReason: "stop",
        usage: {
          promptTokens: this.countTokens(options.messages),
          completionTokens: words.length,
          totalTokens: this.countTokens(options.messages) + words.length
        }
      };
    }.bind(this);
    const textStreamGenerator = async function* () {
      for (const word of words) {
        yield word + " ";
      }
    };
    return {
      fullStream: fullStreamGenerator(),
      textStream: textStreamGenerator(),
      text: Promise.resolve(text),
      usage: Promise.resolve({
        promptTokens: this.countTokens(options.messages),
        completionTokens: words.length,
        totalTokens: this.countTokens(options.messages) + words.length
      }),
      finishReason: Promise.resolve("stop"),
      toolCalls: Promise.resolve([])
    };
  }
  supportsTools(model) {
    return true;
  }
  supportsStreaming(model) {
    return true;
  }
  async getModels() {
    return ["mock-model-1", "mock-model-2"];
  }
  getNextResponse() {
    const response = this.responses[this.responseIndex % this.responses.length];
    this.responseIndex++;
    return response;
  }
  extractToolCalls(options) {
    if (!options.tools || options.tools.length === 0) {
      return [];
    }
    const lastMessage = options.messages[options.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "user") {
      return [];
    }
    for (const tool5 of options.tools) {
      if (lastMessage.content.toLowerCase().includes(tool5.function.name.toLowerCase())) {
        return [
          {
            id: `call_${Date.now()}`,
            type: "function",
            function: {
              name: tool5.function.name,
              arguments: JSON.stringify({ input: "mock input" })
            }
          }
        ];
      }
    }
    return [];
  }
  countTokens(messages) {
    return Math.ceil(
      messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) / 4
    );
  }
};
function createMockProvider(config = { name: "mock" }) {
  return new MockLLMProvider(config);
}
function convertMessages(messages) {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.toolCallId || "",
            toolName: msg.name || "unknown",
            result: msg.content
          }
        ]
      };
    }
    return {
      role: msg.role,
      content: msg.content,
      ...msg.toolCalls && { toolCalls: msg.toolCalls }
    };
  });
}
var OpenAIProvider = class {
  name = "openai";
  provider;
  config;
  constructor(config) {
    this.config = config;
    this.provider = openai.createOpenAI({
      apiKey: config.apiKey,
      organization: config.organization,
      baseURL: config.baseURL,
      headers: config.headers
    });
  }
  /**
   * Generate text without streaming
   */
  async generate(options) {
    const model = this.provider(options.model || this.config.defaultModel || "gpt-4");
    const tools = {};
    if (options.tools) {
      for (const toolDef of options.tools) {
        const params = toolDef.function.parameters;
        tools[toolDef.function.name] = ai.tool({
          description: toolDef.function.description,
          parameters: params,
          execute: async () => {
            return null;
          }
        });
      }
    }
    const result = await ai.generateText({
      model,
      messages: convertMessages(options.messages),
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      seed: options.seed,
      tools: Object.keys(tools).length > 0 ? tools : void 0,
      maxSteps: 1
      // Single step for non-streaming
    });
    const toolCalls = result.toolCalls?.map((tc) => ({
      id: tc.toolCallId,
      type: "function",
      function: {
        name: tc.toolName,
        arguments: JSON.stringify(tc.args)
      }
    }));
    return {
      text: result.text,
      finishReason: result.finishReason === "stop" ? "stop" : result.finishReason === "length" ? "length" : result.finishReason === "tool-calls" ? "tool_calls" : result.finishReason === "content-filter" ? "content_filter" : "error",
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens
      },
      toolCalls,
      rawResponse: result
    };
  }
  /**
   * Generate text with streaming
   */
  async stream(options) {
    const model = this.provider(options.model || this.config.defaultModel || "gpt-4");
    const tools = {};
    if (options.tools) {
      for (const toolDef of options.tools) {
        const params = toolDef.function.parameters;
        tools[toolDef.function.name] = ai.tool({
          description: toolDef.function.description,
          parameters: params,
          execute: async () => {
            return null;
          }
        });
      }
    }
    const result = await ai.streamText({
      model,
      messages: convertMessages(options.messages),
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      seed: options.seed,
      tools: Object.keys(tools).length > 0 ? tools : void 0,
      maxSteps: 1
      // Single step for streaming
    });
    const textStream = (async function* () {
      for await (const delta of result.textStream) {
        yield delta;
      }
    })();
    const fullStream = (async function* () {
      for await (const delta of result.textStream) {
        const chunk2 = {
          type: "text-delta",
          textDelta: delta
        };
        yield chunk2;
      }
      const [finalText, finalUsage, finalReason] = await Promise.all([
        result.text,
        result.usage,
        result.finishReason
      ]);
      const chunk = {
        type: "finish",
        finishReason: finalReason,
        usage: {
          promptTokens: finalUsage.promptTokens,
          completionTokens: finalUsage.completionTokens,
          totalTokens: finalUsage.totalTokens
        }
      };
      yield chunk;
    })();
    return {
      textStream,
      fullStream,
      text: (async () => {
        const finalText = await result.text;
        return finalText;
      })(),
      usage: (async () => {
        const finalUsage = await result.usage;
        return {
          promptTokens: finalUsage.promptTokens,
          completionTokens: finalUsage.completionTokens,
          totalTokens: finalUsage.totalTokens
        };
      })(),
      finishReason: (async () => {
        const reason = await result.finishReason;
        return reason;
      })(),
      toolCalls: (async () => {
        const calls = await result.toolCalls;
        return calls.map((tc) => ({
          id: tc.toolCallId,
          type: "function",
          function: {
            name: tc.toolName,
            arguments: JSON.stringify(tc.args)
          }
        }));
      })()
    };
  }
  /**
   * Check if model supports tools
   */
  supportsTools(model) {
    return model.startsWith("gpt-4") || model.startsWith("gpt-3.5-turbo");
  }
  /**
   * Check if model supports streaming
   */
  supportsStreaming(model) {
    return true;
  }
  /**
   * Get available models
   */
  async getModels() {
    return [
      "gpt-4",
      "gpt-4-turbo",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-3.5-turbo"
    ];
  }
};
function convertMessages2(messages) {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.toolCallId || "",
            toolName: msg.name || "unknown",
            result: msg.content
          }
        ]
      };
    }
    return {
      role: msg.role,
      content: msg.content,
      ...msg.toolCalls && { toolCalls: msg.toolCalls }
    };
  });
}
var OllamaProvider = class {
  name = "ollama";
  provider;
  config;
  constructor(config) {
    this.config = config;
    this.provider = ollamaAiProvider.createOllama({
      baseURL: config.baseURL || "http://localhost:11434"
    });
  }
  /**
   * Generate text without streaming
   */
  async generate(options) {
    const model = this.provider(
      options.model || this.config.defaultModel || "llama3.1",
      {
        simulateStreaming: true,
        structuredOutputs: true
      }
    );
    const tools = {};
    if (options.tools) {
      for (const toolDef of options.tools) {
        const params = toolDef.function.parameters;
        tools[toolDef.function.name] = ai.tool({
          description: toolDef.function.description,
          parameters: params,
          // Type assertion since we know it's compatible
          execute: async () => {
            return null;
          }
        });
      }
    }
    const result = await ai.generateText({
      model,
      messages: convertMessages2(options.messages),
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      seed: options.seed,
      tools: Object.keys(tools).length > 0 ? tools : void 0,
      maxSteps: 1
      // Single step for non-streaming
    });
    const toolCalls = result.toolCalls?.map((tc) => ({
      id: tc.toolCallId,
      type: "function",
      function: {
        name: tc.toolName,
        arguments: JSON.stringify(tc.args)
      }
    }));
    return {
      text: result.text,
      finishReason: result.finishReason === "stop" ? "stop" : result.finishReason === "length" ? "length" : result.finishReason === "tool-calls" ? "tool_calls" : result.finishReason === "content-filter" ? "content_filter" : "error",
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens
      },
      toolCalls,
      rawResponse: result
    };
  }
  /**
   * Generate text with streaming
   */
  async stream(options) {
    const model = this.provider(
      options.model || this.config.defaultModel || "llama3.1",
      {
        simulateStreaming: true,
        structuredOutputs: true
      }
    );
    const tools = {};
    if (options.tools) {
      for (const toolDef of options.tools) {
        const params = toolDef.function.parameters;
        tools[toolDef.function.name] = ai.tool({
          description: toolDef.function.description,
          parameters: params,
          execute: async () => {
            return null;
          }
        });
      }
    }
    const result = await ai.streamText({
      model,
      messages: convertMessages2(options.messages),
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      seed: options.seed,
      tools: Object.keys(tools).length > 0 ? tools : void 0,
      maxSteps: 1
      // Single step for streaming
    });
    const textStream = (async function* () {
      for await (const delta of result.textStream) {
        yield delta;
      }
    })();
    const fullStream = (async function* () {
      for await (const delta of result.textStream) {
        const chunk2 = {
          type: "text-delta",
          textDelta: delta
        };
        yield chunk2;
      }
      const [finalText, finalUsage, finalReason] = await Promise.all([
        result.text,
        result.usage,
        result.finishReason
      ]);
      const chunk = {
        type: "finish",
        finishReason: finalReason,
        usage: {
          promptTokens: finalUsage.promptTokens,
          completionTokens: finalUsage.completionTokens,
          totalTokens: finalUsage.totalTokens
        }
      };
      yield chunk;
    })();
    return {
      textStream,
      fullStream,
      text: (async () => {
        const finalText = await result.text;
        return finalText;
      })(),
      usage: (async () => {
        const finalUsage = await result.usage;
        return {
          promptTokens: finalUsage.promptTokens,
          completionTokens: finalUsage.completionTokens,
          totalTokens: finalUsage.totalTokens
        };
      })(),
      finishReason: (async () => {
        const reason = await result.finishReason;
        return reason;
      })(),
      toolCalls: (async () => {
        const calls = await result.toolCalls;
        return calls.map((tc) => ({
          id: tc.toolCallId,
          type: "function",
          function: {
            name: tc.toolName,
            arguments: JSON.stringify(tc.args)
          }
        }));
      })()
    };
  }
  /**
   * Check if model supports tools
   */
  supportsTools(model) {
    return model.includes("llama3") || model.includes("mistral");
  }
  /**
   * Check if model supports streaming
   */
  supportsStreaming(model) {
    return true;
  }
  /**
   * Get available models
   */
  async getModels() {
    try {
      const response = await fetch(`${this.config.baseURL || "http://localhost:11434"}/api/tags`);
      const data = await response.json();
      return data.models?.map((m) => m.name) || [];
    } catch (error) {
      console.warn("Failed to fetch Ollama models:", error);
      return ["llama3.1", "llama2", "mistral"];
    }
  }
};

// src/providers/index.ts
LLMProviderRegistry.register("openai", (config) => new OpenAIProvider(config));
LLMProviderRegistry.register("ollama", (config) => new OllamaProvider(config));

// src/execution/AgentExecutor.ts
var AgentExecutor = class {
  /**
   * Execute agent without streaming
   */
  static async execute(options) {
    const {
      agent,
      input,
      provider,
      toolRegistry,
      maxSteps = 10,
      temperature,
      maxTokens,
      onEvent
    } = options;
    this.emitEvent(onEvent, {
      type: "start",
      timestamp: /* @__PURE__ */ new Date(),
      agentId: agent.id,
      agentName: agent.name
    });
    const messages = this.buildMessages(agent, input);
    const tools = this.buildTools(agent, toolRegistry);
    let currentMessages = [...messages];
    let allToolCalls = [];
    let totalUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    };
    let steps = 0;
    let finalText = "";
    let finishReason = "stop";
    while (steps < maxSteps) {
      steps++;
      try {
        const result = await provider.generate({
          model: agent.settings?.model || "gpt-4",
          messages: currentMessages,
          temperature,
          maxTokens,
          tools: tools.length > 0 ? tools : void 0
        });
        totalUsage.promptTokens += result.usage.promptTokens;
        totalUsage.completionTokens += result.usage.completionTokens;
        totalUsage.totalTokens += result.usage.totalTokens;
        if (result.text) {
          finalText = result.text;
          this.emitEvent(onEvent, {
            type: "text-complete",
            timestamp: /* @__PURE__ */ new Date(),
            text: result.text
          });
        }
        if (result.toolCalls && result.toolCalls.length > 0) {
          allToolCalls.push(...result.toolCalls);
          currentMessages.push({
            role: "assistant",
            content: result.text || "",
            toolCalls: result.toolCalls
          });
          for (const toolCall of result.toolCalls) {
            this.emitEvent(onEvent, {
              type: "tool-call",
              timestamp: /* @__PURE__ */ new Date(),
              toolCall
            });
            const toolResult = await this.executeToolCall(
              toolCall,
              agent,
              toolRegistry
            );
            this.emitEvent(onEvent, {
              type: "tool-result",
              timestamp: /* @__PURE__ */ new Date(),
              toolResult
            });
            currentMessages.push({
              role: "tool",
              content: JSON.stringify(toolResult.result),
              name: toolCall.function.name,
              toolCallId: toolCall.id
            });
          }
          finishReason = result.finishReason;
          continue;
        }
        finishReason = result.finishReason;
        break;
      } catch (error) {
        this.emitEvent(onEvent, {
          type: "error",
          timestamp: /* @__PURE__ */ new Date(),
          error
        });
        throw error;
      }
    }
    this.emitEvent(onEvent, {
      type: "finish",
      timestamp: /* @__PURE__ */ new Date(),
      finishReason,
      usage: totalUsage
    });
    return {
      text: finalText,
      messages: currentMessages,
      toolCalls: allToolCalls,
      usage: totalUsage,
      finishReason,
      steps
    };
  }
  /**
   * Build messages from input
   */
  static buildMessages(agent, input) {
    const messages = [];
    if (agent.prompt) {
      messages.push({
        role: "system",
        content: agent.prompt
      });
    }
    if (typeof input === "string") {
      messages.push({
        role: "user",
        content: input
      });
    } else {
      messages.push(...input);
    }
    return messages;
  }
  /**
   * Build tools from agent and registry
   */
  static buildTools(agent, toolRegistry) {
    if (!agent.tools || !toolRegistry) {
      return [];
    }
    const tools = [];
    for (const [toolName, toolConfig] of Object.entries(agent.tools)) {
      const toolDesc = toolRegistry.get(toolName);
      if (toolDesc && toolDesc.tool) {
        tools.push({
          type: "function",
          function: {
            name: toolName,
            description: toolDesc.tool.description || toolConfig.description || "",
            parameters: toolDesc.tool.parameters || {}
          }
        });
      }
    }
    return tools;
  }
  /**
   * Execute a tool call
   */
  static async executeToolCall(toolCall, agent, toolRegistry) {
    if (!toolRegistry) {
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        result: null,
        error: "No tool registry available"
      };
    }
    try {
      const toolDesc = toolRegistry.get(toolCall.function.name);
      if (!toolDesc || !toolDesc.tool || !toolDesc.tool.execute) {
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          result: null,
          error: `Tool '${toolCall.function.name}' not found`
        };
      }
      const args = JSON.parse(toolCall.function.arguments);
      const result = await toolDesc.tool.execute(args, {});
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        result
      };
    } catch (error) {
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        result: null,
        error: error.message
      };
    }
  }
  /**
   * Emit event to callback
   */
  static emitEvent(callback, event) {
    if (callback) {
      callback(event);
    }
  }
};
var MemoryManager = class {
  config;
  constructor(config) {
    this.config = {
      repository: config.repository,
      maxMemories: config.maxMemories ?? 1e3,
      relevanceThreshold: config.relevanceThreshold ?? 0.5
    };
  }
  /**
   * Store a new memory
   */
  async store(options) {
    const { agentId, content, metadata, embedding, importance = 1 } = options;
    await this.pruneMemoriesIfNeeded(agentId);
    const extendedMetadata = {
      ...metadata,
      importance,
      accessCount: 0,
      accessedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const memory = new Memory({
      id: nanoid.nanoid(),
      agentId,
      content,
      embedding: embedding ?? [],
      metadata: extendedMetadata,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    return await this.config.repository.create(memory);
  }
  /**
   * Recall relevant memories
   */
  async recall(options) {
    const {
      agentId,
      query,
      embedding,
      limit = 10,
      minRelevance = this.config.relevanceThreshold
    } = options;
    let memories;
    if (embedding && embedding.length > 0) {
      memories = await this.config.repository.searchByEmbedding(
        agentId,
        embedding,
        limit * 2
        // Get more to filter by relevance
      );
    } else {
      memories = await this.config.repository.findByAgentId(agentId, limit * 2);
    }
    const results = memories.map((memory) => ({
      memory,
      relevance: this.calculateRelevance(memory, { query, embedding })
    }));
    const filtered = results.filter((r) => r.relevance >= minRelevance).sort((a, b) => b.relevance - a.relevance).slice(0, limit);
    await Promise.all(
      filtered.map(
        (r) => this.updateAccessStats(r.memory.id)
      )
    );
    return filtered;
  }
  /**
   * Search memories by embedding (vector similarity)
   */
  async searchByEmbedding(agentId, embedding, limit = 10) {
    const memories = await this.config.repository.searchByEmbedding(
      agentId,
      embedding,
      limit
    );
    return memories.map((memory) => ({
      memory,
      relevance: this.calculateEmbeddingSimilarity(embedding, memory.embedding || [])
    }));
  }
  /**
   * Get memory by ID
   */
  async getById(id) {
    return await this.config.repository.findById(id);
  }
  /**
   * Update memory
   */
  async update(id, updates) {
    return await this.config.repository.update(id, updates);
  }
  /**
   * Delete memory
   */
  async delete(id) {
    await this.config.repository.delete(id);
  }
  /**
   * Delete all memories for an agent
   */
  async deleteAllForAgent(agentId) {
    const memories = await this.config.repository.findByAgentId(agentId, 1e3);
    await Promise.all(
      memories.map((memory) => this.config.repository.delete(memory.id))
    );
  }
  /**
   * Get memory statistics for an agent
   */
  async getStats(agentId) {
    const memories = await this.config.repository.findByAgentId(agentId, 1e3);
    if (memories.length === 0) {
      return {
        total: 0,
        avgImportance: 0,
        avgAccessCount: 0,
        oldestMemory: null,
        newestMemory: null
      };
    }
    const importances = memories.map((m) => m.metadata?.importance || 1);
    const accessCounts = memories.map((m) => m.metadata?.accessCount || 0);
    const avgImportance = importances.reduce((sum, val) => sum + val, 0) / memories.length;
    const avgAccessCount = accessCounts.reduce((sum, val) => sum + val, 0) / memories.length;
    const sortedByDate = [...memories].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    return {
      total: memories.length,
      avgImportance,
      avgAccessCount,
      oldestMemory: sortedByDate[0].createdAt,
      newestMemory: sortedByDate[sortedByDate.length - 1].createdAt
    };
  }
  /**
   * Calculate relevance score for a memory
   */
  calculateRelevance(memory, context) {
    let score = 0;
    const importance = memory.metadata?.importance || 1;
    const accessCount = memory.metadata?.accessCount || 0;
    score += importance * 0.3;
    const createdAt = new Date(memory.createdAt).getTime();
    const ageInDays = (Date.now() - createdAt) / (1e3 * 60 * 60 * 24);
    const recencyScore = Math.max(0, 1 - ageInDays / 30);
    score += recencyScore * 0.2;
    const accessScore = Math.min(1, accessCount / 10);
    score += accessScore * 0.1;
    if (context.embedding && memory.embedding && memory.embedding.length > 0) {
      const similarity = this.calculateEmbeddingSimilarity(
        context.embedding,
        memory.embedding
      );
      score += similarity * 0.4;
    }
    if (context.query) {
      const textSimilarity = this.calculateTextSimilarity(
        context.query,
        memory.content
      );
      score += textSimilarity * 0.4;
    }
    return Math.min(1, score);
  }
  /**
   * Calculate cosine similarity between two embeddings
   */
  calculateEmbeddingSimilarity(embedding1, embedding2) {
    if (embedding1.length === 0 || embedding2.length === 0) {
      return 0;
    }
    if (embedding1.length !== embedding2.length) {
      return 0;
    }
    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;
    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      magnitude1 += embedding1[i] * embedding1[i];
      magnitude2 += embedding2[i] * embedding2[i];
    }
    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);
    if (magnitude1 === 0 || magnitude2 === 0) {
      return 0;
    }
    return dotProduct / (magnitude1 * magnitude2);
  }
  /**
   * Calculate text similarity (simple keyword matching)
   */
  calculateTextSimilarity(query, content) {
    const queryWords = query.toLowerCase().split(/\s+/);
    const contentWords = content.toLowerCase().split(/\s+/);
    const contentSet = new Set(contentWords);
    const matchingWords = queryWords.filter((word) => contentSet.has(word));
    if (queryWords.length === 0) {
      return 0;
    }
    return matchingWords.length / queryWords.length;
  }
  /**
   * Update access statistics for a memory
   */
  async updateAccessStats(memoryId) {
    const memory = await this.config.repository.findById(memoryId);
    if (memory) {
      const currentAccessCount = memory.metadata?.accessCount || 0;
      const updatedMetadata = {
        ...memory.metadata,
        accessedAt: (/* @__PURE__ */ new Date()).toISOString(),
        accessCount: currentAccessCount + 1
      };
      await this.config.repository.update(memoryId, {
        metadata: updatedMetadata
      });
    }
  }
  /**
   * Prune old memories if limit is exceeded
   */
  async pruneMemoriesIfNeeded(agentId) {
    const stats = await this.getStats(agentId);
    if (stats.total >= this.config.maxMemories) {
      const memories = await this.config.repository.findByAgentId(agentId, 1e3);
      const sorted = [...memories].sort((a, b) => {
        const importanceA = a.metadata?.importance || 1;
        const importanceB = b.metadata?.importance || 1;
        const accessCountA = a.metadata?.accessCount || 0;
        const accessCountB = b.metadata?.accessCount || 0;
        const ageA = Date.now() - new Date(a.createdAt).getTime();
        const ageB = Date.now() - new Date(b.createdAt).getTime();
        const scoreA = importanceA * 0.5 + accessCountA / 10 * 0.3 + (1 - ageA / (1e3 * 60 * 60 * 24 * 30)) * 0.2;
        const scoreB = importanceB * 0.5 + accessCountB / 10 * 0.3 + (1 - ageB / (1e3 * 60 * 60 * 24 * 30)) * 0.2;
        return scoreA - scoreB;
      });
      const toDelete = Math.ceil(this.config.maxMemories * 0.1);
      const memoriesToDelete = sorted.slice(0, toDelete);
      await Promise.all(
        memoriesToDelete.map(
          (memory) => this.config.repository.delete(memory.id)
        )
      );
    }
  }
};

// src/execution/ContextBuilder.ts
var ContextBuilder = class {
  /**
   * Build execution context
   */
  static async build(options) {
    const {
      agent,
      input,
      sessionHistory = [],
      memoryManager,
      variables: variables2 = {},
      systemPrompt,
      maxHistoryMessages = 20,
      maxMemories = 5
    } = options;
    let finalSystemPrompt = await this.buildSystemPrompt({
      agent,
      systemPrompt,
      memoryManager,
      maxMemories
    });
    finalSystemPrompt = this.interpolateVariables(finalSystemPrompt, variables2);
    const messages = await this.buildMessages({
      systemPrompt: finalSystemPrompt,
      input,
      sessionHistory,
      maxHistoryMessages
    });
    const processedMessages = this.injectVariables(messages, variables2);
    const metadata = {
      agentId: agent.id || "",
      agentName: agent.name,
      agentType: agent.agentType,
      hasMemories: !!memoryManager,
      memoryCount: 0,
      // Will be updated if memories are recalled
      historyCount: sessionHistory.length
    };
    return {
      messages: processedMessages,
      variables: variables2,
      systemPrompt: finalSystemPrompt,
      metadata
    };
  }
  /**
   * Build system prompt with agent instructions and memories
   */
  static async buildSystemPrompt(options) {
    const { agent, systemPrompt, memoryManager, maxMemories } = options;
    const parts = [];
    if (agent.name) {
      parts.push(`You are ${agent.name}.`);
    }
    if (agent.metadata?.description) {
      parts.push(agent.metadata.description);
    }
    const prompt = systemPrompt || agent.prompt || "";
    if (prompt) {
      parts.push(prompt);
    }
    if (memoryManager && agent.id) {
      const memories = await memoryManager.recall({
        agentId: agent.id,
        limit: maxMemories,
        minRelevance: 0.3
        // Lower threshold for when no query/embedding provided
      });
      if (memories.length > 0) {
        const memoryText = memories.map((m, i) => `${i + 1}. ${m.memory.content}`).join("\n");
        parts.push(`## Relevant Memories
${memoryText}`);
      }
    }
    return parts.filter((p) => p).join("\n\n").trim();
  }
  /**
   * Build message array from input and history
   */
  static async buildMessages(options) {
    const { systemPrompt, input, sessionHistory, maxHistoryMessages } = options;
    const messages = [];
    if (systemPrompt) {
      messages.push({
        role: "system",
        content: systemPrompt
      });
    }
    const limitedHistory = sessionHistory.slice(-maxHistoryMessages);
    messages.push(...limitedHistory);
    if (typeof input === "string") {
      messages.push({
        role: "user",
        content: input
      });
    } else {
      messages.push(...input);
    }
    return messages;
  }
  /**
   * Inject variables into messages
   */
  static injectVariables(messages, variables2) {
    if (Object.keys(variables2).length === 0) {
      return messages;
    }
    return messages.map((message) => {
      if (typeof message.content === "string") {
        return {
          ...message,
          content: this.interpolateVariables(message.content, variables2)
        };
      }
      return message;
    });
  }
  /**
   * Interpolate variables in text ({{variable}} syntax)
   */
  static interpolateVariables(text, variables2) {
    return text.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      const value = variables2[varName];
      if (value === void 0) {
        return match;
      }
      return String(value);
    });
  }
  /**
   * Merge multiple contexts (useful for multi-agent scenarios)
   */
  static merge(...contexts) {
    if (contexts.length === 0) {
      throw new Error("At least one context is required");
    }
    if (contexts.length === 1) {
      return contexts[0];
    }
    const merged = {
      messages: [],
      variables: {},
      systemPrompt: "",
      metadata: {
        agentId: contexts[0].metadata.agentId,
        agentName: contexts[0].metadata.agentName,
        agentType: contexts[0].metadata.agentType,
        hasMemories: false,
        memoryCount: 0,
        historyCount: 0
      }
    };
    const systemMessages = [];
    const otherMessages = [];
    for (const context of contexts) {
      for (const message of context.messages) {
        if (message.role === "system") {
          if (!systemMessages.some((m) => m.content === message.content)) {
            systemMessages.push(message);
          }
        } else {
          otherMessages.push(message);
        }
      }
    }
    merged.messages = [...systemMessages, ...otherMessages];
    for (const context of contexts) {
      merged.variables = { ...merged.variables, ...context.variables };
    }
    merged.systemPrompt = contexts.map((c) => c.systemPrompt).filter((p) => p).join("\n\n---\n\n");
    merged.metadata.hasMemories = contexts.some((c) => c.metadata.hasMemories);
    merged.metadata.memoryCount = contexts.reduce(
      (sum, c) => sum + c.metadata.memoryCount,
      0
    );
    merged.metadata.historyCount = contexts.reduce(
      (sum, c) => sum + c.metadata.historyCount,
      0
    );
    return merged;
  }
  /**
   * Clone context with modifications
   */
  static clone(context, modifications) {
    return {
      messages: modifications?.messages || [...context.messages],
      variables: modifications?.variables || { ...context.variables },
      systemPrompt: modifications?.systemPrompt || context.systemPrompt,
      metadata: modifications?.metadata || { ...context.metadata }
    };
  }
  /**
   * Extract variables from context messages
   */
  static extractVariables(context) {
    const variables2 = /* @__PURE__ */ new Set();
    const regex = /\{\{(\w+)\}\}/g;
    for (const message of context.messages) {
      if (typeof message.content === "string") {
        let match;
        while ((match = regex.exec(message.content)) !== null) {
          variables2.add(match[1]);
        }
      }
    }
    return Array.from(variables2);
  }
  /**
   * Validate context has all required variables
   */
  static validate(context) {
    const requiredVariables = this.extractVariables(context);
    const missingVariables = requiredVariables.filter(
      (varName) => context.variables[varName] === void 0
    );
    return {
      valid: missingVariables.length === 0,
      missingVariables
    };
  }
};

// src/execution/errors.ts
var SDKError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "SDKError";
  }
};
var AgentExecutionError = class extends SDKError {
  constructor(message, agentId, cause) {
    super(message, "AGENT_EXECUTION_ERROR");
    this.agentId = agentId;
    this.cause = cause;
    this.name = "AgentExecutionError";
  }
};
var ToolExecutionError = class extends SDKError {
  constructor(message, toolName, cause) {
    super(message, "TOOL_EXECUTION_ERROR");
    this.toolName = toolName;
    this.cause = cause;
    this.name = "ToolExecutionError";
  }
};
var LLMProviderError = class extends SDKError {
  constructor(message, providerName, statusCode, cause) {
    super(message, "LLM_PROVIDER_ERROR");
    this.providerName = providerName;
    this.statusCode = statusCode;
    this.cause = cause;
    this.name = "LLMProviderError";
  }
};
var FlowExecutionError = class extends SDKError {
  constructor(message, flowCode, step, cause) {
    super(message, "FLOW_EXECUTION_ERROR");
    this.flowCode = flowCode;
    this.step = step;
    this.cause = cause;
    this.name = "FlowExecutionError";
  }
};
var ConfigurationError = class extends SDKError {
  constructor(message, field) {
    super(message, "CONFIGURATION_ERROR");
    this.field = field;
    this.name = "ConfigurationError";
  }
};
var ValidationError = class extends SDKError {
  constructor(message, errors) {
    super(message, "VALIDATION_ERROR");
    this.errors = errors;
    this.name = "ValidationError";
  }
};
var TimeoutError = class extends SDKError {
  constructor(message, timeoutMs, operation) {
    super(message, "TIMEOUT_ERROR");
    this.timeoutMs = timeoutMs;
    this.operation = operation;
    this.name = "TimeoutError";
  }
};
var RateLimitError = class extends SDKError {
  constructor(message, retryAfter, limit) {
    super(message, "RATE_LIMIT_ERROR");
    this.retryAfter = retryAfter;
    this.limit = limit;
    this.name = "RateLimitError";
  }
};
function isRetryableError(error) {
  if (error instanceof RateLimitError) {
    return true;
  }
  if (error instanceof LLMProviderError) {
    if (error.statusCode) {
      return error.statusCode >= 500 || error.statusCode === 408 || // Request Timeout
      error.statusCode === 429;
    }
    return true;
  }
  if (error instanceof TimeoutError) {
    return true;
  }
  return false;
}
function isNetworkError(error) {
  const networkErrorMessages = [
    "econnrefused",
    "enotfound",
    "etimedout",
    "econnreset",
    "network",
    "fetch failed"
  ];
  const message = error.message.toLowerCase();
  return networkErrorMessages.some((msg) => message.includes(msg.toLowerCase()));
}
function getRetryDelay(error) {
  if (error instanceof RateLimitError && error.retryAfter) {
    return error.retryAfter * 1e3;
  }
  if (error instanceof LLMProviderError) {
    if (error.statusCode === 429) {
      return 6e4;
    }
  }
  return void 0;
}

// src/execution/retry.ts
async function retry(operation, options = {}) {
  const {
    maxAttempts = 3,
    initialDelayMs = 1e3,
    maxDelayMs = 6e4,
    backoffMultiplier = 2,
    timeout,
    onRetry,
    shouldRetry = isRetryableError
  } = options;
  let attempt = 0;
  let totalDelayMs = 0;
  let lastError;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const value = timeout ? await withTimeout(operation(), timeout) : await operation();
      return {
        value,
        attempts: attempt,
        totalDelayMs
      };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
      if (!shouldRetry(lastError, attempt)) {
        break;
      }
      let delayMs = getRetryDelay(lastError);
      if (delayMs === void 0) {
        delayMs = Math.min(
          initialDelayMs * Math.pow(backoffMultiplier, attempt - 1),
          maxDelayMs
        );
        const jitter = delayMs * 0.2 * (Math.random() - 0.5);
        delayMs = Math.round(delayMs + jitter);
        delayMs = Math.min(delayMs, maxDelayMs);
      }
      totalDelayMs += delayMs;
      if (onRetry) {
        onRetry(lastError, attempt, delayMs);
      }
      await sleep(delayMs);
    }
  }
  throw lastError;
}
async function retryOnError(operation, errorTypes, options = {}) {
  return retry(operation, {
    ...options,
    shouldRetry: (error, attempt) => {
      const isMatchingError = errorTypes.some(
        (ErrorType) => error instanceof ErrorType
      );
      if (!isMatchingError) {
        return false;
      }
      if (options.shouldRetry) {
        return options.shouldRetry(error, attempt);
      }
      return isRetryableError(error);
    }
  });
}
async function retryWithTimeout(operation, timeoutMs, options = {}) {
  return retry(operation, {
    ...options,
    timeout: timeoutMs
  });
}
async function retryBatch(operations, options = {}) {
  return Promise.all(operations.map((op) => retry(op, options)));
}
var RetryableOperation = class {
  constructor(operation, options = {}) {
    this.operation = operation;
    this.options = options;
    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? 5;
    this.circuitBreakerResetMs = options.circuitBreakerResetMs ?? 6e4;
  }
  failureCount = 0;
  lastFailureTime = null;
  circuitBreakerThreshold;
  circuitBreakerResetMs;
  async execute() {
    if (this.isCircuitOpen()) {
      throw new Error(
        `Circuit breaker is open. Too many failures (${this.failureCount}). Try again later.`
      );
    }
    try {
      const result = await retry(this.operation, this.options);
      this.failureCount = 0;
      this.lastFailureTime = null;
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }
  isCircuitOpen() {
    if (this.failureCount < this.circuitBreakerThreshold) {
      return false;
    }
    if (!this.lastFailureTime) {
      return false;
    }
    const timeSinceLastFailure = Date.now() - this.lastFailureTime;
    if (timeSinceLastFailure >= this.circuitBreakerResetMs) {
      this.failureCount = 0;
      this.lastFailureTime = null;
      return false;
    }
    return true;
  }
  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
  }
  reset() {
    this.failureCount = 0;
    this.lastFailureTime = null;
  }
  getStatus() {
    return {
      isOpen: this.isCircuitOpen(),
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime
    };
  }
};
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new TimeoutError(
          `Operation timed out after ${timeoutMs}ms`,
          timeoutMs
        )
      );
    }, timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// src/security/crypto.ts
var EncryptionUtils = class {
  key = {};
  secretKey;
  keyGenerated = false;
  constructor(secretKey) {
    this.secretKey = secretKey;
  }
  /**
   * Generate or retrieve cached encryption key
   */
  async generateKey(secretKey) {
    if (this.keyGenerated && this.secretKey !== secretKey) {
      this.keyGenerated = false;
    }
    if (this.keyGenerated) {
      return;
    }
    this.secretKey = secretKey;
    const keyData = await this.deriveKey(secretKey);
    this.key = await crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt"
    ]);
    this.keyGenerated = true;
  }
  /**
   * Derive encryption key from secret using PBKDF2
   */
  async deriveKey(secretKey) {
    const encoder = new TextEncoder();
    const salt = encoder.encode("someSalt");
    const iterations = 1e5;
    const keyLength = 256;
    const derivedKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secretKey),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );
    return crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations,
        hash: "SHA-256"
      },
      derivedKey,
      keyLength
    );
  }
  /**
   * Encrypt ArrayBuffer data
   */
  async encryptArrayBuffer(data) {
    await this.generateKey(this.secretKey);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const encryptedData = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv
      },
      this.key,
      data
    );
    return new Blob([iv, new Uint8Array(encryptedData)]).arrayBuffer();
  }
  /**
   * Convert Blob to ArrayBuffer
   */
  async blobToArrayBuffer(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
  }
  /**
   * Decrypt ArrayBuffer data
   */
  async decryptArrayBuffer(encryptedData) {
    try {
      await this.generateKey(this.secretKey);
      let encryptedArrayBuffer;
      if (encryptedData instanceof Blob) {
        encryptedArrayBuffer = await this.blobToArrayBuffer(encryptedData);
      } else {
        encryptedArrayBuffer = encryptedData;
      }
      const iv = new Uint8Array(encryptedArrayBuffer.slice(0, 16));
      const cipherText = encryptedArrayBuffer.slice(16);
      return await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv
        },
        this.key,
        cipherText
      );
    } catch (e) {
      console.error("Error decrypting ArrayBuffer", e);
      if (encryptedData instanceof Blob) {
        return await this.blobToArrayBuffer(encryptedData);
      }
      return encryptedData;
    }
  }
  /**
   * Encrypt string text
   */
  async encrypt(text) {
    await this.generateKey(this.secretKey);
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const encryptedData = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, data);
    const encryptedArray = Array.from(new Uint8Array(encryptedData));
    const encryptedHex = encryptedArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const ivHex = Array.from(iv).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return ivHex + encryptedHex;
  }
  /**
   * Decrypt string text
   */
  async decrypt(cipherText) {
    try {
      if (cipherText) {
        await this.generateKey(this.secretKey);
        const ivHex = cipherText.slice(0, 32);
        const encryptedHex = cipherText.slice(32);
        const iv = new Uint8Array(
          (ivHex.match(/.{1,2}/g) || []).map((byte) => parseInt(byte, 16))
        );
        const encryptedArray = new Uint8Array(
          (encryptedHex.match(/.{1,2}/g) || []).map((byte) => parseInt(byte, 16))
        );
        const decryptedData = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          this.key,
          encryptedArray
        );
        const decoder = new TextDecoder();
        return decoder.decode(decryptedData);
      } else {
        return cipherText;
      }
    } catch (e) {
      console.error(
        "Error decoding: " + (cipherText && cipherText.length > 100 ? cipherText.slice(0, 100) + "..." : cipherText),
        e
      );
      return cipherText;
    }
  }
};
function generatePassword() {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...key));
}
var DTOEncryptionFilter = class {
  utils;
  constructor(secretKey) {
    this.utils = new EncryptionUtils(secretKey);
  }
  /**
   * Encrypt specified fields in a DTO
   */
  async encrypt(dto, encryptionSettings) {
    return this.process(dto, encryptionSettings, async (value) => {
      if (value) {
        if (typeof value === "object") {
          if (Object.prototype.toString.call(value) === "[object Date]") {
            value = value.toISOString();
          }
          return "json-" + await this.utils.encrypt(JSON.stringify(value));
        }
        return await this.utils.encrypt(value);
      } else {
        return value;
      }
    });
  }
  /**
   * Decrypt specified fields in a DTO
   */
  async decrypt(dto, encryptionSettings) {
    return this.process(dto, encryptionSettings, async (value) => {
      if (value) {
        if (typeof value === "string" && value.startsWith("json-")) {
          return JSON.parse(await this.utils.decrypt(value.slice(5)));
        }
        return await this.utils.decrypt(value);
      } else {
        return value;
      }
    });
  }
  /**
   * Process DTO fields with a transformation function
   */
  async process(dto, encryptionSettings, processFn) {
    const result = {};
    for (const key in dto) {
      if (encryptionSettings && encryptionSettings.encryptedFields.indexOf(key) >= 0 || !encryptionSettings && (typeof dto[key] === "string" || typeof dto[key] === "object")) {
        result[key] = await processFn(dto[key]);
      } else {
        result[key] = dto[key];
      }
    }
    return result;
  }
};
async function sha256(message, salt) {
  const msgUint8 = new TextEncoder().encode(message + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

// src/security/quotas.ts
function validateTokenQuotas(saasContext, isSaaSEnabled) {
  if (!isSaaSEnabled) {
    return { message: "SaaS is not enabled, quotas are not validated", status: 200 };
  }
  if (!saasContext?.emailVerified) {
    return { message: "You must verify e-mail to use the AI features", status: 403 };
  }
  if ((saasContext.currentQuota.allowedResults || 0) > 0 && (saasContext?.currentUsage.usedResults ?? 0) > (saasContext?.currentQuota.allowedResults || 0)) {
    return { message: "You have reached the limit of results", status: 403 };
  }
  if ((saasContext.currentQuota.allowedSessions || 0) > 0 && (saasContext.currentUsage.usedSessions ?? 0) > (saasContext.currentQuota.allowedSessions || 0)) {
    return { message: "You have reached the limit of sessions", status: 403 };
  }
  if ((saasContext.currentQuota.allowedUSDBudget || 0) > 0 && (saasContext.currentUsage.usedUSDBudget ?? 0) > (saasContext.currentQuota.allowedUSDBudget || 0)) {
    return { message: "You have reached the AI Tokens Limit", status: 403 };
  }
  return { message: "All OK!", status: 200 };
}

// src/storage/StorageService.ts
var StorageService = class {
  rootPath;
  uploadPath;
  schema;
  fs;
  // Will be provided by implementation
  path;
  // Will be provided by implementation
  constructor(databaseIdHash, schema, fs, path, rootPath) {
    this.fs = fs;
    this.path = path;
    this.rootPath = rootPath || (typeof process !== "undefined" && process.cwd ? process.cwd() : ".");
    this.uploadPath = this.path.join(this.rootPath, "data", databaseIdHash, schema);
    this.schema = schema;
  }
  /**
   * Ensures that the target directory (uploadPath) exists.
   */
  ensureDirExists() {
    if (!this.fs.existsSync(this.uploadPath)) {
      this.fs.mkdirSync(this.uploadPath, { recursive: true });
    }
  }
  /**
   * Resolve the absolute path for a particular storage key (file name).
   */
  getFilePath(storageKey) {
    return this.path.resolve(this.uploadPath, storageKey);
  }
  /**
   * Resolve the absolute path for the lock file used by concurrency.
   */
  getLockFilePath(storageKey) {
    return `${this.getFilePath(storageKey)}.lock`;
  }
  /**
   * Simple helper to wait between lock acquisition attempts.
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  /**
   * Acquire an exclusive lock on a file by creating a ".lock" next to it.
   */
  async acquireLock(storageKey, maxAttempts = 50, attemptDelayMs = 100) {
    const lockFilePath = this.getLockFilePath(storageKey);
    let attempts = 0;
    while (this.fs.existsSync(lockFilePath)) {
      attempts++;
      if (attempts > maxAttempts) {
        throw new Error(
          `Could not acquire lock for "${storageKey}" after ${maxAttempts} attempts`
        );
      }
      await this.delay(attemptDelayMs);
    }
    this.fs.writeFileSync(lockFilePath, "");
  }
  /**
   * Release the lock by removing the ".lock" file.
   */
  releaseLock(storageKey) {
    const lockFilePath = this.getLockFilePath(storageKey);
    if (this.fs.existsSync(lockFilePath)) {
      this.fs.unlinkSync(lockFilePath);
    }
  }
  /**
   * Save a binary attachment from a File object (browser File).
   */
  async saveAttachment(file, storageKey) {
    this.ensureDirExists();
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    this.fs.writeFileSync(this.getFilePath(storageKey), buffer);
  }
  /**
   * Save a binary attachment from a base64 string.
   */
  async saveAttachmentFromBase64(base64, storageKey) {
    this.ensureDirExists();
    const buffer = typeof Buffer !== "undefined" ? Buffer.from(base64, "base64") : base64;
    this.fs.writeFileSync(this.getFilePath(storageKey), buffer);
  }
  /**
   * Save a plain-text file (UTF-8).
   */
  async savePlainTextAttachment(text, storageKey) {
    this.ensureDirExists();
    this.fs.writeFileSync(this.getFilePath(storageKey), text, "utf8");
  }
  /**
   * Read a plain-text file (UTF-8).
   */
  readPlainTextAttachment(storageKey) {
    const filePath = this.getFilePath(storageKey);
    return this.fs.readFileSync(filePath, "utf8");
  }
  /**
   * Check if a file exists.
   */
  fileExists(storageKey) {
    const filePath = this.getFilePath(storageKey);
    return this.fs.existsSync(filePath);
  }
  /**
   * Read a binary attachment as an ArrayBuffer.
   */
  readAttachment(storageKey) {
    const filePath = this.getFilePath(storageKey);
    const buffer = this.fs.readFileSync(filePath);
    return new Uint8Array(buffer).buffer;
  }
  /**
   * Read a binary attachment as a base64 data URI string (with mimeType).
   */
  readAttachmentAsBase64WithMimeType(storageKey, mimeType) {
    const filePath = this.getFilePath(storageKey);
    const buffer = this.fs.readFileSync(filePath).toString("base64");
    return `data:${mimeType};base64,${buffer}`;
  }
  /**
   * Delete a file by its storage key.
   */
  deleteAttachment(storageKey) {
    const filePath = this.getFilePath(storageKey);
    if (this.fs.existsSync(filePath)) {
      this.fs.rmSync(filePath);
    }
  }
  /**
   * Read a JSON file from disk and parse it. Returns {} if not found.
   */
  readPlainJSONAttachment(storageKey) {
    this.ensureDirExists();
    const filePath = this.getFilePath(storageKey);
    if (!this.fs.existsSync(filePath)) {
      return {};
    }
    const raw = this.fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  }
  /**
   * Writes data as JSON to disk. Checks size against maxFileSizeMB (default 10).
   */
  writePlainJSONAttachment(storageKey, data, maxFileSizeMB = 10) {
    this.ensureDirExists();
    const jsonString = JSON.stringify(data);
    const size = typeof Buffer !== "undefined" ? Buffer.byteLength(jsonString, "utf8") : jsonString.length;
    if (size > maxFileSizeMB * 1024 * 1024) {
      throw new Error(`File size limit of ${maxFileSizeMB}MB exceeded for ${storageKey}.`);
    }
    this.fs.writeFileSync(this.getFilePath(storageKey), jsonString, "utf8");
  }
};

// src/templates/TemplateManager.ts
function escapeHtml(input) {
  const str = String(input ?? "");
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function getValueFromContext(varPath, context) {
  return varPath.split(".").reduce((acc, key) => acc && acc[key], context);
}
function evaluateCondition(conditionExpr, context) {
  const value = getValueFromContext(conditionExpr, context);
  return !!value;
}
function parseIfBlocks(template, context, filters) {
  const ifBlockRegex = /{%\s*if\s+(.+?)\s*%}([\s\S]*?){%\s*endif\s*%}/;
  let match = ifBlockRegex.exec(template);
  while (match) {
    const [fullMatch, conditionExpr, blockContent] = match;
    let elseContent = "";
    let thenContent = blockContent;
    const elseRegex = /{%\s*else\s*%}([\s\S]*)$/;
    const elseMatch = elseRegex.exec(blockContent);
    if (elseMatch) {
      thenContent = blockContent.slice(0, elseMatch.index);
      elseContent = elseMatch[1];
    }
    const conditionResult = evaluateCondition(conditionExpr, context);
    let chosenContent = conditionResult ? thenContent : elseContent;
    chosenContent = parseIfBlocks(chosenContent, context, filters);
    chosenContent = parseForBlocks(chosenContent, context, filters);
    chosenContent = replaceVariables(chosenContent, context, filters);
    template = template.slice(0, match.index) + chosenContent + template.slice(match.index + fullMatch.length);
    match = ifBlockRegex.exec(template);
  }
  return template;
}
function parseForBlocks(template, context, filters) {
  const forBlockRegex = /{%\s*for\s+(\w+)\s+in\s+(\w+(?:\.\w+)*)\s*%}([\s\S]*?){%\s*endfor\s*%}/;
  let match = forBlockRegex.exec(template);
  while (match) {
    const [fullMatch, itemVar, arrayVar, blockContent] = match;
    let elseContent = "";
    let innerContent = blockContent;
    const elseRegex = /{%\s*else\s*%}([\s\S]*)$/;
    const elseMatch = elseRegex.exec(blockContent);
    if (elseMatch) {
      innerContent = blockContent.slice(0, elseMatch.index);
      elseContent = elseMatch[1];
    }
    const arr = getValueFromContext(arrayVar, context) || [];
    let replacement = "";
    if (Array.isArray(arr) && arr.length > 0) {
      for (const item of arr) {
        const newContext = { ...context, [itemVar]: item };
        let parsed = innerContent;
        parsed = parseIfBlocks(parsed, newContext, filters);
        parsed = parseForBlocks(parsed, newContext, filters);
        parsed = replaceVariables(parsed, newContext, filters);
        replacement += parsed;
      }
    } else if (typeof arr === "object" && Object.values(arr).length > 0) {
      for (const item of Object.values(arr)) {
        const newContext = { ...context, [itemVar]: item };
        let parsed = innerContent;
        parsed = parseIfBlocks(parsed, newContext, filters);
        parsed = parseForBlocks(parsed, newContext, filters);
        parsed = replaceVariables(parsed, newContext, filters);
        replacement += parsed;
      }
    } else {
      let parsedElse = elseContent;
      parsedElse = parseIfBlocks(parsedElse, context, filters);
      parsedElse = parseForBlocks(parsedElse, context, filters);
      parsedElse = replaceVariables(parsedElse, context, filters);
      replacement = parsedElse;
    }
    template = template.slice(0, match.index) + replacement + template.slice(match.index + fullMatch.length);
    match = forBlockRegex.exec(template);
  }
  return template;
}
function replaceVariables(template, context, filters) {
  return template.replace(/\{\{\s*(.*?)\s*\}\}/g, (_, expr) => {
    const parts = expr.split("|").map((p) => p.trim());
    const varPath = parts.shift() ?? "";
    let value = getValueFromContext(varPath, context) ?? "";
    for (const filterName of parts) {
      const fn = filters[filterName] || (filterName === "e" ? filters["escape"] : void 0);
      if (typeof fn === "function") {
        value = fn(value);
      }
    }
    return String(value);
  });
}
var TemplateManager = class _TemplateManager {
  /**
   * Render a template string with context
   */
  render(template, context, options) {
    const filters = {
      escape: escapeHtml,
      e: escapeHtml,
      // short alias
      ...options?.customFilters || {}
    };
    template = parseIfBlocks(template, context, filters);
    template = parseForBlocks(template, context, filters);
    template = replaceVariables(template, context, filters);
    return template;
  }
  /**
   * Render template with a simple function interface
   */
  static renderTemplate(template, context, customFilters = {}) {
    const manager = new _TemplateManager();
    return manager.render(template, context, { customFilters });
  }
};
function renderTemplate(template, context, customFilters = {}) {
  return TemplateManager.renderTemplate(template, context, customFilters);
}
function setRecursiveNames(obj, path = []) {
  if (!obj || typeof obj !== "object") {
    return;
  }
  if (!obj.id) {
    obj.id = nanoid.nanoid();
  }
  if (typeof obj.agent === "string") {
    const newPath = [...path, obj.agent];
    obj.name = newPath.join(" > ");
    if (Array.isArray(obj.input)) {
      for (const child of obj.input) {
        setRecursiveNames(child, newPath);
      }
    } else if (obj.input && typeof obj.input === "object") {
      setRecursiveNames(obj.input, newPath);
    }
    if (Array.isArray(obj.item)) {
      for (const child of obj.item) {
        setRecursiveNames(child, newPath);
      }
    } else if (obj.item && typeof obj.item === "object") {
      setRecursiveNames(obj.item, newPath);
    }
  } else {
    if (Array.isArray(obj.input)) {
      for (const child of obj.input) {
        setRecursiveNames(child, path);
      }
    } else if (obj.input && typeof obj.input === "object") {
      setRecursiveNames(obj.input, path);
    }
    if (Array.isArray(obj.item)) {
      for (const child of obj.item) {
        setRecursiveNames(child, path);
      }
    } else if (obj.item && typeof obj.item === "object") {
      setRecursiveNames(obj.item, path);
    }
  }
}
function getObjectByPath(obj, path) {
  if (!path.startsWith("$")) {
    throw new Error("Invalid path: Path should start with '$'");
  }
  const keys = path.replace(/\[(\d+)\]/g, ".$1").slice(2).split(".");
  let current = obj;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || !current.hasOwnProperty(key)) {
      return void 0;
    }
    current = current[key];
  }
  return current;
}
function isErrorWithMessage(error) {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string";
}
function toErrorWithMessage(maybeError) {
  if (isErrorWithMessage(maybeError)) return maybeError;
  try {
    return new Error(JSON.stringify(maybeError));
  } catch {
    return new Error(String(maybeError));
  }
}
function getErrorMessage(error) {
  return toErrorWithMessage(error).message;
}
function formatZodError(err) {
  let errorChunk = {
    type: "error",
    message: getErrorMessage(err)
  };
  if (err instanceof zod.ZodError) {
    const formattedIssues = err.issues.map((issue) => {
      const path = issue.path.join(".");
      const code = issue.code;
      return `Path: **${path}**; Code: **${code}**; Message: **${issue.message}**`;
    }).join("\n\n");
    errorChunk = {
      flowNodeId: nanoid.nanoid(),
      type: "error",
      message: formattedIssues
    };
  }
  return errorChunk;
}
function getZodErrorMessage(error) {
  return error.errors.map((e) => e.path[0] + ": " + e.message).join(", ");
}
function formatAxiosError(error) {
  if (error.isAxiosError) {
    const status = error.response?.status || "Unknown Status";
    const data = error.response?.data;
    let errorMessage = `HTTP Error ${status}`;
    if (data) {
      if (typeof data === "string") {
        errorMessage += `: ${data}`;
      } else if (typeof data === "object") {
        errorMessage += `: ${JSON.stringify(data, null, 2)}`;
      }
    } else {
      errorMessage += `: ${error.message}`;
    }
    return errorMessage;
  }
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

// src/utils/formatters.ts
function getCurrentTS() {
  return getTS();
}
function getTS(now = /* @__PURE__ */ new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const formattedDate = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  return formattedDate;
}
function formatDate(date) {
  return date.toLocaleString();
}
function safeJsonParse(str, defaultValue) {
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}
function removeCodeBlocks(text) {
  const PATTERN = /^([A-Za-z \t]*)```([A-Za-z]*)?\n([\s\S]*?)```([A-Za-z \t]*)*$/gm;
  return text.replace(PATTERN, "");
}
function countLines(text = "") {
  return text.split("\n").length;
}
function getLineNumber(text = "", matches) {
  return countLines(text.substr(0, matches.index));
}
function findCodeBlocks(block, singleBlockMode = true) {
  const PATTERN = /^([A-Za-z \t]*)```([A-Za-z]*)?\n([\s\S]*?)```([A-Za-z \t]*)*$/gm;
  let matches;
  const errors = [];
  const blocks = [];
  while ((matches = PATTERN.exec(block)) !== null) {
    if (matches.index === PATTERN.lastIndex) {
      PATTERN.lastIndex++;
    }
    const [match, prefix, syntax, content, postFix] = matches;
    const lang = syntax || "none";
    const lineNumber = getLineNumber(block, matches);
    let hasError = false;
    if (prefix && prefix.match(/\S/)) {
      hasError = true;
      errors.push({
        line: lineNumber,
        position: matches.index,
        message: `Prefix "${prefix}" not allowed on line ${lineNumber}. Remove it to fix the code block.`,
        block: match
      });
    }
    if (postFix && postFix.match(/\S/)) {
      hasError = true;
      const line = lineNumber + (countLines(match) - 1);
      errors.push({
        line,
        position: matches.index + match.length,
        message: `Postfix "${postFix}" not allowed on line ${line}. Remove it to fix the code block.`,
        block: match
      });
    }
    if (!hasError) {
      blocks.push({
        line: lineNumber,
        position: matches.index,
        syntax: lang,
        block: match,
        code: content.trim()
      });
    }
  }
  if (blocks.length === 0 && singleBlockMode) {
    blocks.push({
      line: 0,
      position: 0,
      syntax: "",
      block: "",
      code: block.trim()
    });
  }
  return {
    errors,
    blocks
  };
}
function checkApiKey(name, key, value) {
  if (value) return value;
  throw new Error(
    `Please provide the ${name} API key in the environment variable ${key}`
  );
}

// src/utils/validators.ts
function validateWithSchema(schema, data) {
  return schema.parse(data);
}
function safeValidate(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
function isValidJson(str) {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}
function sanitizeString(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function hasRequiredKeys(obj, requiredKeys) {
  return requiredKeys.every((key) => key in obj && obj[key] !== void 0);
}

// src/utils/file-extractor.ts
function getMimeType(base64Data) {
  const match = base64Data.match(/^data:([^;]+);base64,/);
  return match ? match[1] : null;
}
function getFileExtensionFromMimeType(mimeType) {
  const map = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "text/html": "html",
    "text/csv": "csv",
    "application/json": "json",
    "application/zip": "zip",
    "text/markdown": "md",
    "text/plain": "txt"
  };
  return map[mimeType] || "not_convertible";
}
function replaceBase64Content(data) {
  return data.replace(
    /data:image\/[a-zA-Z]+;base64,[a-zA-Z0-9+/=]+/g,
    "File content removed"
  );
}
function isBinaryData(buffer) {
  return buffer.some(
    (byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 || byte === 255
  );
}
function extractBase64Data(base64Str) {
  const parts = base64Str.split(",");
  if (parts.length < 2) {
    return base64Str;
  }
  return parts[1];
}
function createDataUri(mimeType, base64Data) {
  return `data:${mimeType};base64,${base64Data}`;
}

// src/index.ts
var VERSION = "1.0.0-alpha.8";

exports.Agent = Agent;
exports.AgentBuilder = AgentBuilder;
exports.AgentExecutionError = AgentExecutionError;
exports.AgentExecutor = AgentExecutor;
exports.AgentType = AgentType;
exports.Attachment = Attachment;
exports.ConfigManager = ConfigManager;
exports.ConfigurationError = ConfigurationError;
exports.ContextBuilder = ContextBuilder;
exports.DTOEncryptionFilter = DTOEncryptionFilter;
exports.DataLoadingStatus = DataLoadingStatus;
exports.EncryptionUtils = EncryptionUtils;
exports.FlowBuilder = FlowBuilder;
exports.FlowChunkType = FlowChunkType;
exports.FlowExecutionError = FlowExecutionError;
exports.FlowExecutor = FlowExecutor;
exports.INPUT_TYPE_LABELS = INPUT_TYPE_LABELS;
exports.LLMProviderError = LLMProviderError;
exports.LLMProviderRegistry = LLMProviderRegistry;
exports.Memory = Memory;
exports.MemoryManager = MemoryManager;
exports.MockAgentRepository = MockAgentRepository;
exports.MockAttachmentRepository = MockAttachmentRepository;
exports.MockLLMProvider = MockLLMProvider;
exports.MockMemoryRepository = MockMemoryRepository;
exports.MockResultRepository = MockResultRepository;
exports.MockSessionRepository = MockSessionRepository;
exports.OllamaProvider = OllamaProvider;
exports.OpenAIProvider = OpenAIProvider;
exports.RateLimitError = RateLimitError;
exports.Result = Result;
exports.RetryableOperation = RetryableOperation;
exports.SDKError = SDKError;
exports.Session = Session;
exports.StorageService = StorageService;
exports.TemplateManager = TemplateManager;
exports.TimeoutError = TimeoutError;
exports.ToolExecutionError = ToolExecutionError;
exports.ToolRegistry = ToolRegistry;
exports.VERSION = VERSION;
exports.ValidationError = ValidationError;
exports.agentTypesRegistry = agentTypesRegistry;
exports.applyInputTransformation = applyInputTransformation;
exports.checkApiKey = checkApiKey;
exports.convertFromFlowDefinition = convertFromFlowDefinition;
exports.convertToFlowDefinition = convertToFlowDefinition;
exports.createDataUri = createDataUri;
exports.createDynamicZodSchemaForInputs = createDynamicZodSchemaForInputs;
exports.createEmailTool = createEmailTool;
exports.createHttpTool = createHttpTool;
exports.createMockProvider = createMockProvider;
exports.currentDateTool = currentDateTool;
exports.dayNameTool = dayNameTool;
exports.extractBase64Data = extractBase64Data;
exports.extractVariableNames = extractVariableNames;
exports.findCodeBlocks = findCodeBlocks;
exports.formatAxiosError = formatAxiosError;
exports.formatDate = formatDate;
exports.formatZodError = formatZodError;
exports.generatePassword = generatePassword;
exports.getAgentTypeDescriptor = getAgentTypeDescriptor;
exports.getAllAgentTypeDescriptors = getAllAgentTypeDescriptors;
exports.getCurrentTS = getCurrentTS;
exports.getErrorMessage = getErrorMessage;
exports.getFileExtensionFromMimeType = getFileExtensionFromMimeType;
exports.getMimeType = getMimeType;
exports.getObjectByPath = getObjectByPath;
exports.getRetryDelay = getRetryDelay;
exports.getTS = getTS;
exports.getZodErrorMessage = getZodErrorMessage;
exports.globalToolRegistry = globalToolRegistry;
exports.hasRequiredKeys = hasRequiredKeys;
exports.httpTool = httpTool;
exports.injectVariables = injectVariables;
exports.isBinaryData = isBinaryData;
exports.isNetworkError = isNetworkError;
exports.isRetryableError = isRetryableError;
exports.isValidAgentType = isValidAgentType;
exports.isValidEmail = isValidEmail;
exports.isValidJson = isValidJson;
exports.isValidUrl = isValidUrl;
exports.removeCodeBlocks = removeCodeBlocks;
exports.renderTemplate = renderTemplate;
exports.replaceBase64Content = replaceBase64Content;
exports.replaceVariablesInString = replaceVariablesInString;
exports.retry = retry;
exports.retryBatch = retryBatch;
exports.retryOnError = retryOnError;
exports.retryWithTimeout = retryWithTimeout;
exports.safeJsonParse = safeJsonParse;
exports.safeValidate = safeValidate;
exports.sanitizeString = sanitizeString;
exports.setRecursiveNames = setRecursiveNames;
exports.sha256 = sha256;
exports.validateAgentConfig = validateAgentConfig;
exports.validateAgentDefinition = validateAgentDefinition;
exports.validateAgentTools = validateAgentTools;
exports.validateFlow = validateFlow;
exports.validateFlowInput = validateFlowInput;
exports.validateTokenQuotas = validateTokenQuotas;
exports.validateWithSchema = validateWithSchema;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map