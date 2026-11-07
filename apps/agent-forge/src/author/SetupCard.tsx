import { KeyRound } from 'lucide-react';
import { navigate } from '../router/router';
import './authorCards.css';

/** Props for {@link SetupCard}. */
export interface SetupCardProps {
  /** The `provider/model` id the Author is configured to run on. */
  model: string;
  /** The provider whose key is missing (`missingKeyFor` from `GET /settings/author`), when known. */
  missingKeyFor?: string;
  /** "Check again": re-queries `GET /settings/author` and redraws from its answer. */
  onRecheck(): void;
}

/** The hint's "an Anthropic | an OpenAI | an OpenRouter" phrase for the provider id, or the generic line. */
function keyPhrase(missingKeyFor: string | undefined): string {
  switch (missingKeyFor) {
    case 'anthropic':
      return 'an Anthropic';
    case 'openai':
      return 'an OpenAI';
    case 'openrouter':
      return 'an OpenRouter';
    default:
      return 'an API';
  }
}

/**
 * The card the Author dock shows instead of the conversation when the
 * configured Author model cannot run (PLAN 16.4: with no key the Author
 * shows a setup card - never a mock fallback). "Open Settings" lands on
 * the Settings screen where the provider keys live; "Check again"
 * re-reads the settings so a just-saved key flips the card off.
 */
export function SetupCard({ model, missingKeyFor, onRecheck }: SetupCardProps): JSX.Element {
  return (
    <div className="setup-card">
      <KeyRound className="setup-card-icon" size={24} strokeWidth={1.75} aria-hidden="true" />
      <p className="setup-card-title">Add an API key to use the Agent Author</p>
      <p className="setup-card-hint">
        {`The Author runs on ${model}. Add ${keyPhrase(missingKeyFor)} key in Settings, or pick another model there.`}
      </p>
      <div className="setup-card-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/settings')}>
          Open Settings
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRecheck}>
          Check again
        </button>
      </div>
    </div>
  );
}
