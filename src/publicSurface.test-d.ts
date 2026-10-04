/**
 * A1 (wave 4): the type half of the public-surface split. Each moved or
 * removed type name must be absent from `import('./index')` (the
 * `@ts-expect-error` pins that) and, for a move, present on its subpath.
 * Later tickets (A2a, A2b, A2c, A3, A5) append the names they remove or
 * move here and in publicSurface.test.ts.
 */
import { describe, it, expectTypeOf } from 'vitest';

describe('public surface (A1): moved types are off the root, on their subpath', () => {
  it('flow types moved to ./flows', () => {
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T1 = import('./index').AgentFlow;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T2 = import('./index').EditorStep;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T3 = import('./index').FlowExecutionEvent;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T4 = import('./index').FlowExecutionEventOf;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T5 = import('./index').FlowExecutionResult;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T6 = import('./index').FlowExecutionContext;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T7 = import('./index').FlowChunkEvent;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T8 = import('./index').FlowInputVariable;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T9 = import('./index').FlowInputType;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T10 = import('./index').FlowAgentDefinition;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T11 = import('./index').FlowToolSetting;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T12 = import('./index').FlowExecutionMode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T13 = import('./index').FlowOutputMode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T14 = import('./index').EditorShapeStep;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T15 = import('./index').RuntimeStep;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T16 = import('./index').StepNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T17 = import('./index').SequenceNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T18 = import('./index').ParallelNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T19 = import('./index').OneOfNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T20 = import('./index').ForEachNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T21 = import('./index').EvaluatorNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T22 = import('./index').BestOfAllNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T23 = import('./index').ToolNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T24 = import('./index').UIComponentNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T25 = import('./index').ConditionNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T26 = import('./index').LoopNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T27 = import('./index').OneOfOption;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T28 = import('./index').OneOfOptionsNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T29 = import('./index').ForEachItemsNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T30 = import('./index').ExpressionEvaluatorNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T31 = import('./index').LLMCallNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T32 = import('./index').ToolCallNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T33 = import('./index').SetVariableNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T34 = import('./index').ReturnNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T35 = import('./index').EndNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T36 = import('./index').ThrowNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T37 = import('./index').FlowDefinitionNode;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T38 = import('./index').FlowExecutionEventType;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/flows' (A1)
    type _T39 = import('./index').FlowExecutionEventDataMap;

    // Present on './flows':
    expectTypeOf<import('./flows').AgentFlow>().not.toBeNever();
    expectTypeOf<import('./flows').EditorStep>().not.toBeNever();
    expectTypeOf<import('./flows').FlowExecutionEvent>().not.toBeNever();
    expectTypeOf<import('./flows').FlowExecutionEventOf<'flow-start'>>().not.toBeNever();
    expectTypeOf<import('./flows').FlowExecutionResult>().not.toBeNever();
    expectTypeOf<import('./flows').FlowExecutionContext>().not.toBeNever();
    expectTypeOf<import('./flows').FlowChunkEvent>().not.toBeNever();
    expectTypeOf<import('./flows').FlowInputVariable>().not.toBeNever();
    expectTypeOf<import('./flows').FlowInputType>().not.toBeNever();
    expectTypeOf<import('./flows').FlowAgentDefinition>().not.toBeNever();
    expectTypeOf<import('./flows').FlowToolSetting>().not.toBeNever();
    expectTypeOf<import('./flows').FlowExecutionMode>().not.toBeNever();
    expectTypeOf<import('./flows').FlowOutputMode>().not.toBeNever();
    expectTypeOf<import('./flows').EditorShapeStep>().not.toBeNever();
    expectTypeOf<import('./flows').RuntimeStep>().not.toBeNever();
    expectTypeOf<import('./flows').StepNode>().not.toBeNever();
    expectTypeOf<import('./flows').SequenceNode>().not.toBeNever();
    expectTypeOf<import('./flows').ParallelNode>().not.toBeNever();
    expectTypeOf<import('./flows').OneOfNode>().not.toBeNever();
    expectTypeOf<import('./flows').ForEachNode>().not.toBeNever();
    expectTypeOf<import('./flows').EvaluatorNode>().not.toBeNever();
    expectTypeOf<import('./flows').BestOfAllNode>().not.toBeNever();
    expectTypeOf<import('./flows').ToolNode>().not.toBeNever();
    expectTypeOf<import('./flows').UIComponentNode>().not.toBeNever();
    expectTypeOf<import('./flows').ConditionNode>().not.toBeNever();
    expectTypeOf<import('./flows').LoopNode>().not.toBeNever();
    expectTypeOf<import('./flows').OneOfOption>().not.toBeNever();
    expectTypeOf<import('./flows').OneOfOptionsNode>().not.toBeNever();
    expectTypeOf<import('./flows').ForEachItemsNode>().not.toBeNever();
    expectTypeOf<import('./flows').ExpressionEvaluatorNode>().not.toBeNever();
    expectTypeOf<import('./flows').LLMCallNode>().not.toBeNever();
    expectTypeOf<import('./flows').ToolCallNode>().not.toBeNever();
    expectTypeOf<import('./flows').SetVariableNode>().not.toBeNever();
    expectTypeOf<import('./flows').ReturnNode>().not.toBeNever();
    expectTypeOf<import('./flows').EndNode>().not.toBeNever();
    expectTypeOf<import('./flows').ThrowNode>().not.toBeNever();
    expectTypeOf<import('./flows').FlowDefinitionNode>().not.toBeNever();
    expectTypeOf<import('./flows').FlowExecutionEventType>().not.toBeNever();
    expectTypeOf<import('./flows').FlowExecutionEventDataMap>().not.toBeNever();
  });

  it('integration types moved to ./integrations', () => {
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T1 = import('./index').EmailToolOptions;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T2 = import('./index').JiraConfig;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T3 = import('./index').JiraTicket;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T4 = import('./index').JiraComment;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T5 = import('./index').JiraTransition;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T6 = import('./index').GitHubConfig;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T7 = import('./index').GitHubFile;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T8 = import('./index').GitHubSearchResult;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T9 = import('./index').GitHubPullRequest;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T10 = import('./index').GitHubBranch;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T11 = import('./index').SlackBlock;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T12 = import('./index').SlackAlertPayload;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/integrations' (A1)
    type _T13 = import('./index').SlackToolOptions;

    expectTypeOf<import('./integrations').EmailToolOptions>().not.toBeNever();
    expectTypeOf<import('./integrations').JiraConfig>().not.toBeNever();
    expectTypeOf<import('./integrations').JiraTicket>().not.toBeNever();
    expectTypeOf<import('./integrations').JiraComment>().not.toBeNever();
    expectTypeOf<import('./integrations').JiraTransition>().not.toBeNever();
    expectTypeOf<import('./integrations').GitHubConfig>().not.toBeNever();
    expectTypeOf<import('./integrations').GitHubFile>().not.toBeNever();
    expectTypeOf<import('./integrations').GitHubSearchResult>().not.toBeNever();
    expectTypeOf<import('./integrations').GitHubPullRequest>().not.toBeNever();
    expectTypeOf<import('./integrations').GitHubBranch>().not.toBeNever();
    expectTypeOf<import('./integrations').SlackBlock>().not.toBeNever();
    expectTypeOf<import('./integrations').SlackAlertPayload>().not.toBeNever();
    expectTypeOf<import('./integrations').SlackToolOptions>().not.toBeNever();
  });

  it('utility types moved to ./utils', () => {
    // @ts-expect-error - moved to '@lousho/build-ai-agent/utils' (A1)
    type _T1 = import('./index').EncryptionConfig;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/utils' (A1)
    type _T2 = import('./index').DTOEncryptionSettings;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/utils' (A1)
    type _T3 = import('./index').AuthorizationContext;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/utils' (A1)
    type _T4 = import('./index').FileSystemAdapter;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/utils' (A1)
    type _T5 = import('./index').PathAdapter;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/utils' (A1)
    type _T6 = import('./index').IStorageService;
    // @ts-expect-error - moved to '@lousho/build-ai-agent/utils' (A1)
    type _T7 = import('./index').StorageConfig;

    expectTypeOf<import('./utils').EncryptionConfig>().not.toBeNever();
    expectTypeOf<import('./utils').DTOEncryptionSettings>().not.toBeNever();
    expectTypeOf<import('./utils').AuthorizationContext>().not.toBeNever();
    expectTypeOf<import('./utils').FileSystemAdapter>().not.toBeNever();
    expectTypeOf<import('./utils').PathAdapter>().not.toBeNever();
    expectTypeOf<import('./utils').IStorageService>().not.toBeNever();
    expectTypeOf<import('./utils').StorageConfig>().not.toBeNever();
  });
});

