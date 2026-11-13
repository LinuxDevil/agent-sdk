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
// Imports `@linuxdevil/lousho`, the name the package ships under.
import { LLMProviderRegistry } from '@linuxdevil/lousho';
import { mockModel } from '@linuxdevil/lousho/testing';

const model = mockModel(JSON.parse(process.env.SCRIPTED_TURNS ?? '["ok"]'), { onExhausted: 'repeat-last' });
LLMProviderRegistry.register('scripted', () => model);
