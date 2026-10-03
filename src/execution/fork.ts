/**
 * Fork and replay (LOU-D44): a new session that starts from a checkpoint in
 * another session's history, optionally patched, and resumes like any
 * unfinished run.
 */

import type { Message } from '../providers';
import type { Checkpoint, CheckpointStore, ForkOptions, ForkPatch, ForkResult } from './checkpoint';
import { toolResultContent } from './toolResult';
import { ConfigurationError, SDKError } from './errors';

/** `<sessionId>.fork-<n>` for the first `n` (from 1) the store has no checkpoint under. */
async function nextForkId(store: CheckpointStore, sessionId: string): Promise<string> {
  for (let n = 1; ; n++) {
    const id = `${sessionId}.fork-${n}`;
    if (!(await store.load(id))) return id;
  }
}

/** `messages` with the result of `toolCallId` replaced in place, or appended when it has none yet. */
export function withToolResult(messages: Message[], { toolCallId, result }: NonNullable<ForkPatch['toolResult']>): Message[] {
  const call = messages.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : [])).find((c) => c.id === toolCallId);
  if (!call) {
    throw new ConfigurationError(`fork: the kept transcript has no tool call '${toolCallId}'.`, 'patch.toolResult');
  }
  const name = call.function.name;
  const message: Message = { role: 'tool', content: toolResultContent(result), name, toolCallId, toolName: name };
  const index = messages.findIndex((m) => m.role === 'tool' && m.toolCallId === toolCallId);
  // A pending call's result goes at the end; loading the checkpoint moves it behind its turn.
  return index < 0 ? [...messages, message] : messages.map((m, i) => (i === index ? message : m));
}

function patchMessages(messages: Message[], patch: ForkPatch): Message[] {
  let patched = patch.messages ? patch.messages(messages) : messages;
  if (patch.toolResult) patched = withToolResult(patched, patch.toolResult);
  if (patch.appendInput !== undefined) patched = [...patched, { role: 'user', content: patch.appendInput }];
  return patched;
}

/** See `AgentExecutor.fork()`. */
export async function forkSession(options: ForkOptions): Promise<ForkResult> {
  const { sessionId, fromStep, checkpointStore, patch = {} } = options;
  if (!checkpointStore.history) {
    throw new ConfigurationError(
      `fork: the checkpoint store keeps no history, so session '${sessionId}' cannot be forked. ` +
        'Use memoryStore(), SqliteStore or LocalStorageCheckpointStore.',
      'checkpointStore'
    );
  }
  const history = await checkpointStore.history(sessionId);
  const entry = history.find((e) => e.step === fromStep);
  if (!entry) {
    const kept = [...new Set(history.map((e) => e.step))].reverse().join(', ') || 'none';
    throw new SDKError(`fork: session '${sessionId}' has no checkpoint at step ${fromStep} (steps kept: ${kept}).`, 'LOUSHO_CHECKPOINT_NOT_FOUND');
  }
  const newSessionId = options.newSessionId ?? (await nextForkId(checkpointStore, sessionId));
  if (newSessionId === sessionId || (await checkpointStore.load(newSessionId))) {
    throw new ConfigurationError(`fork: '${newSessionId}' already has a checkpoint; pick a new session id.`, 'newSessionId');
  }

  const source = structuredClone(entry.checkpoint);
  delete source.approvalId;
  const checkpoint: Checkpoint = {
    ...source,
    sessionId: newSessionId,
    messages: patchMessages(source.messages, patch),
    ...('businessState' in patch && { businessState: patch.businessState }),
    status: 'in-progress',
  };
  await checkpointStore.save(newSessionId, checkpoint);
  return { sessionId: newSessionId, step: entry.step, checkpoint };
}
