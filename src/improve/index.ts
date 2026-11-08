export { improveAgent } from './improve';
export { createShadowHook, renderTranscript } from './evidence';
export { formatImproveResult } from './format';
export { admitProtectedCases, casesFromFailures, probeCapturedCases, protectedCasesFromPasses } from './cases';
export type { CapturedCase, CaseCheck } from './cases';
export type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from '../storage/sqlite/driver';
export type { CaseCount, CaseVerdict, GateVerdict, Harness, ImproveChange, ImproveOptions, ImproveOutcome, ImproveResult, ImproveStage, ProbeRun, ProbeSummary } from './types';
