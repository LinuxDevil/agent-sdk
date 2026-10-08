/** loadAgentDir() on a kit installed in a dir with no node_modules (e.g. a fresh project before `npm install`). */
import { loadAgentDir } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
try { await loadAgentDir(process.argv[2], { provider: mockModel(['x']) }); console.log('loaded'); }
catch (e) { console.log(`${(e as Error).name}: ${(e as { code?: string }).code ?? ''}\n${(e as Error).message.slice(0, 600)}`); }
