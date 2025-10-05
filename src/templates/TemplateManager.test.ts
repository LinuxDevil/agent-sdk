import { describe, it, expect } from 'vitest';
import { renderTemplate, TemplateManager } from './TemplateManager';

describe('Templates - TemplateManager', () => {
  describe('renderTemplate', () => {
    it('should render simple variables', () => {
      const template = 'Hello {{ name }}!';
      const context = { name: 'World' };
      const result = renderTemplate(template, context);
      expect(result).toBe('Hello World!');
    });

    it('should render nested variables', () => {
      const template = 'Hello {{ user.name }}!';
      const context = { user: { name: 'Alice' } };
      const result = renderTemplate(template, context);
      expect(result).toBe('Hello Alice!');
    });

    it('should handle missing variables', () => {
      const template = 'Hello {{ name }}!';
      const context = {};
      const result = renderTemplate(template, context);
      expect(result).toBe('Hello !');
    });

    it('should apply escape filter', () => {
      const template = '{{ html|escape }}';
      const context = { html: '<script>alert("xss")</script>' };
      const result = renderTemplate(template, context);
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('should apply short escape filter (e)', () => {
      const template = '{{ html|e }}';
      const context = { html: '<div>test</div>' };
      const result = renderTemplate(template, context);
      expect(result).toContain('&lt;div&gt;');
    });

    it('should apply custom filters', () => {
      const template = '{{ name|uppercase }}';
      const context = { name: 'hello' };
      const filters = {
        uppercase: (val: any) => String(val).toUpperCase(),
      };
      const result = renderTemplate(template, context, filters);
      expect(result).toBe('HELLO');
    });
  });

  describe('if blocks', () => {
    it('should render if block when condition is true', () => {
      const template = '{% if user %}Hello {{ user }}{% endif %}';
      const context = { user: 'Alice' };
      const result = renderTemplate(template, context);
      expect(result).toBe('Hello Alice');
    });

    it('should not render if block when condition is false', () => {
      const template = '{% if user %}Hello {{ user }}{% endif %}';
      const context = { user: '' };
      const result = renderTemplate(template, context);
      expect(result).toBe('');
    });

    it('should handle if-else blocks', () => {
      const template = '{% if user %}Hello {{ user }}{% else %}Hello Guest{% endif %}';
      const context = { user: '' };
      const result = renderTemplate(template, context);
      expect(result).toBe('Hello Guest');
    });

    it('should handle nested if blocks', () => {
      const template =
        '{% if user %}{% if user.admin %}Admin: {{ user.name }}{% else %}User: {{ user.name }}{% endif %}{% endif %}';
      const context = { user: { name: 'Bob', admin: true } };
      const result = renderTemplate(template, context);
      expect(result).toBe('Admin: Bob');
    });

    it('should handle if with nested object check', () => {
      const template = '{% if user.role %}Role: {{ user.role }}{% endif %}';
      const context = { user: { role: 'admin' } };
      const result = renderTemplate(template, context);
      expect(result).toBe('Role: admin');
    });
  });

  describe('for blocks', () => {
    it('should render for loop with array', () => {
      const template = '{% for item in items %}{{ item }}, {% endfor %}';
      const context = { items: ['a', 'b', 'c'] };
      const result = renderTemplate(template, context);
      expect(result).toBe('a, b, c, ');
    });

    it('should render for loop with object properties', () => {
      const template = '{% for user in users %}{{ user.name }}, {% endfor %}';
      const context = {
        users: [
          { name: 'Alice' },
          { name: 'Bob' },
          { name: 'Charlie' },
        ],
      };
      const result = renderTemplate(template, context);
      expect(result).toBe('Alice, Bob, Charlie, ');
    });

    it('should handle empty array with else block', () => {
      const template = '{% for item in items %}{{ item }}{% else %}No items{% endfor %}';
      const context = { items: [] };
      const result = renderTemplate(template, context);
      expect(result).toBe('No items');
    });

    it('should handle for loop with object values', () => {
      const template = '{% for item in items %}{{ item }}, {% endfor %}';
      const context = { items: { a: '1', b: '2', c: '3' } };
      const result = renderTemplate(template, context);
      expect(result).toContain('1');
      expect(result).toContain('2');
      expect(result).toContain('3');
    });

    it('should handle for loops with filters', () => {
      const template = '{% for item in items %}{{ item|escape }}, {% endfor %}';
      const context = { items: ['<a>', '<b>', '<c>'] };
      const result = renderTemplate(template, context);
      expect(result).toContain('&lt;a&gt;');
      expect(result).toContain('&lt;b&gt;');
      expect(result).toContain('&lt;c&gt;');
    });
  });

  describe('complex templates', () => {
    it('should handle mixed conditionals and loops', () => {
      const template = `
{% if users %}
Users:
{% for user in users %}
- {{ user.name }}
{% endfor %}
{% else %}
No users found
{% endif %}
      `.trim();

      const context = {
        users: [
          { name: 'Alice' },
          { name: 'Bob' },
        ],
      };

      const result = renderTemplate(template, context);
      expect(result).toContain('Users:');
      expect(result).toContain('- Alice');
      expect(result).toContain('- Bob');
      expect(result).not.toContain('No users found');
    });

    it('should handle multiple variable replacements', () => {
      const template = 'Name: {{ name }}, Age: {{ age }}, City: {{ city }}';
      const context = { name: 'John', age: 30, city: 'New York' };
      const result = renderTemplate(template, context);
      expect(result).toBe('Name: John, Age: 30, City: New York');
    });

    it('should handle whitespace in template syntax', () => {
      const template = '{{  name  }}';
      const context = { name: 'Test' };
      const result = renderTemplate(template, context);
      expect(result).toBe('Test');
    });
  });

  describe('TemplateManager class', () => {
    it('should work with class instance', () => {
      const manager = new TemplateManager();
      const result = manager.render('Hello {{ name }}', { name: 'World' });
      expect(result).toBe('Hello World');
    });

    it('should accept custom filters via options', () => {
      const manager = new TemplateManager();
      const result = manager.render(
        '{{ text|reverse }}',
        { text: 'hello' },
        {
          customFilters: {
            reverse: (val: any) => String(val).split('').reverse().join(''),
          },
        }
      );
      expect(result).toBe('olleh');
    });
  });

  describe('edge cases', () => {
    it('should handle undefined context', () => {
      const template = '{{ name }}';
      const result = renderTemplate(template, {});
      expect(result).toBe('');
    });

    it('should handle null values', () => {
      const template = '{{ value }}';
      const context = { value: null };
      const result = renderTemplate(template, context);
      expect(result).toBe('');
    });

    it('should handle numeric values', () => {
      const template = 'Count: {{ count }}';
      const context = { count: 42 };
      const result = renderTemplate(template, context);
      expect(result).toBe('Count: 42');
    });

    it('should handle boolean values', () => {
      const template = 'Active: {{ active }}';
      const context = { active: true };
      const result = renderTemplate(template, context);
      expect(result).toBe('Active: true');
    });

    it('should handle special characters in text', () => {
      const template = 'Special: {{ text }}';
      const context = { text: '!@#$%^&*()' };
      const result = renderTemplate(template, context);
      expect(result).toBe('Special: !@#$%^&*()');
    });
  });
});
