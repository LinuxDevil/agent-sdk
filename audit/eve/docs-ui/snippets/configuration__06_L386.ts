// configuration.md:386
import { BudgetExceededError, createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  provider,
  limits: { maxTokens: 50_000, maxCostUsd: 0.25, maxDurationMs: 60_000 },
});
const result = await agent.send('Research this thoroughly');
if (result.finishReason === 'budget-exceeded') {
  console.warn(`Stopped by ${result.budget?.limit}: ${result.budget?.value} of ${result.budget?.max}`);
}

try {
  await createAgent({ provider, limits: { maxCostUsd: 0.01, onExceeded: 'throw' } }).send('Go');
} catch (error) {
  if (error instanceof BudgetExceededError) console.error(error.budget);
}
export {};
