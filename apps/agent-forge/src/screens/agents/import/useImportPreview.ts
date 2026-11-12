/**
 * The import sheet's live preview (L08b): debounced 400 ms after the last
 * keystroke, `POST /agents/import/preview` through the runtime client. A
 * request counter drops answers that arrive after the inputs moved on, and
 * empty (or whitespace-only) text never reaches the server. Mode and target
 * are part of the request because `resolvedId` - the id the sheet shows in
 * the mode hints - depends on them.
 */
import { useEffect, useRef, useState } from 'react';
import type { ImportMode, ImportPreview } from '../../../../shared/wireTypes';
import { RuntimeApiError, runtimeClient } from '../../../runtime/runtimeClient';

/** What {@link useImportPreview} returns: the latest answer, its error, and whether a request is in flight. */
export interface ImportPreviewState {
  preview: ImportPreview | undefined;
  error: { message: string; code?: string } | undefined;
  loading: boolean;
}

const DEBOUNCE_MS = 400;

const EMPTY: ImportPreviewState = { preview: undefined, error: undefined, loading: false };

/** The runtime client's error reduced to the sheet's `{ message, code }` shape. */
function toPreviewError(error: unknown): { message: string; code?: string } {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: error instanceof RuntimeApiError ? error.code : undefined,
  };
}

export function useImportPreview(
  text: string,
  mode: ImportMode,
  targetId: string | undefined
): ImportPreviewState {
  const [state, setState] = useState<ImportPreviewState>(EMPTY);
  // Bumped per scheduled request; a response only lands while it is still latest.
  const requestSeq = useRef(0);

  useEffect(() => {
    if (text.trim() === '') {
      requestSeq.current += 1;
      setState(EMPTY);
      return;
    }
    const seq = ++requestSeq.current;
    setState({ preview: undefined, error: undefined, loading: true });
    const timer = setTimeout(() => {
      runtimeClient
        .previewImport({ text, mode, targetId })
        .then((preview) => {
          if (requestSeq.current === seq) setState({ preview, error: undefined, loading: false });
        })
        .catch((error: unknown) => {
          if (requestSeq.current === seq) setState({ preview: undefined, error: toPreviewError(error), loading: false });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, mode, targetId]);

  return state;
}
