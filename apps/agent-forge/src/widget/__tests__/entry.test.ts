import { describe, expect, it } from 'vitest';

import { FORGE_CHAT_TAG } from '../forgeChat';
import '../entry';

describe('widget bundle entry (X04b)', () => {
  it('defines the forge-chat custom element on import', () => {
    expect(customElements.get(FORGE_CHAT_TAG)).toBeDefined();
  });
});
