// testing.md:230
import { mockModel, recordReplay } from '@lousho/build-ai-agent/testing';

const provider = recordReplay(mockModel(['ok']), {
  cassette: './__cassettes__/users.json',
  normalize: (request) => ({
    ...request,
    messages: request.messages.map((m) =>
      typeof m.content === 'string' ? { ...m, content: m.content.replace(/user-\d+/g, 'user-N') } : m
    ),
  }),
});
export {};
