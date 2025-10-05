import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageService } from './StorageService';

describe('Storage - StorageService', () => {
  let mockFs: any;
  let mockPath: any;
  let storageService: StorageService;

  beforeEach(() => {
    // Mock fs module
    mockFs = {
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      rmSync: vi.fn(),
    };

    // Mock path module
    mockPath = {
      join: vi.fn((...args: string[]) => args.join('/')),
      resolve: vi.fn((...args: string[]) => args.join('/')),
    };

    storageService = new StorageService(
      'test-db-hash',
      'test-schema',
      mockFs,
      mockPath,
      '/test/root'
    );
  });

  describe('constructor', () => {
    it('should initialize with correct paths', () => {
      expect(mockPath.join).toHaveBeenCalledWith(
        '/test/root',
        'data',
        'test-db-hash',
        'test-schema'
      );
    });
  });

  describe('fileExists', () => {
    it('should check if file exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      const exists = storageService.fileExists('test.txt');
      expect(exists).toBe(true);
      expect(mockFs.existsSync).toHaveBeenCalled();
    });

    it('should return false if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      const exists = storageService.fileExists('nonexistent.txt');
      expect(exists).toBe(false);
    });
  });

  describe('savePlainTextAttachment', () => {
    it('should save text file', async () => {
      mockFs.existsSync.mockReturnValue(true);
      await storageService.savePlainTextAttachment('Hello World', 'test.txt');
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        'Hello World',
        'utf8'
      );
    });

    it('should create directory if it does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);
      await storageService.savePlainTextAttachment('Test', 'test.txt');
      expect(mockFs.mkdirSync).toHaveBeenCalled();
    });
  });

  describe('readPlainTextAttachment', () => {
    it('should read text file', () => {
      mockFs.readFileSync.mockReturnValue('File Content');
      const content = storageService.readPlainTextAttachment('test.txt');
      expect(content).toBe('File Content');
      expect(mockFs.readFileSync).toHaveBeenCalledWith(expect.any(String), 'utf8');
    });
  });

  describe('writePlainJSONAttachment', () => {
    it('should write JSON file', () => {
      mockFs.existsSync.mockReturnValue(true);
      const data = { key: 'value', number: 42 };
      storageService.writePlainJSONAttachment('test.json', data);
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify(data),
        'utf8'
      );
    });

    it('should throw error if file size exceeds limit', () => {
      mockFs.existsSync.mockReturnValue(true);
      const largeData = { data: 'x'.repeat(11 * 1024 * 1024) }; // 11MB
      expect(() => {
        storageService.writePlainJSONAttachment('large.json', largeData, 10);
      }).toThrow('File size limit');
    });

    it('should respect custom size limit', () => {
      mockFs.existsSync.mockReturnValue(true);
      const data = { data: 'x'.repeat(2 * 1024 * 1024) }; // 2MB
      storageService.writePlainJSONAttachment('test.json', data, 5);
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('readPlainJSONAttachment', () => {
    it('should read and parse JSON file', () => {
      mockFs.existsSync.mockReturnValue(true);
      const data = { key: 'value', number: 42 };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(data));
      const result = storageService.readPlainJSONAttachment('test.json');
      expect(result).toEqual(data);
    });

    it('should return empty object if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      const result = storageService.readPlainJSONAttachment('nonexistent.json');
      expect(result).toEqual({});
    });
  });

  describe('deleteAttachment', () => {
    it('should delete file if it exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      storageService.deleteAttachment('test.txt');
      expect(mockFs.rmSync).toHaveBeenCalled();
    });

    it('should not throw error if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      expect(() => {
        storageService.deleteAttachment('nonexistent.txt');
      }).not.toThrow();
    });
  });

  describe('acquireLock', () => {
    it('should acquire lock immediately if no lock file exists', async () => {
      mockFs.existsSync.mockReturnValue(false);
      await storageService.acquireLock('test.txt');
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should throw error if cannot acquire lock after max attempts', async () => {
      mockFs.existsSync.mockReturnValue(true);
      await expect(
        storageService.acquireLock('test.txt', 2, 10)
      ).rejects.toThrow('Could not acquire lock');
    });
  });

  describe('releaseLock', () => {
    it('should remove lock file', () => {
      mockFs.existsSync.mockReturnValue(true);
      storageService.releaseLock('test.txt');
      expect(mockFs.unlinkSync).toHaveBeenCalled();
    });

    it('should not throw error if lock file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      expect(() => {
        storageService.releaseLock('test.txt');
      }).not.toThrow();
    });
  });

  describe('saveAttachmentFromBase64', () => {
    it('should save file from base64 string', async () => {
      mockFs.existsSync.mockReturnValue(true);
      const base64 = 'SGVsbG8gV29ybGQ='; // "Hello World" in base64
      await storageService.saveAttachmentFromBase64(base64, 'test.txt');
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('readAttachmentAsBase64WithMimeType', () => {
    it('should read file as base64 data URI', () => {
      const mockBuffer = Buffer.from('Hello World');
      mockFs.readFileSync.mockReturnValue(mockBuffer);
      const result = storageService.readAttachmentAsBase64WithMimeType(
        'test.txt',
        'text/plain'
      );
      expect(result).toContain('data:text/plain;base64,');
      expect(result).toContain(mockBuffer.toString('base64'));
    });
  });
});
