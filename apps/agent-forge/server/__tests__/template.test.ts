import { describe, expect, it } from 'vitest';

import { renderTemplate } from '../triggers/template';

describe('renderTemplate', () => {
  it('replaces {{a.b.c}} with nested scope values', () => {
    const scope = { event: { pull_request: { title: 'Fix bug', number: 42 } } };
    expect(renderTemplate('PR {{event.pull_request.title}} #{{event.pull_request.number}}', scope)).toBe(
      'PR Fix bug #42'
    );
  });

  it('renders strings directly and non-strings as JSON', () => {
    const scope = { event: { name: 'deploy', tags: ['a', 'b'], ok: true, none: null } };
    expect(renderTemplate('{{event.name}}|{{event.tags}}|{{event.ok}}|{{event.none}}', scope)).toBe(
      'deploy|["a","b"]|true|'
    );
  });

  it('renders unknown paths as empty strings', () => {
    expect(renderTemplate('[{{event.missing.deep}}]', { event: {} })).toBe('[]');
    expect(renderTemplate('{{nope}}', {})).toBe('');
  });

  it('treats {{{{ and }}}} as literal braces', () => {
    expect(renderTemplate('{{{{literal}}}} and {{event.x}}', { event: { x: '!' } })).toBe('{{literal}} and !');
  });

  it('leaves plain text untouched', () => {
    expect(renderTemplate('no placeholders { here', {})).toBe('no placeholders { here');
  });
});
