import { describe, expect, it } from 'vitest';
import { createAgent } from '../../createAgent';
import type { Span, TraceExporter } from '../../execution/tracing';
import { mockModel } from '../../testing';
import { STEP_KINDS, WORK_TYPE_STEP_KINDS, type StepKind } from '../contracts/execution';
import type { WorkType } from '../contracts/page';
import { labelAttributes, labelsFor } from './labels';

function recording(): TraceExporter & { ended: Span[] } {
  const ended: Span[] = [];
  return { ended, onSpanStart: () => {}, onSpanEnd: (span) => ended.push({ ...span }) };
}

async function rootAttributes(spanAttributes: Record<string, string | number>) {
  const exporter = recording();
  await createAgent({ name: 'a', provider: mockModel(['ok']), exporter, spanAttributes }).send('go');
  return exporter.ended.find((span) => span.attributes['gen_ai.operation.name'] === 'invoke_agent')!.attributes;
}

describe('labelsFor', () => {
  it('two pages sharing an agent emit different lousho.page and harness.hash', async () => {
    const run = { attachment: 'script', stepKind: 'single' as const, stepIndex: 0, executionType: 'single' as const };
    const instagram = labelsFor({ ...run, page: 'instagram', harnessHash: 'aaa' });
    const facebook = labelsFor({ ...run, page: 'facebook', harnessHash: 'bbb' });

    const first = await rootAttributes(labelAttributes(instagram, { workspace: 'marketing' }));
    const second = await rootAttributes(labelAttributes(facebook, { workspace: 'marketing' }));

    expect(first['lousho.page']).toBe('instagram');
    expect(second['lousho.page']).toBe('facebook');
    expect(first['lousho.harness.hash']).toBe('aaa');
    expect(second['lousho.harness.hash']).toBe('bbb');
    expect(first['lousho.workspace']).toBe(second['lousho.workspace']);
    expect(first['lousho.attachment']).toBe(second['lousho.attachment']);
  });

  it('every step kind sets lousho.step.kind and lousho.step.index', async () => {
    const types = Object.keys(WORK_TYPE_STEP_KINDS) as WorkType[];
    const seen = new Set<StepKind>();
    for (const executionType of types) {
      for (const [stepIndex, stepKind] of WORK_TYPE_STEP_KINDS[executionType].entries()) {
        const labels = labelsFor({ page: 'p', attachment: 'a', harnessHash: 'h', executionType, stepKind, stepIndex });
        const attributes = await rootAttributes(labelAttributes(labels));
        expect(attributes['lousho.step.kind']).toBe(stepKind);
        expect(attributes['lousho.step.index']).toBe(stepIndex);
        expect(attributes['lousho.execution_type']).toBe(executionType);
        seen.add(stepKind);
      }
    }
    expect([...seen].sort()).toEqual([...STEP_KINDS].sort());
  });

  it('refuses a step kind the execution type does not emit and a bad index', () => {
    const base = { page: 'p', attachment: 'a', harnessHash: 'h' };
    expect(() => labelsFor({ ...base, executionType: 'single', stepKind: 'delegate', stepIndex: 0 })).toThrow(/does not emit delegate/);
    expect(() => labelsFor({ ...base, executionType: 'single', stepKind: 'single', stepIndex: -1 })).toThrow(/stepIndex/);
  });

  it('refuses a parentStepIndex that is not below stepIndex', () => {
    const base = { page: 'p', attachment: 'a', harnessHash: 'h', executionType: 'multi-agent' as const, stepKind: 'delegate' as const };
    expect(() => labelsFor({ ...base, stepIndex: 1, parentStepIndex: 1 })).toThrow(/parentStepIndex/);
    expect(() => labelsFor({ ...base, stepIndex: 1, parentStepIndex: -1 })).toThrow(/parentStepIndex/);
  });

  it('spanAttributes cannot overwrite SDK-set attributes', async () => {
    const attributes = await rootAttributes({ 'gen_ai.operation.name': 'evil', 'gen_ai.agent.name': 'evil', 'lousho.harness.revision': 'evil' });
    expect(attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(attributes['gen_ai.agent.name']).toBe('a');
    expect(attributes['lousho.harness.revision']).not.toBe('evil');
  });

  it('keeps parentStepIndex only when given', () => {
    const base = { page: 'p', attachment: 'a', harnessHash: 'h', executionType: 'multi-agent' as const };
    expect(labelsFor({ ...base, stepKind: 'delegate', stepIndex: 1, parentStepIndex: 0 }).parentStepIndex).toBe(0);
    expect('parentStepIndex' in labelsFor({ ...base, stepKind: 'single', stepIndex: 0 })).toBe(false);
  });

  it('records the global ref version and sha256 and the reserved revision only when given', () => {
    const labels = labelsFor({ page: 'p', attachment: 'a', harnessHash: 'h', executionType: 'single', stepKind: 'single', stepIndex: 0 });
    expect(labelAttributes(labels)).not.toHaveProperty(['lousho.agent.ref.version']);
    const withRef = labelAttributes(labels, { agentRef: { version: '1.2.0', sha256: 'abc' }, harnessPartHash: 'part', workspaceRevision: 'r1' });
    expect(withRef).toMatchObject({ 'lousho.agent.ref.version': '1.2.0', 'lousho.agent.ref.sha256': 'abc', 'lousho.harness.part_hash': 'part', 'lousho.workspace.revision': 'r1' });
  });
});
