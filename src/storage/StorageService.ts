/**
 * File storage service with locking mechanism
 * 
 * Provides file I/O operations with concurrency control using file locks.
 * Supports binary, text, and JSON file operations.
 */

import { IStorageService } from './types';

// Type-safe way to access Buffer and process without Node.js type dependencies
declare const Buffer: any;
declare const process: any;

/**
 * Storage service for managing file operations with locking
 * 
 * Note: This is a framework-agnostic interface. Actual implementations
 * should be provided by the consuming application (e.g., Node.js fs-based,
 * cloud storage, etc.)
 */
export class StorageService implements IStorageService {
  private rootPath: string;
  private uploadPath: string;
  private schema: string;
  private fs: any; // Will be provided by implementation
  private path: any; // Will be provided by implementation

  constructor(
    databaseIdHash: string,
    schema: string,
    fs: any,
    path: any,
    rootPath?: string
  ) {
    this.fs = fs;
    this.path = path;
    // Use rootPath if provided, otherwise try to get current working directory
    this.rootPath = rootPath || (typeof process !== 'undefined' && process.cwd ? process.cwd() : '.');
    this.uploadPath = this.path.join(this.rootPath, 'data', databaseIdHash, schema);
    this.schema = schema;
  }

  /**
   * Ensures that the target directory (uploadPath) exists.
   */
  private ensureDirExists(): void {
    if (!this.fs.existsSync(this.uploadPath)) {
      this.fs.mkdirSync(this.uploadPath, { recursive: true });
    }
  }

  /**
   * Resolve the absolute path for a particular storage key (file name).
   */
  private getFilePath(storageKey: string): string {
    return this.path.resolve(this.uploadPath, storageKey);
  }

  /**
   * Resolve the absolute path for the lock file used by concurrency.
   */
  private getLockFilePath(storageKey: string): string {
    return `${this.getFilePath(storageKey)}.lock`;
  }

  /**
   * Simple helper to wait between lock acquisition attempts.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Acquire an exclusive lock on a file by creating a ".lock" next to it.
   */
  public async acquireLock(
    storageKey: string,
    maxAttempts = 50,
    attemptDelayMs = 100
  ): Promise<void> {
    const lockFilePath = this.getLockFilePath(storageKey);
    let attempts = 0;

    while (this.fs.existsSync(lockFilePath)) {
      attempts++;
      if (attempts > maxAttempts) {
        throw new Error(
          `Could not acquire lock for "${storageKey}" after ${maxAttempts} attempts`
        );
      }
      await this.delay(attemptDelayMs);
    }

    this.fs.writeFileSync(lockFilePath, '');
  }

  /**
   * Release the lock by removing the ".lock" file.
   */
  public releaseLock(storageKey: string): void {
    const lockFilePath = this.getLockFilePath(storageKey);
    if (this.fs.existsSync(lockFilePath)) {
      this.fs.unlinkSync(lockFilePath);
    }
  }

  /**
   * Save a binary attachment from a File object (browser File).
   */
  public async saveAttachment(file: File, storageKey: string): Promise<void> {
    this.ensureDirExists();
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    this.fs.writeFileSync(this.getFilePath(storageKey), buffer);
  }

  /**
   * Save a binary attachment from a base64 string.
   */
  public async saveAttachmentFromBase64(base64: string, storageKey: string): Promise<void> {
    this.ensureDirExists();
    // Use Buffer if available (Node.js environment)
    const buffer = typeof Buffer !== 'undefined' ? Buffer.from(base64, 'base64') : base64;
    this.fs.writeFileSync(this.getFilePath(storageKey), buffer);
  }

  /**
   * Save a plain-text file (UTF-8).
   */
  public async savePlainTextAttachment(text: string, storageKey: string): Promise<void> {
    this.ensureDirExists();
    this.fs.writeFileSync(this.getFilePath(storageKey), text, 'utf8');
  }

  /**
   * Read a plain-text file (UTF-8).
   */
  public readPlainTextAttachment(storageKey: string): string {
    const filePath = this.getFilePath(storageKey);
    return this.fs.readFileSync(filePath, 'utf8');
  }

  /**
   * Check if a file exists.
   */
  public fileExists(storageKey: string): boolean {
    const filePath = this.getFilePath(storageKey);
    return this.fs.existsSync(filePath);
  }

  /**
   * Read a binary attachment as an ArrayBuffer.
   */
  public readAttachment(storageKey: string): ArrayBuffer {
    const filePath = this.getFilePath(storageKey);
    const buffer = this.fs.readFileSync(filePath);
    return new Uint8Array(buffer).buffer;
  }

  /**
   * Read a binary attachment as a base64 data URI string (with mimeType).
   */
  public readAttachmentAsBase64WithMimeType(storageKey: string, mimeType: string): string {
    const filePath = this.getFilePath(storageKey);
    const buffer = this.fs.readFileSync(filePath).toString('base64');
    return `data:${mimeType};base64,${buffer}`;
  }

  /**
   * Delete a file by its storage key.
   */
  public deleteAttachment(storageKey: string): void {
    const filePath = this.getFilePath(storageKey);
    if (this.fs.existsSync(filePath)) {
      this.fs.rmSync(filePath);
    }
  }

  /**
   * Read a JSON file from disk and parse it. Returns {} if not found.
   */
  public readPlainJSONAttachment<T = any>(storageKey: string): T {
    this.ensureDirExists();
    const filePath = this.getFilePath(storageKey);
    if (!this.fs.existsSync(filePath)) {
      return {} as T;
    }
    const raw = this.fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  }

  /**
   * Writes data as JSON to disk. Checks size against maxFileSizeMB (default 10).
   */
  public writePlainJSONAttachment(storageKey: string, data: any, maxFileSizeMB = 10): void {
    this.ensureDirExists();
    const jsonString = JSON.stringify(data);
    // Calculate size (use Buffer if available, otherwise approximate)
    const size = typeof Buffer !== 'undefined' 
      ? Buffer.byteLength(jsonString, 'utf8')
      : jsonString.length;

    if (size > maxFileSizeMB * 1024 * 1024) {
      throw new Error(`File size limit of ${maxFileSizeMB}MB exceeded for ${storageKey}.`);
    }

    this.fs.writeFileSync(this.getFilePath(storageKey), jsonString, 'utf8');
  }
}
