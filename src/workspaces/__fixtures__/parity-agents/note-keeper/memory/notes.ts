import { inMemoryMemory } from '../../../../../memory';

export default { scope: 'global' as const, provider: inMemoryMemory(), description: 'Notes to keep' };
