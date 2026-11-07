import { useEffect, useRef, useState } from 'react';

interface SyncedDraft<T> {
  draft: string;
  setDraft(text: string): void;
  error: string | undefined;
  setError(message: string | undefined): void;
  emit(next: T): void;
}

export function useSyncedDraft<T>(
  value: T,
  format: (value: T) => string,
  onChange: (value: T) => void
): SyncedDraft<T> {
  const [draft, setDraft] = useState(() => format(value));
  const [error, setError] = useState<string | undefined>();
  const emitted = useRef<T>(value);
  useEffect(() => {
    if (Object.is(value, emitted.current)) return;
    emitted.current = value;
    setDraft(format(value));
    setError(undefined);
  }, [value, format]);

  const emit = (next: T) => {
    setError(undefined);
    emitted.current = next;
    onChange(next);
  };

  return { draft, setDraft, error, setError, emit };
}
