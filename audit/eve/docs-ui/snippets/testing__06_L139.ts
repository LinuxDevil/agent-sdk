// testing.md:139
import { mockModel } from '@lousho/build-ai-agent/testing';

const looping = mockModel([{ toolCalls: [{ name: 'again' }] }], { onExhausted: 'repeat-last' });
export {};
