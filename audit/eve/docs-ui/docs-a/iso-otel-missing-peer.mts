// Run in a clean project OUTSIDE E:\agent-sdk (npm i <tgz> ai@7 zod@4 tsx): audit/ resolves peers from the repo-root node_modules.
import { MissingPeerDependencyError } from '@lousho/build-ai-agent';
try { const m = await import('@lousho/build-ai-agent/otel'); console.log('import ok'); const ex = m.createOtelTraceExporter(); console.log('created', typeof ex); }
catch (e: any) { console.log('otel import/create threw:', e instanceof MissingPeerDependencyError, e.code, String(e.message).split('\n')[0].slice(0, 200)); }
