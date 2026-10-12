import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const ex: any = await import('@lousho/build-ai-agent/executor');
const tools: any = await import('@lousho/build-ai-agent/tools');
console.log('tools has globalToolRegistry:', 'globalToolRegistry' in tools, 'same as executor:', tools.globalToolRegistry === ex.globalToolRegistry);
const cjsRoot = req('@lousho/build-ai-agent'); const cjsEx = req('@lousho/build-ai-agent/executor'); const cjsHooks = req('@lousho/build-ai-agent/hooks');
console.log('CJS HookRegistry same:', cjsRoot.HookRegistry === cjsHooks.HookRegistry, 'CJS SDKError vs ESM SDKError instanceof brand:', new cjsRoot.SDKError('x', 'LOUSHO_X') instanceof (await import('@lousho/build-ai-agent')).SDKError);
