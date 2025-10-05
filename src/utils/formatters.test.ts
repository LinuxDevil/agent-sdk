import { describe, it, expect } from 'vitest';
import {
  getCurrentTS,
  getTS,
  formatDate,
  safeJsonParse,
  removeCodeBlocks,
  findCodeBlocks,
  checkApiKey,
} from './formatters';

describe('formatter utilities', () => {
  describe('date formatters', () => {
    it('should format current timestamp', () => {
      const ts = getCurrentTS();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('should format specific date', () => {
      const date = new Date('2025-01-15T10:30:45');
      const ts = getTS(date);
      expect(ts).toBe('2025-01-15 10:30:45');
    });

    it('should format date to locale string', () => {
      const date = new Date('2025-01-15T10:30:45');
      const formatted = formatDate(date);
      expect(formatted).toBeTruthy();
      expect(typeof formatted).toBe('string');
    });
  });

  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      const result = safeJsonParse('{"name":"test"}', {});
      expect(result).toEqual({ name: 'test' });
    });

    it('should return default on invalid JSON', () => {
      const result = safeJsonParse('invalid json', { default: true });
      expect(result).toEqual({ default: true });
    });

    it('should handle arrays', () => {
      const result = safeJsonParse('[1,2,3]', []);
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe('code block utilities', () => {
    it('should remove code blocks', () => {
      const text = 'Hello\n```js\ncode\n```\nWorld';
      const result = removeCodeBlocks(text);
      expect(result).not.toContain('```');
    });

    it('should find code blocks', () => {
      const text = '```javascript\nconst x = 1;\n```';
      const result = findCodeBlocks(text);
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].syntax).toBe('javascript');
      expect(result.blocks[0].code).toBe('const x = 1;');
    });

    it('should find multiple code blocks', () => {
      const text = '```js\ncode1\n```\ntext\n```py\ncode2\n```';
      const result = findCodeBlocks(text, false);
      expect(result.blocks).toHaveLength(2);
      expect(result.blocks[0].syntax).toBe('js');
      expect(result.blocks[1].syntax).toBe('py');
    });

    it('should handle single block mode', () => {
      const text = 'plain code without blocks';
      const result = findCodeBlocks(text);
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].code).toBe(text);
    });

    it('should detect code block errors', () => {
      const text = 'prefix ```js\ncode\n```';
      const result = findCodeBlocks(text);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('checkApiKey', () => {
    it('should return value if provided', () => {
      const result = checkApiKey('OpenAI', 'OPENAI_KEY', 'sk-123');
      expect(result).toBe('sk-123');
    });

    it('should throw if value is empty', () => {
      expect(() => checkApiKey('OpenAI', 'OPENAI_KEY', '')).toThrow();
    });
  });
});
