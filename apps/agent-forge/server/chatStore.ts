/**
 * P3: file-backed persistence for chat transcripts, one JSON file per
 * (agentId, chat session) under
 * `<baseDir>/.loushy/agents/<agentId>/chats/<sessionId>.json` - sibling to
 * FileCheckpointStore.ts/FileApprovalStore.ts/fsAgentStore.ts, following the
 * same `.loushy/agents/<id>/...` layout rather than a fourth, unrelated
 * persistence mechanism.
 *
 * A "session" here is a chat conversation, not an individual run: Stop-then-
 * Run resumes the same session (mirroring how `sessionId = agentId` resumes
 * the same AgentExecutor conversation via checkpoints, see runRegistry.ts),
 * and a session only ends when the user explicitly starts a new one
 * (RunManager.newChat()) - that's what "browse past conversations" (P3)
 * browses.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatMessage, ChatSessionMeta, ChatSessionRecord } from './types';

export class FileChatStore {
  constructor(private readonly baseDir: string) {}

  private dir(agentId: string): string {
    return path.join(this.baseDir, '.loushy', 'agents', agentId, 'chats');
  }

  private filePath(agentId: string, sessionId: string): string {
    return path.join(this.dir(agentId), `${sessionId}.json`);
  }

  save(agentId: string, record: ChatSessionRecord): void {
    fs.mkdirSync(this.dir(agentId), { recursive: true });
    fs.writeFileSync(this.filePath(agentId, record.sessionId), JSON.stringify(record), 'utf8');
  }

  load(agentId: string, sessionId: string): ChatSessionRecord | null {
    const file = this.filePath(agentId, sessionId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ChatSessionRecord;
  }

  /** Metadata for every persisted session for `agentId`, newest first. Malformed files are skipped rather than failing the whole listing. */
  list(agentId: string): ChatSessionMeta[] {
    const dir = this.dir(agentId);
    if (!fs.existsSync(dir)) return [];
    const metas: ChatSessionMeta[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as ChatSessionRecord;
        metas.push({
          sessionId: record.sessionId,
          startedAt: record.startedAt,
          updatedAt: record.updatedAt,
          messageCount: record.messages.length,
          preview: record.preview,
        });
      } catch {
        // Skip a corrupt/partial file rather than failing the whole listing.
      }
    }
    return metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
}

/** Truncated preview text of the first user message, for the session list (P3). */
export function previewFor(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const text = firstUser?.content ?? '';
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}
