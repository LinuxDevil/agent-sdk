import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Tool } from 'ai';
import type { LLMProvider, Message } from '../providers';
import { textOf } from '../providers';
import type { ResumeExecuteOptions } from './resume';
import { resumeAfterApproval } from './resume';
import { ApprovalStore, PendingApproval, ExecutionSnapshot } from './ApprovalGate';
import { AgentExecutor, PropagatingToolError } from './AgentExecutor';
import { Checkpoint, CheckpointStore } from './checkpoint';
import { createMockProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';
import type { Span } from './tracing';

/** Simple in-memory ApprovalStore, good enough for resume tests. */
function createInMemoryApprovalStore(): ApprovalStore {
  const records = new Map<string, { pending: PendingApproval; snapshot: ExecutionSnapshot }>();
  return {
    async save(pending, snapshot) {
      records.set(pending.id, { pending, snapshot });
    },
    async resolve(id) {
      const record = records.get(id);
      if (!record) {
        return null;
      }
      records.delete(id);
      return record;
    },
  };
}

/** Simple in-memory CheckpointStore, good enough for resume tests. */
function createInMemoryCheckpointStore(): CheckpointStore {
  const checkpoints = new Map<string, Checkpoint>();
  return {
    async save(sessionId, checkpoint) {
      checkpoints.set(sessionId, checkpoint);
    },
    async load(sessionId) {
      return checkpoints.get(sessionId) ?? null;
    },
    async delete(sessionId) {
      checkpoints.delete(sessionId);
    },
  };
}

describe('Execution - resumeAfterApproval', () => {
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
  });

  it('should run the deferred tool exactly once when approved', async () => {
    const execute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute } as Tool,
      needsApproval: true,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .build();

    const provider = createMockProvider({
      name: 'mock',
      responses: ['Charging now', 'All done'],
    });

    const approvalStore = createInMemoryApprovalStore();

    const paused = await AgentExecutor.execute({
      agent,
      input: 'Please call chargeCard now',
      provider,
      toolRegistry,
      approvalStore,
    });

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.approvalId).toBeDefined();
    expect(execute).not.toHaveBeenCalled();

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      provider
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(resumed.finishReason).toBe('stop');
    // pre-pause history (user + assistant) + 1 new tool-result message + the
    // final assistant reply ('All done', since this turn ends without a
    // further tool call).
    expect(resumed.messages).toHaveLength(paused.messages.length + 2);
    expect(resumed.messages.slice(0, paused.messages.length)).toEqual(paused.messages);
    expect(resumed.messages[paused.messages.length].role).toBe('tool');
    expect(resumed.messages[resumed.messages.length - 1]).toEqual({
      role: 'assistant',
      content: 'All done',
    });
  });

  it('should never invoke the tool and should produce a rejection message when rejected', async () => {
    const execute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute } as Tool,
      needsApproval: true,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .build();

    const provider = createMockProvider({
      name: 'mock',
      responses: ['Charging now', 'Understood, cancelled'],
    });

    const approvalStore = createInMemoryApprovalStore();

    const paused = await AgentExecutor.execute({
      agent,
      input: 'Please call chargeCard now',
      provider,
      toolRegistry,
      approvalStore,
    });

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: false, note: 'Not authorized' },
      approvalStore,
      toolRegistry,
      provider
    );

    expect(execute).not.toHaveBeenCalled();
    const rejectionMessage = resumed.messages[paused.messages.length];
    expect(rejectionMessage.role).toBe('tool');
    const parsed = JSON.parse(textOf(rejectionMessage));
    expect(parsed.note).toBe('Not authorized');
    expect(rejectionMessage.isError).toBe(true);
  });

  it('should not duplicate the system message when resuming an agent that has agent.prompt set', async () => {
    const execute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute } as Tool,
      needsApproval: true,
    });

    const systemPrompt = 'You are a careful billing assistant.';
    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .setPrompt(systemPrompt)
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .build();

    const provider = createMockProvider({
      name: 'mock',
      responses: ['Charging now', 'All done'],
    });

    const approvalStore = createInMemoryApprovalStore();

    const paused = await AgentExecutor.execute({
      agent,
      input: 'Please call chargeCard now',
      provider,
      toolRegistry,
      approvalStore,
    });

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.approvalId).toBeDefined();

    // Sanity check: exactly one system message before the pause too.
    const pausedSystemMessages = paused.messages.filter((m) => m.role === 'system');
    expect(pausedSystemMessages).toHaveLength(1);
    expect(pausedSystemMessages[0].content).toBe(systemPrompt);

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      provider
    );

    // Regression check for the resume duplicate-system-message bug: after
    // resuming, there must still be exactly ONE system message, matching
    // the original agent.prompt content - not two.
    const resumedSystemMessages = resumed.messages.filter((m) => m.role === 'system');
    expect(resumedSystemMessages).toHaveLength(1);
    expect(resumedSystemMessages[0].content).toBe(systemPrompt);
  });

  it('should resolve (not reject) with an error-shaped tool message when the deferred tool throws on resume', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('payment gateway timeout'));
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute } as Tool,
      needsApproval: true,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .build();

    const provider = createMockProvider({
      name: 'mock',
      responses: ['Charging now', 'All done'],
    });

    const approvalStore = createInMemoryApprovalStore();

    const paused = await AgentExecutor.execute({
      agent,
      input: 'Please call chargeCard now',
      provider,
      toolRegistry,
      approvalStore,
    });

    expect(paused.finishReason).toBe('awaiting-approval');

    // Should resolve, not reject, even though the deferred tool throws.
    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      provider
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const toolMessage = resumed.messages[paused.messages.length];
    expect(toolMessage.role).toBe('tool');
    const parsed = JSON.parse(textOf(toolMessage));
    expect(parsed).toEqual({ error: 'Error', toolName: 'chargeCard', message: 'payment gateway timeout', kind: 'execution' });
    expect(toolMessage.isError).toBe(true);
  });

  it('should reject (not resolve with an error-shaped tool message) when the deferred tool throws a PropagatingToolError on resume', async () => {
    // Reproduces the LOU-D reviewer finding: resume.ts's own catch/convert
    // block for the deferred tool's execute() call never got the same
    // PropagatingToolError special-case that AgentExecutor.executeToolCall
    // got in the AgentExecutor fix. A deferred tool that throws a
    // PropagatingToolError must propagate out of resumeAfterApproval() as a
    // rejected promise, not get swallowed into a {error} tool-result
    // message that would let the LLM see a normal failure and retry.
    const depthError = new PropagatingToolError('delegation depth exceeded');
    const execute = vi.fn().mockRejectedValue(depthError);
    toolRegistry.register('delegate', {
      displayName: 'Delegate',
      tool: { description: 'Delegate to a sub-agent', parameters: {}, execute } as Tool,
      needsApproval: true,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('delegate', { tool: 'delegate', options: {} })
      .build();

    const provider = createMockProvider({
      name: 'mock',
      responses: ['Delegating now', 'All done'],
    });

    const approvalStore = createInMemoryApprovalStore();

    const paused = await AgentExecutor.execute({
      agent,
      input: 'Please delegate now',
      provider,
      toolRegistry,
      approvalStore,
    });

    expect(paused.finishReason).toBe('awaiting-approval');

    // Before the fix, this would resolve with an {error}-shaped tool
    // message (the exact swallow-and-silently-continue pattern the
    // AgentExecutor fix exists to prevent). After the fix, it must reject
    // with the same PropagatingToolError instance instead.
    await expect(
      resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, toolRegistry, provider)
    ).rejects.toBe(depthError);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('should continue step-count accounting from the pre-pause step count on resume', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute } as Tool,
      needsApproval: true,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .build();

    // Scripted provider: two plain (no tool call) generations first, to
    // burn 2 steps, then a generation that triggers the approval-gated
    // tool call, then a final stop response after resume.
    let call = 0;
    const scriptedProvider = {
      name: 'scripted',
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => ['scripted'],
      stream: async () => {
        throw new Error('not implemented');
      },
      generate: async () => {
        call++;
        if (call <= 2) {
          return {
            text: `thinking step ${call}`,
            finishReason: 'stop' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        }
        if (call === 3) {
          return {
            text: 'calling chargeCard',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              {
                id: 'call-1',
                type: 'function' as const,
                function: { name: 'chargeCard', arguments: '{}' },
              },
            ],
          };
        }
        return {
          text: 'done',
          finishReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };

    const approvalStore = createInMemoryApprovalStore();

    // Force exactly one step per execute() call so the 2 "thinking" steps
    // are pre-pause history the *next* execute() call must pick up from.
    const firstStep = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: scriptedProvider as LLMProvider,
      toolRegistry,
      approvalStore,
      maxSteps: 1,
    });
    expect(firstStep.steps).toBe(1);

    const secondStep = await AgentExecutor.execute({
      agent,
      input: firstStep.messages,
      provider: scriptedProvider as LLMProvider,
      toolRegistry,
      approvalStore,
      maxSteps: firstStep.steps + 1,
      skipSystemPromptInjection: true,
      initialSteps: firstStep.steps,
    });
    expect(secondStep.steps).toBe(2);

    // Third call actually triggers the approval-gated tool call, continuing
    // from step 2.
    const paused = await AgentExecutor.execute({
      agent,
      input: secondStep.messages,
      provider: scriptedProvider as LLMProvider,
      toolRegistry,
      approvalStore,
      skipSystemPromptInjection: true,
      initialSteps: secondStep.steps,
    });
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.steps).toBe(3);

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      scriptedProvider as LLMProvider
    );

    // Continuation from step 3 (not reset to 0/1): one more generation
    // happens on resume, so steps should be 4.
    expect(resumed.steps).toBe(4);
  });

  it('reviewer repro: a stale checkpoint under the paused session must not clobber the resume state, even when sessionId+checkpointStore are explicitly passed through resume executeOptions', async () => {
    // Reproduces the LOU-C bug: combining sessionId+checkpointStore
    // (durable execution, LOU-C9/C10) with resumeAfterApproval() (approval
    // gate, LOU-C6) on the SAME session silently lost data, because
    // AgentExecutor's checkpoint-rehydration branch would unconditionally
    // override the resume's carefully-reconstructed messages/steps with
    // whatever stale checkpoint existed under that sessionId from before
    // the pause.
    const chargeExecute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute: chargeExecute } as Tool,
      needsApproval: true,
    });

    const lookupExecute = vi.fn().mockResolvedValue({ found: true });
    toolRegistry.register('lookup', {
      displayName: 'Lookup',
      tool: { description: 'Look something up', parameters: {}, execute: lookupExecute } as Tool,
      needsApproval: false,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('lookup', { tool: 'lookup', options: {} })
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .build();

    // Deterministic scripted provider: generation 1 calls the (unguarded)
    // 'lookup' tool - this is the "durable-execution step taken BEFORE the
    // pause" that gets checkpointed. Generation 2 calls the
    // approval-gated 'chargeCard' tool, which pauses execution before the
    // checkpoint for THIS step is ever written - so the checkpoint saved
    // after generation 1 is stale by construction from that point on.
    // Generation 3 (post-resume) stops with no further tool calls.
    let call = 0;
    const scriptedProvider = {
      name: 'scripted',
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => ['scripted'],
      stream: async () => {
        throw new Error('not implemented');
      },
      generate: async () => {
        call++;
        if (call === 1) {
          return {
            text: 'looking up',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              { id: 'call-lookup', type: 'function' as const, function: { name: 'lookup', arguments: '{}' } },
            ],
          };
        }
        if (call === 2) {
          return {
            text: 'charging',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              {
                id: 'call-charge',
                type: 'function' as const,
                function: { name: 'chargeCard', arguments: '{}' },
              },
            ],
          };
        }
        return {
          text: 'all done',
          finishReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };

    const approvalStore = createInMemoryApprovalStore();
    const checkpointStore = createInMemoryCheckpointStore();
    const sessionId = 'shared-session-1';

    const paused = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: scriptedProvider as LLMProvider,
      toolRegistry,
      approvalStore,
      sessionId,
      checkpointStore,
    });

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(lookupExecute).toHaveBeenCalledTimes(1);
    expect(chargeExecute).not.toHaveBeenCalled();

    // Sanity: a checkpoint really was written under this sessionId from
    // the pre-pause 'lookup' step, and it is stale relative to the pause
    // point (it doesn't know about the pending 'chargeCard' call at all).
    const preResumeCheckpoint = await checkpointStore.load(sessionId);
    expect(preResumeCheckpoint).not.toBeNull();
    // LOU-U8/U9: the checkpoint now records the pause itself (the model's
    // chargeCard turn was checkpointed before the tool gate ran).
    expect(preResumeCheckpoint!.status).toBe('awaiting-approval');
    expect(preResumeCheckpoint!.approvalId).toBe(paused.approvalId);
    expect(preResumeCheckpoint!.stepIndex).toBe(2);
    expect(preResumeCheckpoint!.messages.some((m) => m.toolName === 'chargeCard')).toBe(false);

    // The reviewer's repro: explicitly pass sessionId+checkpointStore
    // through resume's executeOptions (bypassing the ResumeExecuteOptions
    // Omit via a cast, exactly as a caller not using strict TS - or one
    // that force-casts - legally could at runtime).
    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      scriptedProvider as LLMProvider,
      { sessionId, checkpointStore } as ResumeExecuteOptions,
      checkpointStore
    );

    expect(chargeExecute).toHaveBeenCalledTimes(1);

    // The deferred tool's result must NOT be lost: it must be present in
    // the final message list, not silently dropped by falling back to the
    // stale checkpoint's messages (which never saw the chargeCard call).
    const chargeResultMessage = resumed.messages.find(
      (m) => m.role === 'tool' && m.toolName === 'chargeCard'
    );
    expect(chargeResultMessage).toBeDefined();
    expect(JSON.parse(textOf(chargeResultMessage!)).charged).toBe(true);

    // The lookup call/result from before the pause must also survive -
    // the stale checkpoint's own data isn't what's wrong here, silently
    // substituting it in place of the resume's own reconstruction is.
    expect(resumed.messages.some((m) => m.role === 'tool' && m.toolName === 'lookup')).toBe(true);

    // Full reconstructed history: user, assistant(lookup), tool(lookup),
    // assistant(chargeCard), tool(chargeCard), assistant('all done') - the
    // final generation returns no further tool calls, but its reply text is
    // still appended as the closing assistant message.
    expect(resumed.messages).toHaveLength(6);
    expect(resumed.messages[5]).toEqual({ role: 'assistant', content: 'all done' });

    // Steps must continue from the ExecutionSnapshot's own step count
    // (snapshot.steps was 2 at pause, +1 for the post-resume generation =
    // 3), NOT from the stale checkpoint's stepIndex (which was 1, and
    // would yield 2 if the checkpoint were wrongly rehydrated instead).
    expect(resumed.steps).toBe(3);

    // Defense in depth: the pre-pause checkpoint was cleared before the
    // resumed run started; what is stored now is that run's own 'finished'
    // checkpoint (LOU-U8), which includes the deferred chargeCard result.
    const finalCheckpoint = await checkpointStore.load(sessionId);
    expect(finalCheckpoint?.status).toBe('finished');
    expect(finalCheckpoint?.messages).toEqual(resumed.messages);
  });

  it('LOU-K5: writes a NEW checkpoint for a tool-call step taken after a successful resume, when a checkpointStore is supplied', async () => {
    // Reproduces/verifies the LOU-K5 fix: resumeAfterApproval() used to
    // force sessionId/checkpointStore to `undefined` on the follow-up
    // execute() call, which silently disabled checkpointing for the whole
    // remainder of the resumed run. This test drives the resumed run
    // through one MORE (non-approval-gated) tool call after the approved
    // 'chargeCard' call, and asserts AgentExecutor's normal per-tool-result
    // checkpoint.save() fires for that later step - proving durability is
    // restored for the post-resume portion of the run, not just re-armed
    // and immediately turned back off.
    const chargeExecute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute: chargeExecute } as Tool,
      needsApproval: true,
    });

    const lookupExecute = vi.fn().mockResolvedValue({ found: true });
    toolRegistry.register('lookup', {
      displayName: 'Lookup',
      tool: { description: 'Look something up', parameters: {}, execute: lookupExecute } as Tool,
      needsApproval: false,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .addTool('lookup', { tool: 'lookup', options: {} })
      .build();

    // Generation 1: calls the approval-gated chargeCard tool (pauses).
    // Generation 2 (post-resume): calls the unguarded lookup tool - this is
    // the "one more tool-call step after resume" that must get checkpointed.
    // Generation 3: stops with no further tool calls.
    let call = 0;
    const scriptedProvider = {
      name: 'scripted',
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => ['scripted'],
      stream: async () => {
        throw new Error('not implemented');
      },
      generate: async () => {
        call++;
        if (call === 1) {
          return {
            text: 'charging',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              { id: 'call-charge', type: 'function' as const, function: { name: 'chargeCard', arguments: '{}' } },
            ],
          };
        }
        if (call === 2) {
          return {
            text: 'looking up',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              { id: 'call-lookup', type: 'function' as const, function: { name: 'lookup', arguments: '{}' } },
            ],
          };
        }
        return {
          text: 'all done',
          finishReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };

    const approvalStore = createInMemoryApprovalStore();
    const checkpointStore = createInMemoryCheckpointStore();
    const saveSpy = vi.spyOn(checkpointStore, 'save');
    const sessionId = 'post-resume-checkpoint-session';

    const paused = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: scriptedProvider as LLMProvider,
      toolRegistry,
      approvalStore,
      sessionId,
      checkpointStore,
    });

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(chargeExecute).not.toHaveBeenCalled();
    saveSpy.mockClear();

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      scriptedProvider as LLMProvider,
      {},
      checkpointStore
    );

    expect(resumed.finishReason).toBe('stop');
    expect(chargeExecute).toHaveBeenCalledTimes(1);
    expect(lookupExecute).toHaveBeenCalledTimes(1);

    // A NEW checkpoint must have been saved (under the same sessionId) for
    // the post-resume 'lookup' step - this is the forward-checkpointing
    // this fix restores. Before the fix, sessionId/checkpointStore were
    // forced to undefined on the resumed execute() call, so this save()
    // would never have been reached at all.
    expect(saveSpy).toHaveBeenCalled();
    const savedCheckpoint = saveSpy.mock.calls[saveSpy.mock.calls.length - 1][1];
    expect(savedCheckpoint.sessionId).toBe(sessionId);
    // The saved checkpoint's messages must include BOTH the deferred
    // chargeCard result (reconstructed by resume.ts) and the post-resume
    // lookup result (checkpointed by AgentExecutor's normal loop) - proof
    // this checkpoint reflects genuinely new, post-resume progress rather
    // than a rehydrated/duplicated stale snapshot.
    expect(savedCheckpoint.messages.some((m: Message) => m.toolName === 'chargeCard')).toBe(true);
    expect(savedCheckpoint.messages.some((m: Message) => m.toolName === 'lookup')).toBe(true);

    // The run reached a terminal state, so its checkpoint is kept, marked
    // 'finished', for session continuation (LOU-U8).
    expect((await checkpointStore.load(sessionId))?.status).toBe('finished');
  });

  it('LOU-T1: carries businessState across a pause-for-approval -> approve -> resume cycle without the resumed call re-passing it', async () => {
    // AgentExecutor only writes a checkpoint AFTER a tool result is
    // appended (see AgentExecutor.ts's requiresApproval early-return, which
    // returns *before* reaching that save() call) - so the pause-for-
    // approval step itself never gets its own checkpoint. To exercise the
    // realistic "businessState carried forward via the stale checkpoint"
    // path, this scenario runs one unguarded 'lookup' tool call first (that
    // DOES get checkpointed, businessState included) before the
    // approval-gated 'chargeCard' call pauses the run.
    const lookupExecute = vi.fn().mockResolvedValue({ found: true });
    toolRegistry.register('lookup', {
      displayName: 'Lookup',
      tool: { description: 'Look something up', parameters: {}, execute: lookupExecute } as Tool,
      needsApproval: false,
    });

    const chargeExecute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute: chargeExecute } as Tool,
      needsApproval: true,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('lookup', { tool: 'lookup', options: {} })
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .build();

    let call = 0;
    const scriptedProvider = {
      name: 'scripted',
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => ['scripted'],
      stream: async () => {
        throw new Error('not implemented');
      },
      generate: async () => {
        call++;
        if (call === 1) {
          return {
            text: 'looking up',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              { id: 'call-lookup', type: 'function' as const, function: { name: 'lookup', arguments: '{}' } },
            ],
          };
        }
        if (call === 2) {
          return {
            text: 'charging',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              { id: 'call-charge', type: 'function' as const, function: { name: 'chargeCard', arguments: '{}' } },
            ],
          };
        }
        if (call === 3) {
          // A post-resume, unguarded tool call - needed so AgentExecutor's
          // normal per-tool-result checkpoint.save() actually fires during
          // the resumed run (approving 'chargeCard' alone triggers no
          // further save() inside AgentExecutor's loop).
          return {
            text: 'looking up again',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              { id: 'call-lookup-2', type: 'function' as const, function: { name: 'lookup', arguments: '{}' } },
            ],
          };
        }
        return {
          text: 'all done',
          finishReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };

    const approvalStore = createInMemoryApprovalStore();
    const checkpointStore = createInMemoryCheckpointStore();
    const sessionId = 'business-state-pause-resume-session';

    const paused = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: scriptedProvider as LLMProvider,
      toolRegistry,
      approvalStore,
      sessionId,
      checkpointStore,
      businessState: { orderId: 'ord_777', stage: 'awaiting-approval' },
    });

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(lookupExecute).toHaveBeenCalledTimes(1);
    expect(chargeExecute).not.toHaveBeenCalled();

    // Confirm the pre-pause checkpoint (written for the 'lookup' step) does
    // carry businessState, proving it was durably written before the pause
    // (not just held in in-memory options).
    const prePauseCheckpoint = await checkpointStore.load(sessionId);
    expect(prePauseCheckpoint!.businessState).toEqual({
      orderId: 'ord_777',
      stage: 'awaiting-approval',
    });

    const saveSpy = vi.spyOn(checkpointStore, 'save');

    // Deliberately do NOT pass businessState in executeOptions here - it
    // must be carried forward by resumeAfterApproval() itself, read off the
    // stale pre-pause checkpoint before that checkpoint is deleted.
    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      scriptedProvider as LLMProvider,
      {},
      checkpointStore
    );

    expect(resumed.finishReason).toBe('stop');
    expect(chargeExecute).toHaveBeenCalledTimes(1);
    expect(lookupExecute).toHaveBeenCalledTimes(2);

    // The run reached a terminal state, so the checkpoint is kept, marked
    // 'finished' (LOU-U8) - and every save the resumed run made along the way
    // must have carried the businessState forward.
    expect(saveSpy).toHaveBeenCalled();
    for (const [, checkpoint] of saveSpy.mock.calls) {
      expect((checkpoint as Checkpoint).businessState).toEqual({
        orderId: 'ord_777',
        stage: 'awaiting-approval',
      });
    }
    expect((await checkpointStore.load(sessionId))?.status).toBe('finished');
  });

  it('LOU-T1: an explicit businessState passed to resumeAfterApproval() overrides the stale pre-pause checkpoint value', async () => {
    const chargeExecute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute: chargeExecute } as Tool,
      needsApproval: true,
    });

    const lookupExecute = vi.fn().mockResolvedValue({ found: true });
    toolRegistry.register('lookup', {
      displayName: 'Lookup',
      tool: { description: 'Look something up', parameters: {}, execute: lookupExecute } as Tool,
      needsApproval: false,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .addTool('lookup', { tool: 'lookup', options: {} })
      .build();

    let call = 0;
    const scriptedProvider = {
      name: 'scripted',
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => ['scripted'],
      stream: async () => {
        throw new Error('not implemented');
      },
      generate: async () => {
        call++;
        if (call === 1) {
          return {
            text: 'charging',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              { id: 'call-charge', type: 'function' as const, function: { name: 'chargeCard', arguments: '{}' } },
            ],
          };
        }
        if (call === 2) {
          // Post-resume, unguarded tool call so AgentExecutor's normal
          // per-tool-result checkpoint.save() actually fires during the
          // resumed run.
          return {
            text: 'looking up',
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            toolCalls: [
              { id: 'call-lookup', type: 'function' as const, function: { name: 'lookup', arguments: '{}' } },
            ],
          };
        }
        return {
          text: 'all done',
          finishReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };

    const approvalStore = createInMemoryApprovalStore();
    const checkpointStore = createInMemoryCheckpointStore();
    const saveSpy = vi.spyOn(checkpointStore, 'save');
    const sessionId = 'business-state-override-session';

    const paused = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: scriptedProvider as LLMProvider,
      toolRegistry,
      approvalStore,
      sessionId,
      checkpointStore,
      businessState: { stage: 'stale-value' },
    });

    expect(paused.finishReason).toBe('awaiting-approval');
    saveSpy.mockClear();

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      scriptedProvider as LLMProvider,
      { businessState: { stage: 'explicitly-overridden' } },
      checkpointStore
    );

    expect(resumed.finishReason).toBe('stop');
    expect(saveSpy).toHaveBeenCalled();
    for (const [, checkpoint] of saveSpy.mock.calls) {
      expect((checkpoint as Checkpoint).businessState).toEqual({ stage: 'explicitly-overridden' });
    }
  });

  it('LOU-K5: resuming without a checkpointStore still works exactly as before (no crash, no checkpoint attempted)', async () => {
    // Guards the "fully optional/backward compatible" requirement: a
    // caller that never passes a checkpointStore to resumeAfterApproval()
    // must see identical behavior to before this fix - sessionId and
    // checkpointStore simply stay undefined on the follow-up execute()
    // call, so AgentExecutor's rehydration/save/delete branches (all
    // gated on `sessionId && checkpointStore`) are never entered.
    const execute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute } as Tool,
      needsApproval: true,
    });

    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .build();

    const provider = createMockProvider({
      name: 'mock',
      responses: ['Charging now', 'All done'],
    });

    const approvalStore = createInMemoryApprovalStore();

    const paused = await AgentExecutor.execute({
      agent,
      input: 'Please call chargeCard now',
      provider,
      toolRegistry,
      approvalStore,
      // Deliberately no sessionId/checkpointStore anywhere in this test.
    });

    expect(paused.finishReason).toBe('awaiting-approval');

    // No checkpointStore argument at all (not even undefined explicitly).
    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      provider
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(resumed.finishReason).toBe('stop');
  });

  it('should throw a clear error for an unknown or already-resolved approval id', async () => {
    const approvalStore = createInMemoryApprovalStore();
    const provider = createMockProvider({ name: 'mock' });

    await expect(
      resumeAfterApproval({ id: 'never-existed', approved: true }, approvalStore, toolRegistry, provider)
    ).rejects.toMatchObject({ message: expect.stringMatching(/No pending approval/), code: 'LOUSHO_APPROVAL_NOT_FOUND' });
  });

  describe('hooks (LOU-Q1)', () => {
    it('fires preToolCall/postToolCall hooks for the deferred, post-approval tool execution', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      const events: string[] = [];
      hooks.register({
        name: 'audit-log',
        preToolCall: (ctx) => { events.push(`pre:${ctx.toolName}`); },
        postToolCall: (ctx, result) => { events.push(`post:${ctx.toolName}:${JSON.stringify(result.result)}`); },
      });

      const execute = vi.fn().mockResolvedValue({ charged: true });
      toolRegistry.register('chargeCard', {
        displayName: 'Charge Card',
        tool: { description: 'Charge a card', parameters: {}, execute } as Tool,
        needsApproval: true,
      });

      const agent = AgentBuilder.create()
        .setName('Test Agent')
        .addTool('chargeCard', { tool: 'chargeCard', options: {} })
        .build();

      const provider = createMockProvider({
        name: 'mock',
        responses: ['Charging now', 'All done'],
      });

      const approvalStore = createInMemoryApprovalStore();

      const paused = await AgentExecutor.execute({
        agent,
        input: 'Please call chargeCard now',
        provider,
        toolRegistry,
        approvalStore,
      });

      // No hooks were passed to the initial execute() call above, so no
      // hook events yet - the approval-required outcome never reaches
      // executeToolCall()'s hook wiring in this run.
      expect(events).toEqual([]);

      const resumed = await resumeAfterApproval(
        { id: paused.approvalId!, approved: true },
        approvalStore,
        toolRegistry,
        provider,
        { hooks }
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(resumed.finishReason).toBe('stop');
      expect(events).toEqual(['pre:chargeCard', 'post:chargeCard:{"charged":true}']);
    });

    it('sets ctx.resumedAfterApproval only on the post-approval re-fire, so stateful hooks can skip it', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      const seen: Array<boolean | undefined> = [];
      const postSeen: Array<boolean | undefined> = [];
      hooks.register({
        name: 'loop-guard',
        preToolCall: (ctx) => {
          seen.push(ctx.resumedAfterApproval);
        },
        postToolCall: (ctx) => {
          postSeen.push(ctx.resumedAfterApproval);
        },
      });

      const execute = vi.fn().mockResolvedValue({ charged: true });
      toolRegistry.register('chargeCard', {
        displayName: 'Charge Card',
        tool: { description: 'Charge a card', parameters: {}, execute } as Tool,
        needsApproval: true,
      });

      const agent = AgentBuilder.create()
        .setName('Test Agent')
        .addTool('chargeCard', { tool: 'chargeCard', options: {} })
        .build();

      const provider = createMockProvider({ name: 'mock', responses: ['Charging now', 'All done'] });
      const approvalStore = createInMemoryApprovalStore();

      // The paused run's own gate fires the hook once, before the approval check.
      const paused = await AgentExecutor.execute({ agent, input: 'Please call chargeCard now', provider, toolRegistry, approvalStore, hooks });
      expect(paused.finishReason).toBe('awaiting-approval');
      expect(seen).toEqual([undefined]);

      const resumed = await resumeAfterApproval(
        { id: paused.approvalId!, approved: true },
        approvalStore,
        toolRegistry,
        provider,
        { hooks }
      );

      expect(resumed.finishReason).toBe('stop');
      // The re-fire is flagged; the first fire was not. postToolCall fires on
      // the paused run too (approval-required settles the call), flagged only on resume.
      expect(seen).toEqual([undefined, true]);
      expect(postSeen).toEqual([undefined, true]);
    });

    it('a preToolCall hook that redacts args also on the paused run: the human approved the redacted input, which the deferred tool runs with', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      hooks.register({
        name: 'redact-pii',
        preToolCall: (ctx) => { ctx.args.email = '[REDACTED]'; },
      });

      const execute = vi.fn().mockResolvedValue({ sent: true });
      toolRegistry.register('sendEmail', {
        displayName: 'Send Email',
        tool: { description: 'send email', parameters: {}, execute } as Tool,
        needsApproval: true,
      });

      const agent = AgentBuilder.create()
        .setName('Test Agent')
        .addTool('sendEmail', { tool: 'sendEmail', options: {} })
        .build();

      // Scripted provider emits a tool call carrying a real `email` arg -
      // the built-in MockLLMProvider always synthesizes empty `{}` args, so
      // it can't exercise argument mutation.
      const scriptedProvider = {
        name: 'scripted',
        supportsTools: () => true,
        supportsStreaming: () => false,
        getModels: async () => ['scripted'],
        stream: async () => { throw new Error('not implemented'); },
        generate: async () => ({
          text: '',
          finishReason: 'tool_calls' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          toolCalls: [
            {
              id: 'call-1',
              type: 'function' as const,
              function: { name: 'sendEmail', arguments: JSON.stringify({ email: 'real@example.com' }) },
            },
          ],
        }),
      };

      const approvalStore = createInMemoryApprovalStore();

      const paused = await AgentExecutor.execute({
        agent,
        input: 'email real@example.com',
        provider: scriptedProvider as LLMProvider,
        toolRegistry,
        approvalStore,
        hooks,
      });

      expect(paused.finishReason).toBe('awaiting-approval');

      const provider = createMockProvider({ name: 'mock', responses: ['Sending', 'Done'] });

      await resumeAfterApproval(
        { id: paused.approvalId!, approved: true },
        approvalStore,
        toolRegistry,
        provider,
        { hooks }
      );

      // LOU-X3.2: the approval carries the redacted input, so the hook's rewrite on resume is a no-op.
      expect(execute).toHaveBeenCalledWith({ email: '[REDACTED]' }, expect.objectContaining({ toolCallId: 'call-1', messages: expect.any(Array) }));
    });

    it('LOU-X3.2: a preToolCall hook that only exists on resume and changes args in place is refused', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      hooks.register({ name: 'redact-pii', preToolCall: (ctx) => { ctx.args.email = '[REDACTED]'; } });
      const execute = vi.fn().mockResolvedValue({ sent: true });
      toolRegistry.register('sendEmail', {
        displayName: 'Send Email',
        tool: { description: 'send email', parameters: {}, execute } as never,
        needsApproval: true,
      });
      const agent = AgentBuilder.create().setName('Test Agent').addTool('sendEmail', { tool: 'sendEmail', options: {} }).build();
      const call = { id: 'call-1', type: 'function' as const, function: { name: 'sendEmail', arguments: JSON.stringify({ email: 'real@example.com' }) } };
      const scripted = {
        name: 'scripted',
        supportsTools: () => true,
        supportsStreaming: () => false,
        getModels: async () => ['scripted'],
        stream: async () => { throw new Error('not implemented'); },
        generate: async () => ({ text: '', finishReason: 'tool_calls' as const, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, toolCalls: [call] }),
      };
      const approvalStore = createInMemoryApprovalStore();
      const paused = await AgentExecutor.execute({ agent, input: 'email', provider: scripted as never, toolRegistry, approvalStore });

      const resumed = await resumeAfterApproval(
        { id: paused.approvalId!, approved: true },
        approvalStore,
        toolRegistry,
        createMockProvider({ name: 'mock', responses: ['Done'] }),
        { hooks }
      );

      expect(execute).not.toHaveBeenCalled();
      expect(resumed.messages.find((m) => m.role === 'tool')?.content).toContain('approved with different input');
    });

    it('LOU-X3.2: a hook that rebuilds the same arguments with the keys in another order is not refused', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      hooks.register({ name: 'reorder', preToolCall: (ctx) => { const { a, b } = ctx.args; ctx.args = { b, a }; } });
      const execute = vi.fn().mockResolvedValue({ ok: true });
      toolRegistry.register('reorder', {
        displayName: 'Reorder',
        tool: { description: 'x', parameters: {}, execute } as never,
        needsApproval: true,
      });
      const agent = AgentBuilder.create().setName('Test Agent').addTool('reorder', { tool: 'reorder', options: {} }).build();
      const call = { id: 'call-1', type: 'function' as const, function: { name: 'reorder', arguments: JSON.stringify({ a: 1, b: { c: 2, d: 3 } }) } };
      const scripted = {
        name: 'scripted',
        supportsTools: () => true,
        supportsStreaming: () => false,
        getModels: async () => ['scripted'],
        stream: async () => { throw new Error('not implemented'); },
        generate: async () => ({ text: '', finishReason: 'tool_calls' as const, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, toolCalls: [call] }),
      };
      const approvalStore = createInMemoryApprovalStore();
      const paused = await AgentExecutor.execute({ agent, input: 'go', provider: scripted as never, toolRegistry, approvalStore });

      await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, toolRegistry, createMockProvider({ name: 'mock', responses: ['Done'] }), { hooks });

      expect(execute).toHaveBeenCalledWith({ b: { c: 2, d: 3 }, a: 1 }, expect.anything());
    });

    it('a postToolCall hook that throws on the resume path propagates as a rejected promise, not a swallowed {error} tool-result', async () => {
      // Regression test: resumeAfterApproval() used to run runPostToolCall()
      // INSIDE the same try/catch that converts a thrown tool error into a
      // graceful {error} tool-result message. That meant a postToolCall
      // hook's own thrown error (e.g. a rate-limit hook meaning to HALT the
      // run) was caught by that generic handler and silently turned into a
      // benign tool-result instead of propagating - directly contradicting
      // HookRegistry's documented "hook errors abort the step and
      // propagate, never silently swallowed" contract (see hooks.ts).
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      const hookError = new Error('rate limit exceeded');
      hooks.register({
        name: 'rate-limit',
        postToolCall: () => {
          throw hookError;
        },
      });

      const execute = vi.fn().mockResolvedValue({ charged: true });
      toolRegistry.register('chargeCard', {
        displayName: 'Charge Card',
        tool: { description: 'Charge a card', parameters: {}, execute } as Tool,
        needsApproval: true,
      });

      const agent = AgentBuilder.create()
        .setName('Test Agent')
        .addTool('chargeCard', { tool: 'chargeCard', options: {} })
        .build();

      const provider = createMockProvider({
        name: 'mock',
        responses: ['Charging now', 'All done'],
      });

      const approvalStore = createInMemoryApprovalStore();

      const paused = await AgentExecutor.execute({
        agent,
        input: 'Please call chargeCard now',
        provider,
        toolRegistry,
        approvalStore,
      });

      expect(paused.finishReason).toBe('awaiting-approval');

      await expect(
        resumeAfterApproval(
          { id: paused.approvalId!, approved: true },
          approvalStore,
          toolRegistry,
          provider,
          { hooks }
        )
      ).rejects.toBe(hookError);

      // The tool itself DID run (the hook fires AFTER the tool settles) -
      // it's the hook's own error that must propagate, not be swallowed.
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Execution - resumeAfterApproval: the span of the approved call (#281)', () => {
  const approvedRun = async (executeOptions: ResumeExecuteOptions) => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute: async () => ({ charged: true }) } as Tool,
      needsApproval: true,
    });
    const agent = AgentBuilder.create().setName('Test Agent').addTool('chargeCard', { tool: 'chargeCard', options: {} }).build();
    const provider = createMockProvider({ name: 'mock', responses: ['Charging now', 'All done'] });
    const approvalStore = createInMemoryApprovalStore();
    const paused = await AgentExecutor.execute({ agent, input: 'Please call chargeCard now', provider, toolRegistry, approvalStore });
    const ended: Span[] = [];
    const exporter = { onSpanStart: () => {}, onSpanEnd: (span: Span) => void ended.push({ ...span }) };
    await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, toolRegistry, provider, { exporter, ...executeOptions });
    return ended.find((span) => span.attributes['gen_ai.operation.name'] === 'execute_tool')!;
  };

  it('keeps the call arguments and result off the span with redactContent, and on it with captureContent', async () => {
    const redacted = await approvedRun({ redactContent: true });
    expect(redacted.attributes.args).toBeUndefined();
    expect(redacted.attributes.result).toBeUndefined();
    expect(redacted.attributes['gen_ai.tool.call.result']).toBeUndefined();

    const captured = await approvedRun({ captureContent: true });
    expect(captured.attributes.result).toEqual({ charged: true });
    expect(captured.attributes['gen_ai.tool.call.result']).toBe('{"charged":true}');
  });
});
