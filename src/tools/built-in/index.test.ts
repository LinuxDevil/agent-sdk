import { describe, it, expect } from 'vitest';
import { currentDateTool } from './currentDate';
import { dayNameTool } from './dayName';
import { httpTool, createHttpTool } from './http';
import { createEmailTool } from './email';
import { getToolExecute } from '../toolContract';
import type { ToolExecutionContext } from '../../types';

/** The minimal execution context: these built-in tools read no fields off it (N9b's getToken/requireAuth fail loudly if one ever does). */
const ctx: ToolExecutionContext = {
  toolCallId: 'test-call',
  messages: [],
  getToken: () => Promise.reject(new Error('index.test.ts has no token store')),
  requireAuth: () => {
    throw new Error('index.test.ts has no token store');
  },
};

describe('Built-in Tools', () => {
  describe('currentDateTool', () => {
    it('should have correct display name', () => {
      expect(currentDateTool.displayName).toBe('Get current date');
    });

    it('should have a tool with execute function', () => {
      expect(currentDateTool.tool).toBeDefined();
      expect(typeof currentDateTool.tool.execute).toBe('function');
    });

    it('should return ISO date string', async () => {
      const result = await getToolExecute(currentDateTool)?.({}, ctx);
      expect(typeof result).toBe('string');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('dayNameTool', () => {
    it('should have correct display name', () => {
      expect(dayNameTool.displayName).toBe('Get day name');
    });

    it('should return day name for given date', async () => {
      const result = await getToolExecute(dayNameTool)?.({ date: '2024-01-15', locale: 'en-US' }, ctx);
      expect(result).toBe('Monday');
    });

    it('should use default locale if not provided', async () => {
      const result = await getToolExecute(dayNameTool)?.({ date: '2024-01-15' }, ctx);
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });

    it('should support different locales', async () => {
      const resultEN = await getToolExecute(dayNameTool)?.({ date: '2024-01-15', locale: 'en-US' }, ctx);
      const resultPL = await getToolExecute(dayNameTool)?.({ date: '2024-01-15', locale: 'ar-AR' }, ctx);
      expect(resultEN).not.toBe(resultPL);
    });
  });

  describe('httpTool', () => {
    it('should have correct display name', () => {
      expect(httpTool.displayName).toBe('Make HTTP request');
    });

    it('should have a tool with execute function', () => {
      expect(httpTool.tool).toBeDefined();
      expect(typeof httpTool.tool.execute).toBe('function');
    });
  });

  describe('createHttpTool', () => {
    it('should create tool with custom options', () => {
      const customTool = createHttpTool({
        timeout: 10000,
        maxRedirects: 3,
      });

      expect(customTool.displayName).toBe('Make HTTP request');
      expect(customTool.tool).toBeDefined();
    });

    it('should create tool with default options', () => {
      const defaultTool = createHttpTool();
      expect(defaultTool.displayName).toBe('Make HTTP request');
    });
  });

  describe('createEmailTool', () => {
    it('should create tool with apiKey', () => {
      const emailTool = createEmailTool({
        apiKey: 'test-api-key',
      });

      expect(emailTool.displayName).toBe('Send email');
      expect(emailTool.tool).toBeDefined();
    });

    it('should throw error if apiKey is missing', () => {
      expect(() => {
        createEmailTool({
          apiKey: '',
        });
      }).toThrow('Email tool requires an apiKey');
    });

    it('should create tool with custom configuration', () => {
      const emailTool = createEmailTool({
        apiKey: 'test-api-key',
        apiUrl: 'https://custom-api.com/emails',
        defaultFrom: 'sender@example.com',
      });

      expect(emailTool.displayName).toBe('Send email');
    });
  });
});
