// testing.md:280
import { mockModel, recordReplay } from '@lousho/build-ai-agent/testing';

const provider = recordReplay(mockModel(['ok']), {
  cassette: './__cassettes__/support.json',
  redact: (text) => text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>'),
});
export {};
