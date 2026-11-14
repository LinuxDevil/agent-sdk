import { useState } from 'react';

export function useDraftSender(submit: (text: string) => Promise<unknown>, disabled = false) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function send() {
    const text = draft.trim();
    if (!text || disabled || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await submit(text);
      setDraft('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return { draft, setDraft, sending, error, send, onKeyDown };
}
