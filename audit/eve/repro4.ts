import { defineMemory, inMemoryMemory } from '../../src/memory/index';
// provider without remove passes validation
try {
  const p = { list: async () => [], add: async (k: string, i: { text: string }) => ({ id: 'x', text: i.text, createdAt: '' }) };
  defineMemory({ name: 'n', scope: 'global', provider: p as never });
  console.log('provider missing remove() accepted');
} catch (e) { console.log('rejected:', (e as Error).message); }
// typo'd recall.query silently accepted
const s = defineMemory({ name: 'n', scope: 'global', provider: inMemoryMemory(), recall: { query: 'lastinput' as never } });
console.log('query accepted:', s.recall.query, '(silently behaves as none)');
// tool_search keyword miss
import { rankToolsByKeywords } from '../../src/tools/toolSearchRank';
const tools = [{ name: 'fetch_equity_quote', description: 'Get the current market price of a stock ticker' }];
console.log('search "stock price" ->', rankToolsByKeywords('stock price', tools));
console.log('search "share value" ->', rankToolsByKeywords('share value', tools));
