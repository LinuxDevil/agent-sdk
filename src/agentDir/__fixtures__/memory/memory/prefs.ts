import { defineMemory, inMemoryMemory } from '../../../../memory';

export default defineMemory({ name: 'user-prefs', scope: 'session', provider: inMemoryMemory(), recall: { maxItems: 3 } });
