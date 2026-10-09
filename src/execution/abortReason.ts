/**
 * Eve CORE-F15: an aborted signal's `reason` as `{ name, message }` (an
 * Error or DOMException's own, e.g. `TimeoutError` from `AbortSignal.timeout()`;
 * `AbortError` with the text of any other reason). `ExecutionResult.abortReason`.
 */
export function abortReasonOf(signal: AbortSignal | undefined): { name: string; message: string } {
  const reason: unknown = signal?.reason;
  if (typeof reason === 'object' && reason !== null && typeof (reason as Error).name === 'string') {
    const { name, message } = reason as Error;
    return { name, message: typeof message === 'string' ? message : '' };
  }
  return { name: 'AbortError', message: reason === undefined ? 'This operation was aborted' : String(reason) };
}
