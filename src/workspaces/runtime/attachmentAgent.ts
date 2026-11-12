import { createAgent, type CreateAgentConfig, type SimpleAgent } from '../../createAgent';
import type { RunLimits } from '../../execution/budget';
import type { OutputSpec } from '../../execution/structuredOutput';
import type { ToolDescriptor } from '../../types';
import { SDKError } from '../../utils/sdkError';
import type { PageExecutionLimits } from '../contracts/page';
import { agentRunOptions, assembleInstructions } from './assemble';
import type { PageAttachment, PageEngineSetup } from './engines/types';

/** Options of {@link attachmentAgent}. */
interface AttachmentAgentOptions {
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

function tightened(own: RunLimits, page: PageExecutionLimits | undefined): RunLimits {
  const limits: RunLimits = { ...own };
  const steps = min(own.maxSteps, page?.maxTurns);
  const duration = min(own.maxDurationMs, page?.maxDurationMs);
  const cost = min(own.maxCostUsd, page?.maxCostUsd);
  if (steps !== undefined) limits.maxSteps = steps;
  if (duration !== undefined) limits.maxDurationMs = duration;
  if (cost !== undefined) limits.maxCostUsd = cost;
  return limits;
}

function modelSource(setup: PageEngineSetup, model: string | undefined): Pick<CreateAgentConfig, 'provider' | 'model'> {
  if (setup.host.provider) return { provider: setup.host.provider(model) };
  return model === undefined ? {} : { model };
}

/** Builds the agent for one attachment of a page: assembled instructions, only the policy's tools (each bound by the host to its secrets, network and sandbox), the policy's permissions, and the smallest limits. The only place the page runtime builds an agent. */
export function attachmentAgent(setup: PageEngineSetup, alias: string, options: AttachmentAgentOptions = {}): SimpleAgent {
  const attachment = attachmentOf(setup, alias);
  const { resolved, policy } = attachment;
  const run = agentRunOptions(resolved, setup.harness);
  const instructions = assembleInstructions({
    agent: resolved.agentOwned,
    agentDir: resolved.dir,
    shared: setup.shared,
    harness: setup.harness,
    attachment: resolved.pageOwned,
    page: { id: setup.page.id, name: setup.page.name },
    ...(options.engineFraming !== undefined && { engineFraming: options.engineFraming }),
  });
  return createAgent({
    name: resolved.agentOwned.name,
    instructions: instructions.text,
    ...modelSource(setup, run.model),
    tools: boundTools(setup, alias, attachment),
    permissions: policy.permissions,
    limits: tightened(run.limits, options.limits),
    ...(run.reasoning !== undefined && { reasoning: run.reasoning }),
    ...(run.modelSettings !== undefined && { modelSettings: run.modelSettings }),
    ...(options.output !== undefined && { output: options.output }),
  });
}
