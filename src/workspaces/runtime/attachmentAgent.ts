import { createAgent, type CreateAgentConfig, type SimpleAgent } from '../../createAgent';
import type { RunLimits } from '../../execution/budget';
import type { OutputSpec } from '../../execution/structuredOutput';
import type { ToolDescriptor } from '../../types';
import { SDKError } from '../../utils/sdkError';
import type { PageStepLabels, StepKind } from '../contracts/execution';
import type { PageExecutionLimits } from '../contracts/page';
import { agentRunOptions, assembleInstructions, type AgentRunOptions, type AssembledInstructions } from './assemble';
import type { PageAttachment, PageEngineSetup } from './engines/types';
import { labelAttributes, labelsFor } from './labels';
import type { ResolvedAttachment } from './resolveAgents';

/** Options of {@link attachmentAgent}. */
interface AttachmentAgentOptions {
  /** The step the agent runs, labelled on its spans and on the engine's step events. */
  step: {
    /** What kind of step this is. */
    stepKind: StepKind;
    /** The step's position in the run, from 0. */
    stepIndex: number;
    /** The lead step a delegate runs under. */
    parentStepIndex?: number;
  };
  /** The engine's own prompt text, section 5 of the assembled instructions. */
  engineFraming?: string;
  /** Structured output for the agent's final reply. */
  output?: OutputSpec;
  /** The page's execution limits; each one only tightens the attachment's. */
  limits?: PageExecutionLimits;
}

function attachmentOf(setup: PageEngineSetup, alias: string): PageAttachment {
  const attachment = Object.hasOwn(setup.attachments, alias) ? setup.attachments[alias] : undefined;
  if (!attachment) throw new SDKError(`page '${setup.page.id}' has no attachment '${alias}' in its agents file`, 'LOUSHO_WORKSPACE_AGENT_UNRESOLVED');
  return attachment;
}

function boundTools(setup: PageEngineSetup, alias: string, attachment: PageAttachment): Record<string, ToolDescriptor> {
  const { policy } = attachment;
  return Object.fromEntries(
    Object.entries(policy.tools).map(([name, descriptor]) => [
      name,
      setup.host.bindTool(descriptor, {
        name,
        page: setup.page.id,
        attachment: alias,
        secrets: policy.secrets[name] ?? [],
        network: { allowHosts: [...policy.network.allowHosts] },
        sandbox: { required: policy.sandbox.required },
      }),
    ])
  );
}

function min(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : Math.min(a, b);
}

const LIMIT_PAIRS = [
  ['maxSteps', 'maxTurns'],
  ['maxDurationMs', 'maxDurationMs'],
  ['maxCostUsd', 'maxCostUsd'],
] as const;

function tightened(own: RunLimits, page: PageExecutionLimits | undefined): RunLimits {
  const limits: RunLimits = { ...own };
  for (const [key, pageKey] of LIMIT_PAIRS) {
    const value = min(own[key], page?.[pageKey]);
    if (value !== undefined) limits[key] = value;
  }
  return limits;
}

function modelSource(setup: PageEngineSetup, model: string | undefined): Pick<CreateAgentConfig, 'provider' | 'model'> {
  if (setup.host.provider) return { provider: setup.host.provider(model) };
  return model === undefined ? {} : { model };
}

function instructionsFor(setup: PageEngineSetup, resolved: ResolvedAttachment, engineFraming: string | undefined): AssembledInstructions {
  return assembleInstructions({
    agent: resolved.agentOwned,
    agentDir: resolved.dir,
    shared: setup.shared,
    harness: setup.harness,
    attachment: resolved.pageOwned,
    page: { id: setup.page.id, name: setup.page.name },
    ...(engineFraming !== undefined && { engineFraming }),
  });
}

function spanAttributesFor(setup: PageEngineSetup, labels: PageStepLabels, resolved: ResolvedAttachment, harnessPartHash: string): Record<string, string | number> {
  const agentRef = resolved.version === undefined ? {} : { agentRef: { version: resolved.version, sha256: resolved.sha256 } };
  return labelAttributes(labels, { workspace: setup.workspace.manifest.id, harnessPartHash, ...agentRef });
}

function optionalConfig(setup: PageEngineSetup, run: AgentRunOptions, options: AttachmentAgentOptions): Pick<CreateAgentConfig, 'reasoning' | 'modelSettings' | 'output' | 'exporter'> {
  return Object.fromEntries(
    Object.entries({ reasoning: run.reasoning, modelSettings: run.modelSettings, output: options.output, exporter: setup.host.exporter }).filter(([, value]) => value !== undefined)
  );
}

/** An attachment's agent and the step labels on its spans. */
export interface AttachmentAgent {
  /** The agent. */
  agent: SimpleAgent;
  /** The labels its `invoke_agent` span carries; engines put the same labels on step events. */
  labels: PageStepLabels;
}

/** Builds the agent for one attachment of a page: assembled instructions, only the policy's tools (each bound by the host to its secrets, network and sandbox), the policy's permissions, the smallest limits, and the step's labels as span attributes. The only place the page runtime builds an agent. */
export function attachmentAgent(setup: PageEngineSetup, alias: string, options: AttachmentAgentOptions): AttachmentAgent {
  const attachment = attachmentOf(setup, alias);
  const { resolved, policy } = attachment;
  const run = agentRunOptions(resolved, setup.harness);
  const instructions = instructionsFor(setup, resolved, options.engineFraming);
  const labels = labelsFor({ page: setup.page.id, harnessHash: setup.harness.hash, executionType: setup.page.execution.type, attachment: alias, ...options.step });
  const agent = createAgent({
    name: resolved.agentOwned.name,
    instructions: instructions.text,
    ...modelSource(setup, run.model),
    tools: boundTools(setup, alias, attachment),
    permissions: policy.permissions,
    limits: tightened(run.limits, options.limits),
    ...optionalConfig(setup, run, options),
    spanAttributes: spanAttributesFor(setup, labels, resolved, instructions.harnessPartHash),
  });
  return { agent, labels };
}
