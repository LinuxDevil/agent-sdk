import { describe, it, expect } from 'vitest';
import { getObjectByPath, setRecursiveNames } from './json-path';

describe('json-path utilities', () => {
  describe('getObjectByPath', () => {
    it('should get value by simple path', () => {
      const obj = { user: { name: 'Alice' } };
      expect(getObjectByPath(obj, '$.user.name')).toBe('Alice');
    });

    it('should get value by array index path', () => {
      const obj = { items: ['a', 'b', 'c'] };
      expect(getObjectByPath(obj, '$.items[1]')).toBe('b');
    });

    it('should return undefined for invalid path', () => {
      const obj = { user: { name: 'Alice' } };
      expect(getObjectByPath(obj, '$.user.age')).toBeUndefined();
    });

    it('should throw error for invalid path format', () => {
      const obj = { user: { name: 'Alice' } };
      expect(() => getObjectByPath(obj, 'user.name')).toThrow('Invalid path');
    });

    it('should handle nested arrays and objects', () => {
      const obj = { users: [{ name: 'Alice' }, { name: 'Bob' }] };
      expect(getObjectByPath(obj, '$.users[0].name')).toBe('Alice');
    });
  });

  describe('setRecursiveNames', () => {
    it('should set names for agent nodes', () => {
      const obj = {
        agent: 'root',
        input: {
          agent: 'child',
        },
      };

      setRecursiveNames(obj);

      expect(obj.name).toBe('root');
      expect((obj.input as any).name).toBe('root > child');
    });

    it('should generate IDs for nodes without ID', () => {
      const obj = { agent: 'test' };
      setRecursiveNames(obj);
      expect(obj.id).toBeDefined();
      expect(typeof obj.id).toBe('string');
    });

    it('should handle array inputs', () => {
      const obj = {
        agent: 'parent',
        input: [
          { agent: 'child1' },
          { agent: 'child2' },
        ],
      };

      setRecursiveNames(obj);

      expect((obj.input[0] as any).name).toBe('parent > child1');
      expect((obj.input[1] as any).name).toBe('parent > child2');
    });

    it('should handle item arrays', () => {
      const obj = {
        agent: 'parent',
        item: [
          { agent: 'item1' },
          { agent: 'item2' },
        ],
      };

      setRecursiveNames(obj);

      expect((obj.item[0] as any).name).toBe('parent > item1');
      expect((obj.item[1] as any).name).toBe('parent > item2');
    });
  });
});
