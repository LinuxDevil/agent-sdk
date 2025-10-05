/**
 * Storage types and interfaces
 */

/**
 * Storage service interface for file operations
 */
export interface IStorageService {
  /**
   * Read file as ArrayBuffer
   */
  readAttachment(key: string): ArrayBuffer;

  /**
   * Read file as base64 data URI with MIME type
   */
  readAttachmentAsBase64WithMimeType(key: string, mimeType: string): string;

  /**
   * Read plain text file
   */
  readPlainTextAttachment(key: string): string;

  /**
   * Read JSON file
   */
  readPlainJSONAttachment<T = any>(key: string): T;

  /**
   * Save file from File object
   */
  saveAttachment(file: File, key: string): Promise<void>;

  /**
   * Save file from base64 string
   */
  saveAttachmentFromBase64(base64: string, key: string): Promise<void>;

  /**
   * Save plain text file
   */
  savePlainTextAttachment(text: string, key: string): Promise<void>;

  /**
   * Write JSON file
   */
  writePlainJSONAttachment(key: string, data: any, maxFileSizeMB?: number): void;

  /**
   * Delete file
   */
  deleteAttachment(key: string): void;

  /**
   * Check if file exists
   */
  fileExists(key: string): boolean;

  /**
   * Acquire lock on a file
   */
  acquireLock(key: string, maxAttempts?: number, attemptDelayMs?: number): Promise<void>;

  /**
   * Release lock on a file
   */
  releaseLock(key: string): void;
}

/**
 * Storage configuration
 */
export interface StorageConfig {
  rootPath?: string;
  schema: string;
  databaseIdHash: string;
}
