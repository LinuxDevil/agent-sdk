import { describe, it, expect } from 'vitest';
import {
  getMimeType,
  getFileExtensionFromMimeType,
  replaceBase64Content,
  isBinaryData,
  extractBase64Data,
  createDataUri,
} from './file-extractor';

describe('File Extractor Utilities', () => {
  describe('getMimeType', () => {
    it('should extract MIME type from data URI', () => {
      const dataUri = 'data:application/pdf;base64,JVBERi0x...';
      expect(getMimeType(dataUri)).toBe('application/pdf');
    });

    it('should return null for invalid format', () => {
      expect(getMimeType('invalid')).toBeNull();
    });

    it('should handle image MIME types', () => {
      const imageUri = 'data:image/png;base64,iVBORw0KGgo...';
      expect(getMimeType(imageUri)).toBe('image/png');
    });
  });

  describe('getFileExtensionFromMimeType', () => {
    it('should return correct extension for PDF', () => {
      expect(getFileExtensionFromMimeType('application/pdf')).toBe('pdf');
    });

    it('should return correct extension for images', () => {
      expect(getFileExtensionFromMimeType('image/png')).toBe('png');
      expect(getFileExtensionFromMimeType('image/jpeg')).toBe('jpg');
    });

    it('should return correct extension for Office documents', () => {
      expect(
        getFileExtensionFromMimeType(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        )
      ).toBe('docx');
    });

    it('should return not_convertible for unknown types', () => {
      expect(getFileExtensionFromMimeType('application/unknown')).toBe(
        'not_convertible'
      );
    });
  });

  describe('replaceBase64Content', () => {
    it('should replace base64 image content', () => {
      const text =
        'Image: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const result = replaceBase64Content(text);
      expect(result).toContain('File content removed');
      expect(result).not.toContain('iVBORw0KGgo');
    });

    it('should handle multiple images', () => {
      const text =
        'First: data:image/png;base64,abc123 Second: data:image/jpeg;base64,xyz789';
      const result = replaceBase64Content(text);
      const matches = (result.match(/File content removed/g) || []).length;
      expect(matches).toBe(2);
    });
  });

  describe('isBinaryData', () => {
    it('should detect binary data', () => {
      const binaryBuffer = Buffer.from([0, 1, 2, 255, 254]);
      expect(isBinaryData(binaryBuffer)).toBe(true);
    });

    it('should return false for text data', () => {
      const textBuffer = Buffer.from('Hello World', 'utf-8');
      expect(isBinaryData(textBuffer)).toBe(false);
    });

    it('should allow common whitespace characters', () => {
      const textWithWhitespace = Buffer.from('Hello\tWorld\nTest\r', 'utf-8');
      expect(isBinaryData(textWithWhitespace)).toBe(false);
    });
  });

  describe('extractBase64Data', () => {
    it('should extract base64 data from data URI', () => {
      const dataUri = 'data:image/png;base64,iVBORw0KGgo';
      expect(extractBase64Data(dataUri)).toBe('iVBORw0KGgo');
    });

    it('should return original string if no comma found', () => {
      const data = 'plaintext';
      expect(extractBase64Data(data)).toBe('plaintext');
    });
  });

  describe('createDataUri', () => {
    it('should create proper data URI', () => {
      const mimeType = 'image/png';
      const base64 = 'iVBORw0KGgo';
      const result = createDataUri(mimeType, base64);
      expect(result).toBe('data:image/png;base64,iVBORw0KGgo');
    });

    it('should work with different MIME types', () => {
      const result = createDataUri('application/pdf', 'JVBERi0x');
      expect(result).toBe('data:application/pdf;base64,JVBERi0x');
    });
  });
});
