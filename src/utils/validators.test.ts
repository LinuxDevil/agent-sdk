import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  validateWithSchema,
  safeValidate,
  isValidEmail,
  isValidUrl,
  isValidJson,
  sanitizeString,
  hasRequiredKeys,
} from './validators';

describe('validator utilities', () => {
  describe('schema validation', () => {
    it('should validate with schema', () => {
      const schema = z.object({ name: z.string() });
      const result = validateWithSchema(schema, { name: 'test' });
      expect(result).toEqual({ name: 'test' });
    });

    it('should throw on invalid data', () => {
      const schema = z.object({ age: z.number() });
      expect(() => validateWithSchema(schema, { age: 'invalid' })).toThrow();
    });

    it('should safely validate valid data', () => {
      const schema = z.object({ email: z.string().email() });
      const result = safeValidate(schema, { email: 'test@example.com' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('test@example.com');
      }
    });

    it('should return error on invalid data', () => {
      const schema = z.object({ email: z.string().email() });
      const result = safeValidate(schema, { email: 'invalid' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('email validation', () => {
    it('should validate correct emails', () => {
      expect(isValidEmail('test@example.com')).toBe(true);
      expect(isValidEmail('user+tag@domain.co.uk')).toBe(true);
    });

    it('should reject invalid emails', () => {
      expect(isValidEmail('invalid')).toBe(false);
      expect(isValidEmail('test@')).toBe(false);
      expect(isValidEmail('@example.com')).toBe(false);
    });
  });

  describe('URL validation', () => {
    it('should validate correct URLs', () => {
      expect(isValidUrl('https://example.com')).toBe(true);
      expect(isValidUrl('http://localhost:3000')).toBe(true);
      expect(isValidUrl('ftp://server.com/file')).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(isValidUrl('not a url')).toBe(false);
      expect(isValidUrl('://invalid')).toBe(false);
    });
  });

  describe('JSON validation', () => {
    it('should validate correct JSON', () => {
      expect(isValidJson('{"key":"value"}')).toBe(true);
      expect(isValidJson('[1,2,3]')).toBe(true);
      expect(isValidJson('null')).toBe(true);
    });

    it('should reject invalid JSON', () => {
      expect(isValidJson('not json')).toBe(false);
      expect(isValidJson('{invalid}')).toBe(false);
    });
  });

  describe('string sanitization', () => {
    it('should sanitize HTML characters', () => {
      const input = '<script>alert("xss")</script>';
      const sanitized = sanitizeString(input);
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).toContain('&lt;');
      expect(sanitized).toContain('&gt;');
    });

    it('should handle quotes', () => {
      const input = `"double" and 'single'`;
      const sanitized = sanitizeString(input);
      expect(sanitized).toContain('&quot;');
      expect(sanitized).toContain('&#39;');
    });
  });

  describe('required keys validation', () => {
    it('should validate object has required keys', () => {
      const obj = { name: 'test', age: 25 };
      expect(hasRequiredKeys(obj, ['name', 'age'])).toBe(true);
    });

    it('should reject object missing keys', () => {
      const obj = { name: 'test' };
      expect(hasRequiredKeys(obj, ['name', 'age'])).toBe(false);
    });

    it('should handle undefined values', () => {
      const obj = { name: 'test', age: undefined };
      expect(hasRequiredKeys(obj, ['name', 'age'])).toBe(false);
    });
  });
});