describe('public surface (A2a): removed names are off the root', () => {
  it('agent-type system and donor-era types are gone', () => {
    // @ts-expect-error - removed (A2a)
    type _T1 = import('./index').AgentType;
    // @ts-expect-error - removed (A2a)
    type _T2 = import('./index').AgentTypeDescriptor;
    // @ts-expect-error - removed (A2a)
    type _T3 = import('./index').AgentExecutionOptions;
    // @ts-expect-error - removed (A2a)
    type _T4 = import('./index').AgentExecutionResult;
    // @ts-expect-error - removed (A2a)
    type _T5 = import('./index').AgentDefinition;
    // @ts-expect-error - removed (A2a)
    type _T6 = import('./index').ToolSetting;
    // @ts-expect-error - removed (A2a)
    type _T7 = import('./index').agentTypesRegistry;
    // @ts-expect-error - removed (A2a)
    type _T8 = import('./index').getAgentTypeDescriptor;
    // @ts-expect-error - removed (A2a)
    type _T9 = import('./index').getAllAgentTypeDescriptors;
    // @ts-expect-error - removed (A2a)
    type _T10 = import('./index').isValidAgentType;
    // @ts-expect-error - removed (A2a)
    type _T11 = import('./index').validateAgentConfig;
    // @ts-expect-error - removed (A2a)
    type _T12 = import('./index').validateAgentTools;
    // @ts-expect-error - removed (A2a)
    type _T13 = import('./index').IRepository;
    // @ts-expect-error - removed (A2a)
    type _T14 = import('./index').IAgentRepository;
    // @ts-expect-error - removed (A2a)
    type _T15 = import('./index').SessionData;
    // @ts-expect-error - removed (A2a)
    type _T16 = import('./index').ISessionRepository;
    // @ts-expect-error - removed (A2a)
    type _T17 = import('./index').ResultData;
    // @ts-expect-error - removed (A2a)
    type _T18 = import('./index').IResultRepository;
    // @ts-expect-error - removed (A2a)
    type _T19 = import('./index').SDKRepositories;
    // @ts-expect-error - removed (A2a)
    type _T20 = import('./index').DataLoadingStatus;
    // @ts-expect-error - removed (A2a)
    type _T21 = import('./index').PaginationParams;
    // @ts-expect-error - removed (A2a)
    type _T22 = import('./index').PaginatedResponse;
    // @ts-expect-error - removed (A2a)
    type _T23 = import('./index').DeepPartial;
    // @ts-expect-error - removed (A2a)
    type _T24 = import('./index').Timestamped;
    // @ts-expect-error - removed (A2a)
    type _T25 = import('./index').IdEntity;
  });
});

describe('public surface (A2b): removed names are off the root', () => {
  it('legacy execution events are gone', () => {
    // @ts-expect-error - removed (A2b)
    type _T1 = import('./index').ExecutionEvent;
    // @ts-expect-error - removed (A2b)
    type _T2 = import('./index').ExecutionEventType;
  });
});
