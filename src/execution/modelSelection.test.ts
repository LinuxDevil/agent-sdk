/**
 * LOU-U1: the executor must send the right `model` to provider.generate().
 * Precedence: agent.settings.model > provider's configured model > nothing
 * (the provider then applies its own built-in default). Never a hard-coded
 * 'gpt-4'.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentExecutor } from './AgentExecutor';
import { createMockProvider } from '../providers/mock';
import { AgentBuilder } from '../core';
import { AgentType } from '../types';

function agentWith(settings?: { model: string }) {
  const builder = AgentBuilder.create()
    .setType(AgentType.SmartAssistant)
    .setName('Model Agent')
    .setPrompt('You are helpful');
  return (settings ? builder.setSettings(settings) : builder).build();
}

async function modelSentTo(
  providerModel: string | undefined,
  settings?: { model: string }
): Promise<string | undefined> {
  const provider = createMockProvider({ name: 'mock', defaultModel: providerModel });
  const generate = vi.spyOn(provider, 'generate');

  await AgentExecutor.execute({ agent: agentWith(settings), input: 'hi', provider });

  return generate.mock.calls[0][0].model;
}

describe('AgentExecutor model selection', () => {
  it('uses agent.settings.model over the provider model', async () => {
    expect(await modelSentTo('provider-model', { model: 'agent-model' })).toBe('agent-model');
  });

  it("uses the provider's configured model when settings.model is unset", async () => {
    expect(await modelSentTo('provider-model')).toBe('provider-model');
  });

  it('sends no model (never gpt-4) when neither is set, so the provider default applies', async () => {
    expect(await modelSentTo(undefined)).toBeUndefined();
  });
});
