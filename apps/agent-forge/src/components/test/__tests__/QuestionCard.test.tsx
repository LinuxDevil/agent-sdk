/**
 * QuestionCard: the Test pane's inline card for a `kind: 'question'`
 * pause - the question text, its options as one-click answer buttons, a
 * free-text box (unless the question forbade it) and the "Answer within"
 * countdown.
 */
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../../../ui/__tests__/render';

const appState = vi.hoisted(() => ({
  answerQuestion: vi.fn(async () => {}),
}));
vi.mock('../../../state/AppState', () => ({ useAppState: () => appState }));

import { QuestionCard } from '../QuestionCard';

const deadline = new Date(Date.now() + 15 * 60_000).toISOString();
const question = { text: 'Which city should we book?', options: ['Porto', 'Lisbon'] };

function typeTextarea(host: HTMLElement, value: string) {
  const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return textarea;
}

describe('QuestionCard', () => {
  it('shows the question, its options as buttons, the free-text box and the countdown', () => {
    const container = render(<QuestionCard question={question} deadline={deadline} />);
    expect(container.querySelector('.question-text')?.textContent).toBe('Which city should we book?');
    expect([...container.querySelectorAll('.question-options .btn-secondary')].map((b) => b.textContent)).toEqual([
      'Porto',
      'Lisbon',
    ]);
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('.deadline-line')?.textContent).toContain('Answer within');
  });

  it('clicking an option sends it as the answer', async () => {
    const container = render(<QuestionCard question={question} deadline={deadline} />);
    const porto = [...container.querySelectorAll('.question-options button')][0] as HTMLButtonElement;
    await act(async () => porto.click());
    expect(appState.answerQuestion).toHaveBeenCalledWith('Porto');
  });

  it('the free-text box sends a typed answer', async () => {
    const container = render(<QuestionCard question={question} deadline={deadline} />);
    typeTextarea(container, 'Faro');
    const send = container.querySelector('.question-send') as HTMLButtonElement;
    await act(async () => send.click());
    expect(appState.answerQuestion).toHaveBeenCalledWith('Faro');
  });

  it('hides the free-text box only when the question forbids it', () => {
    const closed = render(<QuestionCard question={{ ...question, allowFreeText: false }} deadline={deadline} />);
    expect(closed.querySelector('textarea')).toBeNull();
    const open = render(<QuestionCard question={{ text: 'Any ideas?' }} deadline={deadline} />);
    expect(open.querySelector('textarea')).not.toBeNull();
  });

  it('disables the buttons while an answer is in flight and shows a failure inline', async () => {
    let resolve: () => void = () => undefined;
    appState.answerQuestion.mockImplementationOnce(() => new Promise<void>((r) => (resolve = r)));
    const container = render(<QuestionCard question={question} deadline={deadline} />);
    const option = container.querySelector('.question-options button') as HTMLButtonElement;
    await act(async () => {
      option.click();
      await Promise.resolve();
    });
    expect([...container.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
    await act(async () => resolve());

    appState.answerQuestion.mockImplementationOnce(async () => {
      throw new Error('server gone');
    });
    await act(async () => option.click());
    expect(container.querySelector('.question-error')?.textContent).toContain('server gone');
  });
});
