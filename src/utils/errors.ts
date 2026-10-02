import { ZodError, type ZodIssue } from 'zod';
import { newId } from './id';
import { issueMessage } from './zodCompat';

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
export function formatZodError(err: unknown): { type: string; message: string; [key: string]: unknown } {
  let errorChunk: { type: string; message: string; [key: string]: unknown } = { 
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
      flowNodeId: newId(),
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
  return error.issues.map((e: ZodIssue) => `${String(e.path[0])}: ${issueMessage(e)}`).join(', ');
}

/**
 * Format Axios error (if axios is being used)
 */
export function formatAxiosError(error: unknown): string {
  const axiosError = error as AxiosErrorLike;
  if (axiosError.isAxiosError) {
    return `HTTP Error ${axiosStatusLabel(axiosError)}${describeAxiosErrorDetail(axiosError)}`;
  }

  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/** The fields of an axios error read here (axios is not a dependency). */
type AxiosErrorLike = {
  isAxiosError?: unknown;
  message?: string;
  response?: { status?: number; data?: unknown };
};

function axiosStatusLabel(error: AxiosErrorLike): number | string {
  return error.response?.status || 'Unknown Status';
}

function describeAxiosErrorDetail(error: AxiosErrorLike): string {
  const data = error.response?.data;
  if (!data) return `: ${error.message}`;
  return describeAxiosErrorBody(data);
}

function describeAxiosErrorBody(data: unknown): string {
  if (typeof data === 'string') return `: ${data}`;
  if (typeof data === 'object') return `: ${JSON.stringify(data, null, 2)}`;
  return '';
}
