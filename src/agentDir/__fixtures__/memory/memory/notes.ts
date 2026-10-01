import { inMemoryMemory } from '../../../../memory';

// A plain slot without a name: the file name ('notes') becomes the slot name.
export default { scope: 'global' as const, provider: inMemoryMemory(), description: 'Facts to keep' };
