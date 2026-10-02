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
