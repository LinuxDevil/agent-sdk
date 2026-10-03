/**
 * File storage service with locking mechanism
 * 
 * Provides file I/O operations with concurrency control using file locks.
 * Supports binary, text, and JSON file operations.
 */

import { IStorageService } from './types';
import { SDKError } from '../execution/errors';

// Buffer and process exist on Node.js only (checked with typeof before use);
// declared with just the members used, so this module needs no Node.js types.
declare const Buffer: {
  from(data: string, encoding: 'base64'): Uint8Array;
  byteLength(data: string, encoding: 'utf8'): number;
};
declare const process: { cwd?: () => string };

/**
 * Minimal shape of the Node.js `fs` module (or a compatible implementation)
 * required by StorageService. Only the methods actually called on the
 * injected `fs` instance are declared here. Encodings are typed as the one
 * value StorageService passes (`'utf8'`) so the real `node:fs` module is
 * assignable without a cast: `new StorageService(id, dir, fs, path)` with
 * `import * as fs from 'node:fs'`.
 */
export interface FileSystemAdapter {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  writeFileSync(path: string, data: string | Uint8Array, encoding?: 'utf8'): void;
  unlinkSync(path: string): void;
  readFileSync(path: string, encoding: 'utf8'): string;
  readFileSync(path: string): Buffer;
  rmSync(path: string): void;
}

/**
 * Minimal shape of the Node.js `path` module (or a compatible implementation)
 * required by StorageService.
 */
export interface PathAdapter {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}

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
  private fs: FileSystemAdapter;
  private path: PathAdapter;

  constructor(
    databaseIdHash: string,
    schema: string,
    fs: FileSystemAdapter,
    path: PathAdapter,
    rootPath?: string
  ) {
    this.fs = fs;
    this.path = path;
    // Use rootPath if provided, otherwise try to get current working directory
    this.rootPath = rootPath || (typeof process !== 'undefined' && process.cwd ? process.cwd() : '.');
    this.uploadPath = this.path.join(this.rootPath, 'data', databaseIdHash, schema);
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
   * Ensures that the parent directory of a resolved file path exists.
   * Storage keys may name subdirectories (e.g. `checkpoints/<id>.json`), so
   * creating only `uploadPath` is not enough: on a fresh root the first
   * write (or `.lock` file) in a subdirectory fails with ENOENT (LOU-R9).
   */
  private ensureParentDirExists(filePath: string): void {
    const separator = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const parent = separator > 0 ? filePath.slice(0, separator) : this.uploadPath;
    if (!this.fs.existsSync(parent)) {
      this.fs.mkdirSync(parent, { recursive: true });
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
        throw new SDKError(
          `Could not acquire lock for "${storageKey}" after ${maxAttempts} attempts`,
          'LOUSHO_STORAGE_FAILED'
        );
      }
      await this.delay(attemptDelayMs);
    }

    this.ensureParentDirExists(lockFilePath);
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
    this.ensureParentDirExists(this.getFilePath(storageKey));
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    this.fs.writeFileSync(this.getFilePath(storageKey), buffer);
  }

  /**
   * Save a binary attachment from a base64 string.
   */
  public async saveAttachmentFromBase64(base64: string, storageKey: string): Promise<void> {
    this.ensureParentDirExists(this.getFilePath(storageKey));
    // Use Buffer if available (Node.js environment)
    const buffer = typeof Buffer !== 'undefined' ? Buffer.from(base64, 'base64') : base64;
    this.fs.writeFileSync(this.getFilePath(storageKey), buffer);
  }

  /**
   * Save a plain-text file (UTF-8).
   */
  public async savePlainTextAttachment(text: string, storageKey: string): Promise<void> {
    this.ensureParentDirExists(this.getFilePath(storageKey));
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
  public readPlainJSONAttachment<T = unknown>(storageKey: string): T {
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
  public writePlainJSONAttachment(storageKey: string, data: unknown, maxFileSizeMB = 10): void {
    this.ensureParentDirExists(this.getFilePath(storageKey));
    const jsonString = JSON.stringify(data);
    // Calculate size (use Buffer if available, otherwise approximate)
    const size = typeof Buffer !== 'undefined' 
      ? Buffer.byteLength(jsonString, 'utf8')
      : jsonString.length;

    if (size > maxFileSizeMB * 1024 * 1024) {
      throw new SDKError(`File size limit of ${maxFileSizeMB}MB exceeded for ${storageKey}.`, 'LOUSHO_STORAGE_FAILED');
    }

    this.fs.writeFileSync(this.getFilePath(storageKey), jsonString, 'utf8');
  }
}
