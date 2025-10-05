import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  getErrorMessage,
  formatZodError,
  getZodErrorMessage,
  formatAxiosError,
} from './errors';

describe('error utilities', () => {
  describe('getErrorMessage', () => {
    it('should get message from Error', () => {
      const error = new Error('Test error');
      expect(getErrorMessage(error)).toBe('Test error');
    });

    it('should get message from object with message', () => {
      const error = { message: 'Custom error' };
      expect(getErrorMessage(error)).toBe('Custom error');
    });

    it('should stringify non-error objects', () => {
      const error = { code: 500, status: 'error' };
      const message = getErrorMessage(error);
      expect(message).toContain('code');
      expect(message).toContain('500');
    });

    it('should handle primitive types', () => {
      expect(getErrorMessage('simple string')).toBe('"simple string"');
      expect(getErrorMessage(123)).toBe('123');
    });
  });

  describe('formatZodError', () => {
    it('should format Zod error', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      try {
        schema.parse({ name: 123, age: 'invalid' });
      } catch (error) {
        const formatted = formatZodError(error);
        expect(formatted.type).toBe('error');
        expect(formatted.message).toContain('name');
        expect(formatted.message).toContain('age');
      }
    });

    it('should format non-Zod error', () => {
      const error = new Error('Regular error');
      const formatted = formatZodError(error);
      expect(formatted.type).toBe('error');
      expect(formatted.message).toBe('Regular error');
    });
  });

  describe('getZodErrorMessage', () => {
    it('should format Zod error as simple string', () => {
      const schema = z.object({
        email: z.string().email(),
      });

      try {
        schema.parse({ email: 'invalid' });
      } catch (error) {
        const message = getZodErrorMessage(error as z.ZodError);
        expect(message).toContain('email');
        expect(message).toContain('Invalid email');
      }
    });
  });

  describe('formatAxiosError', () => {
    it('should format Axios-like error', () => {
      const error = {
        isAxiosError: true,
        response: {
          status: 404,
          data: 'Not found',
        },
        message: 'Request failed',
      };

      const formatted = formatAxiosError(error);
      expect(formatted).toContain('404');
      expect(formatted).toContain('Not found');
    });

    it('should handle error without response data', () => {
      const error = {
        isAxiosError: true,
        message: 'Network error',
      };

      const formatted = formatAxiosError(error);
      expect(formatted).toContain('Network error');
    });

    it('should handle non-Axios error', () => {
      const error = new Error('Regular error');
      const formatted = formatAxiosError(error);
      expect(formatted).toContain('Unexpected error');
      expect(formatted).toContain('Regular error');
    });
  });
});
