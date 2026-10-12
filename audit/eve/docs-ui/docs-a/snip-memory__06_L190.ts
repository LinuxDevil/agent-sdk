// memory.md:190
import { createAgent, defineMemory, inMemoryMemory, memoryKey } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const store = inMemoryMemory();
const notes = defineMemory({ name: 'notes', scope: 'global', provider: store });
await store.add(memoryKey(notes)!, { text: 'The user likes tea.' });

const model = mockModel([{ toolCalls: [{ name: 'remember_notes', args: { text: 'Lives in Oslo.' } }] }, 'Noted.']);
await createAgent({ provider: model, memory: [notes] }).send('I moved to Oslo.');

console.log(model.calls[0].messages[0].content); // ends with <memory name="notes">\n- The user likes tea.\n</memory>
console.log((await store.list(memoryKey(notes)!)).map((item) => item.text)); // ['Lives in Oslo.', 'The user likes tea.']
export {};
