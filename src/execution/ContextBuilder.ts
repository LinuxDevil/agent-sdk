/**
 * Context Builder
 * Builds execution context for agent runs
 */

import { AgentConfig } from '../types';
import { Message } from '../providers';
import { Memory } from '../data';
import { MemoryManager } from './MemoryManager';

/**
 * Context builder options
 */
export interface ContextBuilderOptions {
  agent: AgentConfig;
  input: string | Message[];
  sessionHistory?: Message[];
  memoryManager?: MemoryManager;
  variables?: Record<string, any>;
  systemPrompt?: string;
  maxHistoryMessages?: number;
  maxMemories?: number;
}

/**
 * Built context
 */
export interface ExecutionContext {
  messages: Message[];
  variables: Record<string, any>;
  systemPrompt: string;
  metadata: {
    agentId: string;
    agentName: string;
    agentType: string;
    hasMemories: boolean;
    memoryCount: number;
    historyCount: number;
  };
}

/**
 * Context Builder
 * 
 * Builds execution context from agent config, input, session history, and memories.
 * 
 * @example
 * ```typescript
 * const context = await ContextBuilder.build({
 *   agent: myAgent,
 *   input: 'Hello!',
 *   sessionHistory: previousMessages,
 *   memoryManager,
 *   variables: { userName: 'Alice' },
 * });
 * 
 * // Use context in execution
 * const result = await provider.generate({
 *   messages: context.messages,
 *   temperature: 0.7,
 * });
 * ```
 */
export class ContextBuilder {
  /**
   * Build execution context
   */
  static async build(
    options: ContextBuilderOptions
  ): Promise<ExecutionContext> {
    const {
      agent,
      input,
      sessionHistory = [],
      memoryManager,
      variables = {},
      systemPrompt,
      maxHistoryMessages = 20,
      maxMemories = 5,
    } = options;

    // 1. Build system prompt
    let finalSystemPrompt = await this.buildSystemPrompt({
      agent,
      systemPrompt,
      memoryManager,
      maxMemories,
    });

    // 2. Inject variables into system prompt
    finalSystemPrompt = this.interpolateVariables(finalSystemPrompt, variables);

    // 3. Build message array
    const messages = await this.buildMessages({
      systemPrompt: finalSystemPrompt,
      input,
      sessionHistory,
      maxHistoryMessages,
    });

    // 4. Inject variables into messages
    const processedMessages = this.injectVariables(messages, variables);

    // 5. Build metadata
    const metadata = {
      agentId: agent.id || '',
      agentName: agent.name,
      agentType: agent.agentType as string,
      hasMemories: !!memoryManager,
      memoryCount: 0, // Will be updated if memories are recalled
      historyCount: sessionHistory.length,
    };

    return {
      messages: processedMessages,
      variables,
      systemPrompt: finalSystemPrompt,
      metadata,
    };
  }

  /**
   * Build system prompt with agent instructions and memories
   */
  private static async buildSystemPrompt(options: {
    agent: AgentConfig;
    systemPrompt?: string;
    memoryManager?: MemoryManager;
    maxMemories: number;
  }): Promise<string> {
    const { agent, systemPrompt, memoryManager, maxMemories } = options;

    const parts: string[] = [];

    // Add agent name and role first
    if (agent.name) {
      parts.push(`You are ${agent.name}.`);
    }

    // Add agent metadata description if available
    if (agent.metadata?.description) {
      parts.push(agent.metadata.description);
    }

    // Add custom system prompt or agent prompt
    const prompt = systemPrompt || agent.prompt || '';
    if (prompt) {
      parts.push(prompt);
    }

    // Recall and inject relevant memories
    if (memoryManager && agent.id) {
      const memories = await memoryManager.recall({
        agentId: agent.id,
        limit: maxMemories,
        minRelevance: 0.3, // Lower threshold for when no query/embedding provided
      });

      if (memories.length > 0) {
        const memoryText = memories
          .map((m, i) => `${i + 1}. ${m.memory.content}`)
          .join('\n');

        parts.push(`## Relevant Memories\n${memoryText}`);
      }
    }

    return parts.filter(p => p).join('\n\n').trim();
  }

