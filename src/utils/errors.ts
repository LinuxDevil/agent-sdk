import { ZodError, type ZodIssue } from 'zod';
import { nanoid } from 'nanoid';

type ErrorWithMessage = {
  message: string;
};

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

function toErrorWithMessage(maybeError: unknown): ErrorWithMessage {
  if (isErrorWithMessage(maybeError)) return maybeError;

  try {
    return new Error(JSON.stringify(maybeError));
  } catch {
    // fallback in case there's an error stringifying the maybeError
    // like with circular references for example.
    return new Error(String(maybeError));
  }
}

/**
 * Get error message from any error type
 */
export function getErrorMessage(error: unknown): string {
  return toErrorWithMessage(error).message;
}

/**
 * Format Zod validation error
 */
export function formatZodError(err: unknown): { type: string; message: string; [key: string]: any } {
  let errorChunk: { type: string; message: string; [key: string]: any } = { 
    type: 'error', 
    message: getErrorMessage(err) 
  };

  if (err instanceof ZodError) {
    // Format each issue so it's easier to read in one string
    const formattedIssues = err.issues
      .map((issue: ZodIssue) => {
        const path = issue.path.join('.');
        const code = issue.code;
        return `Path: **${path}**; Code: **${code}**; Message: **${issue.message}**`;
      })
      .join('\n\n');

    errorChunk = {
      flowNodeId: nanoid(),
      type: 'error',
      message: formattedIssues,
    };
  }

  return errorChunk;
}

/**
 * Get Zod error message (simple format)
 */
export function getZodErrorMessage(error: ZodError): string {
  return error.errors.map((e: ZodIssue) => e.path[0] + ': ' + e.message).join(', ');
}

/**
 * Format Axios error (if axios is being used)
 */
export function formatAxiosError(error: any): string {
  if (error.isAxiosError) {
    const status = error.response?.status || 'Unknown Status';
    const data = error.response?.data;

    let errorMessage = `HTTP Error ${status}`;

    if (data) {
      if (typeof data === 'string') {
        errorMessage += `: ${data}`;
      } else if (typeof data === 'object') {
        errorMessage += `: ${JSON.stringify(data, null, 2)}`;
      }
    } else {
      errorMessage += `: ${error.message}`;
    }

    return errorMessage;
  }

  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}
