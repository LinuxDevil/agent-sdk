// W11b test preload: registers a scripted `scripted` provider inside the
// bridge child process (passed as `node --import <file URL>` before
// `bin/lousho.js bridge`), where providers registered in the Studio test
// process cannot reach. The turn script comes from SCRIPTED_TURNS (a JSON
// array of mockModel turns - see src/testing/mockModel.ts).
//
// The mockModel is created ONCE here, not per factory call: the bridge
// rebuilds the runnable agent when an approval pause continues, and a
// fresh script per build would replay turn 1 (pausing again) instead of
// advancing to the continuation turn - the same reason the SDK's own
// bridge tests register one shared `model`.
//
// Imports `@linuxdevil/lousho`, not `@lousho/build-ai-agent`: that is the name the
// package ships under today; the scoped rename lands with W13a/W13b.
//
// W15b: `LOUSHO_BRIDGE_SDK_DIR` points the preload at the SDK under test
// (the compat suite's min-version install). The bare specifier would
// resolve this file's own checkout's SDK - a different module instance
// than the bridge child's - so the env var switches to direct dist URLs,
// which land on the same resolved files the child's `bin/lousho.js` uses.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sdkDir = process.env.LOUSHO_BRIDGE_SDK_DIR;
const root = sdkDir === undefined ? '@linuxdevil/lousho' : pathToFileURL(join(sdkDir, 'dist', 'index.mjs')).href;
const testing =
  sdkDir === undefined ? '@linuxdevil/lousho/testing' : pathToFileURL(join(sdkDir, 'dist', 'testing', 'index.mjs')).href;

const { LLMProviderRegistry } = await import(root);
const { mockModel } = await import(testing);

const model = mockModel(JSON.parse(process.env.SCRIPTED_TURNS ?? '["ok"]'), { onExhausted: 'repeat-last' });
LLMProviderRegistry.register('scripted', () => model);
