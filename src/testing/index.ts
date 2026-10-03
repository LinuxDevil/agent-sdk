/**
 * `@lousho/build-ai-agent/testing` - test doubles for agents.
 *
 * Re-exports the in-memory repository mocks, the scripted `mockModel` and the
 * `recordReplay` VCR provider.
 */

export { mockModel } from './mockModel';
export type {
  DeepReadonly,
  MockModel,
  MockModelOptions,
  MockRequest,
  MockStaticTurn,
  MockToolCall,
  MockHostedToolCall,
  MockTurn,
  MockTurnObject,
} from './mockModel';
export { recordReplay, CassetteMismatchError } from './recordReplay';
export type {
  RecordReplayMode,
  RecordReplayOptions,
  RecordReplayProvider,
  RecordReplaySource,
} from './recordReplay';
// LOU-R13 / LOU-D46.2: the model-boundary interception seam. `lousho eval`
// installs its cassette wrapper here; tests may install their own provider
// wrapper at the same point (docs/evals.md#record-replay-and-drift).
export { setProviderInterceptor } from '../providers/interception';
export type { ProviderInterceptor } from '../providers/interception';
export { hashEmbedder } from './hashEmbedder';
export type { HashEmbedderOptions } from './hashEmbedder';
