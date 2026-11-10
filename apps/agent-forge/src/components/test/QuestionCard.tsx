/**
 * The Test pane's inline card for a run paused on an `ask_question` call
 * (`PendingApprovalInfo.kind === 'question'`, answered through
 * `POST /agents/:id/approve` with `{ answer }`): the question text, its
 * options as one-click answer buttons, a free-text answer box (unless
 * the question forbade it) and the "Answer within" countdown - Studio
 * resolves the pause itself at that deadline, so the card doubles as the
 * clock. Lives next to the approval card in the chat thread (ChatPanel's
 * ApprovalBubble picks between them by `kind`).
 */
import { useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { useAppState } from '../../state/AppState';
import { DeadlineLine } from '../ApprovalCard';
import type { PendingApprovalInfo } from '../../../shared/wireTypes';

type Question = NonNullable<PendingApprovalInfo['question']>;

export interface QuestionCardProps {
  question: Question;
  /** The pause's self-resolution deadline (ISO) - the "Answer within" countdown's target. */
  deadline: string;
  className?: string;
}

/** `true` when the user may type their own answer: always with no options, unless `allowFreeText` is `false`. */
function allowsFreeText(question: Question): boolean {
  return question.allowFreeText !== false || (question.options ?? []).length === 0;
}

export function QuestionCard({ question, deadline, className }: QuestionCardProps) {
  const { answerQuestion } = useAppState();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const options = question.options ?? [];

  async function send(answer: string) {
    setError(undefined);
    setSending(true);
    try {
      await answerQuestion(answer);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={`question-card${className ? ` ${className}` : ''}`}>
      <div className="question-head">
        <span className="question-icon-tile" aria-hidden="true">
          <MessageCircleQuestion size={16} strokeWidth={1.75} />
        </span>
        <span className="question-text">{question.text}</span>
      </div>
      {options.length > 0 && (
        <div className="question-options">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className="btn btn-secondary"
              disabled={sending}
              onClick={() => void send(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      {allowsFreeText(question) && (
        <div className="question-answer">
          <textarea
            aria-label="Answer"
            className="question-input"
            rows={2}
            placeholder="Type your answer"
            value={draft}
            disabled={sending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && draft.trim() !== '') {
                e.preventDefault();
                void send(draft.trim());
              }
            }}
          />
          <button
            type="button"
            className="btn btn-primary question-send"
            disabled={sending || draft.trim() === ''}
            onClick={() => void send(draft.trim())}
          >
            {sending ? 'Sending...' : 'Send answer'}
          </button>
        </div>
      )}
      <DeadlineLine deadline={deadline} verb="Answer" />
      {error && (
        <div className="question-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