  /**
   * Build message array from input and history
   */
  private static async buildMessages(options: {
    systemPrompt: string;
    input: string | Message[];
    sessionHistory: Message[];
    maxHistoryMessages: number;
  }): Promise<Message[]> {
    const { systemPrompt, input, sessionHistory, maxHistoryMessages } = options;

    const messages: Message[] = [];

    // Add system message
    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    // Add session history (limited)
    const limitedHistory = sessionHistory.slice(-maxHistoryMessages);
    messages.push(...limitedHistory);

    // Add current input
    if (typeof input === 'string') {
      messages.push({
        role: 'user',
        content: input,
      });
    } else {
      messages.push(...input);
    }

    return messages;
  }

  /**
   * Inject variables into messages
   */
  private static injectVariables(
    messages: Message[],
    variables: Record<string, any>
  ): Message[] {
    if (Object.keys(variables).length === 0) {
      return messages;
    }

    return messages.map((message) => {
      if (typeof message.content === 'string') {
        return {
          ...message,
          content: this.interpolateVariables(message.content, variables),
        };
      }
      return message;
    });
  }

  /**
   * Interpolate variables in text ({{variable}} syntax)
   */
  private static interpolateVariables(
    text: string,
    variables: Record<string, any>
  ): string {
    return text.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      const value = variables[varName];
      if (value === undefined) {
        return match; // Keep original if variable not found
      }
      return String(value);
    });
  }

  /**
   * Merge multiple contexts (useful for multi-agent scenarios)
   */
  static merge(...contexts: ExecutionContext[]): ExecutionContext {
    if (contexts.length === 0) {
      throw new Error('At least one context is required');
    }

    if (contexts.length === 1) {
      return contexts[0];
    }

    const merged: ExecutionContext = {
      messages: [],
      variables: {},
      systemPrompt: '',
      metadata: {
        agentId: contexts[0].metadata.agentId,
        agentName: contexts[0].metadata.agentName,
        agentType: contexts[0].metadata.agentType,
        hasMemories: false,
        memoryCount: 0,
        historyCount: 0,
      },
    };

    // Merge messages (deduplicate system messages)
    const systemMessages: Message[] = [];
    const otherMessages: Message[] = [];

    for (const context of contexts) {
      for (const message of context.messages) {
        if (message.role === 'system') {
          // Only add unique system messages
          if (
            !systemMessages.some((m) => m.content === message.content)
          ) {
            systemMessages.push(message);
          }
        } else {
          otherMessages.push(message);
        }
      }
    }

    merged.messages = [...systemMessages, ...otherMessages];

    // Merge variables (later contexts override earlier ones)
    for (const context of contexts) {
      merged.variables = { ...merged.variables, ...context.variables };
    }

    // Merge system prompts
    merged.systemPrompt = contexts
      .map((c) => c.systemPrompt)
      .filter((p) => p)
      .join('\n\n---\n\n');

    // Merge metadata
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
  static clone(
    context: ExecutionContext,
    modifications?: Partial<ExecutionContext>
  ): ExecutionContext {
    return {
      messages: modifications?.messages || [...context.messages],
      variables: modifications?.variables || { ...context.variables },
      systemPrompt: modifications?.systemPrompt || context.systemPrompt,
      metadata: modifications?.metadata || { ...context.metadata },
    };
  }

  /**
   * Extract variables from context messages
   */
  static extractVariables(context: ExecutionContext): string[] {
    const variables = new Set<string>();
    const regex = /\{\{(\w+)\}\}/g;

    for (const message of context.messages) {
      if (typeof message.content === 'string') {
        let match;
        while ((match = regex.exec(message.content)) !== null) {
          variables.add(match[1]);
        }
      }
    }

    return Array.from(variables);
  }

  /**
   * Validate context has all required variables
   */
  static validate(context: ExecutionContext): {
    valid: boolean;
    missingVariables: string[];
  } {
    const requiredVariables = this.extractVariables(context);
    const missingVariables = requiredVariables.filter(
      (varName) => context.variables[varName] === undefined
    );

    return {
      valid: missingVariables.length === 0,
      missingVariables,
    };
  }
}
