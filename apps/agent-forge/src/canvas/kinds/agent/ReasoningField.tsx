/**
 * The `fields.reasoning` control (C03): a `ChoiceField` over the SDK's
 * `ReasoningOption` — unset → Default, `'none'`/`'minimal'`/`'low'`/
 * `'medium'`/`'high'` → the effort labels, `{ budgetTokens }` → "Token
 * budget" plus an `OptionalNumberField` for the budget. When the catalog
 * says the picked model has no reasoning support the field shows a
 * warning hint.
 */
import type { AgentFields as AgentNodeFields } from '../../../graph/v2/types';
import type { KindFieldsProps } from '../index';
import { ChoiceField } from '../../fields/ChoiceField';
import { OptionalNumberField } from '../../fields/OptionalNumberField';
import { useCatalog } from '../../useCatalog';

/** The `ChoiceField`'s internal values: the effort strings plus a sentinel for the budget object. */
type Choice = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'budget';

const OPTIONS: { value: Choice; label: string }[] = [
  { value: 'none', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'budget', label: 'Token budget' },
];

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high']);

/** The select's value for a spec `reasoning`: its effort, `'budget'`, or unset. */
function choiceOf(reasoning: AgentNodeFields['reasoning']): Choice | undefined {
  if (reasoning === undefined || reasoning === null) return undefined;
  if (typeof reasoning === 'string') return EFFORTS.has(reasoning) ? (reasoning as Choice) : undefined;
  if (reasoning.budgetTokens !== undefined) return 'budget';
  return reasoning.effort !== undefined && EFFORTS.has(reasoning.effort) ? (reasoning.effort as Choice) : undefined;
}

/** The current token budget of a budget-object `reasoning`, if any. */
function budgetOf(reasoning: AgentNodeFields['reasoning']): number | undefined {
  return typeof reasoning === 'object' && reasoning !== null ? reasoning.budgetTokens : undefined;
}

/** Props for {@link ReasoningField}. */
export interface ReasoningFieldProps {
  /** `fields.model`, used to look the model's reasoning capability up in the catalog. */
  model: AgentNodeFields['model'];
  reasoning: AgentNodeFields['reasoning'];
  patch: KindFieldsProps<'agent'>['patch'];
}

/** The reasoning choice + budget fields described above. */
export function ReasoningField({ model, reasoning, patch }: ReasoningFieldProps): JSX.Element {
  const { data: models } = useCatalog('models');
  const entry = models?.find((m) => m.id === model);
  const unsupported = entry !== undefined && entry.capabilities.reasoning === false;

  const onChoice = (choice: Choice | undefined) => {
    if (choice === undefined) {
      patch({ reasoning: undefined });
    } else if (choice === 'budget') {
      patch({ reasoning: { budgetTokens: budgetOf(reasoning) ?? 1024 } });
    } else {
      patch({ reasoning: choice });
    }
  };

  const onBudget = (tokens: number | undefined) => {
    patch({ reasoning: tokens === undefined ? undefined : { budgetTokens: tokens } });
  };

  return (
    <>
      <ChoiceField<Choice>
        id="node-agent-reasoning"
        label="Reasoning"
        value={choiceOf(reasoning)}
        options={OPTIONS}
        onChange={onChoice}
        allowUnset
        help={
          <>
            Only models with reasoning support use this.
            {unsupported ? (
              <>
                {' '}
                <span className="field-warning">This model does not support reasoning.</span>
              </>
            ) : null}
          </>
        }
      />
      {choiceOf(reasoning) === 'budget' ? (
        <OptionalNumberField
          id="node-agent-reasoning-budget"
          label="Reasoning budget"
          value={budgetOf(reasoning)}
          onChange={onBudget}
          min={1024}
          max={200000}
          integer
        />
      ) : null}
    </>
  );
}
