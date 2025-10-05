/**
 * File extraction and processing utilities
 * Handles conversion of various file formats (PDF, Office docs, etc.) to text or images
 */

// Type-safe way to access Buffer without Node.js type dependencies
declare const Buffer: any;

export interface ProcessFilesParams {
  inputObject: Record<string, string | string[]>; // base64 or array of base64
  pdfExtractText?: boolean; // default false
}

/**
 * Get MIME type from base64 data URI
 */
export function getMimeType(base64Data: string): string | null {
  // Expecting strings like: data:application/pdf;base64,JVBERi0x...
  const match = base64Data.match(/^data:([^;]+);base64,/);
  return match ? match[1] : null;
}

/**
 * Get file extension from MIME type
 */
export function getFileExtensionFromMimeType(mimeType: string): string {
  const map: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/html': 'html',
    'text/csv': 'csv',
    'application/json': 'json',
    'application/zip': 'zip',
    'text/markdown': 'md',
    'text/plain': 'txt',
  };
  return map[mimeType] || 'not_convertible';
}

/**
 * Replace base64 content in strings with a placeholder
 * Useful for logging and debugging without exposing large binary data
 */
export function replaceBase64Content(data: string): string {
  // Remove all base64 encoded content from the "image" fields
  return data.replace(
    /data:image\/[a-zA-Z]+;base64,[a-zA-Z0-9+/=]+/g,
    'File content removed'
  );
}

/**
 * Check if buffer contains binary data (non-printable characters)
 */
export function isBinaryData(buffer: any): boolean {
  return buffer.some(
    (byte: number) =>
      (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 255
  );
}

/**
 * Extract base64 data part from data URI
 */
export function extractBase64Data(base64Str: string): string {
  const parts = base64Str.split(',');
  if (parts.length < 2) {
    return base64Str;
  }
  return parts[1];
}

/**
 * Create a data URI from MIME type and base64 data
 */
export function createDataUri(mimeType: string, base64Data: string): string {
  return `data:${mimeType};base64,${base64Data}`;
}
