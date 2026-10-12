// nextjs.md:98
'use client';
import { useLoushoAgent } from '@lousho/build-ai-agent/react';

export function Chat() {
  const agent = useLoushoAgent({ url: '/api/agent', headers: { Authorization: `Bearer ${token}` } }, { approvalsUrl: '/api/agent/approvals' });
  // agent.messages, agent.send(text), agent.approve() ...
}
export {};
