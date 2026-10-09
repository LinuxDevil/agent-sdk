/**
 * Evals Module
 * Lightweight harness for scoring agent runs (LOU-G)
 */

export * from './defineEval';
export * from './scorers';
export * from './llmJudge';

export { remoteTarget } from './remoteTarget';
export type { EvalTarget, RemoteTargetOptions, RemoteExecutionResult } from './remoteTarget';
export * from './checks';
export * from './evalResult';
export { compareTrajectories } from './drift';
export type { TrajectoryComparison, TrajectoryStep, DriftEntry } from './drift';
export type { EvalJudgeConfig, EvalTestContext, CalledToolOptions, ToolScopeOptions, AgentSource } from './trajectory';
