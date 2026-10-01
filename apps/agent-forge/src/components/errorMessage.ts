/** User-facing message for a caught runtime-API (or any other) error. */
export function errorMessage(error: unknown): string {
  return (error as Error).message;
}
