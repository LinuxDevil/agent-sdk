/**
 * `@loushy/build-ai-agent/testing` - test doubles for agents.
 *
 * Re-exports the in-memory repository mocks plus the scripted `mockModel`.
 */

export * from '../data/mocks';
export { mockModel } from './mockModel';
export type {
  DeepReadonly,
  MockModel,
  MockModelOptions,
  MockRequest,
  MockStaticTurn,
  MockToolCall,
  MockTurn,
  MockTurnObject,
} from './mockModel';
