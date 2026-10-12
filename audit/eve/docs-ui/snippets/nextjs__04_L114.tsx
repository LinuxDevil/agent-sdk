// nextjs.md:114
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

// ai 6/7 signature; on ai 4 (also a supported peer) use useChat({ api: '/api/agent/ui' })
const { messages, sendMessage } = useChat({ transport: new DefaultChatTransport({ api: '/api/agent/ui' }) });
export {};
