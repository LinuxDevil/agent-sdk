import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { breakStorage, installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import { InspectorSection } from '../InspectorSection';

const toggle = (container: HTMLElement) => container.querySelector('button[aria-expanded]') as HTMLButtonElement;
const body = (container: HTMLElement) => container.querySelector('.inspector-section-body') as HTMLElement;

beforeEach(() => {
  installMemoryStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('InspectorSection', () => {
  it('starts open, and collapses and expands from its header button', () => {
    const container = render(<InspectorSection id="hooks" title="Hooks">content</InspectorSection>);
    expect(toggle(container).getAttribute('aria-expanded')).toBe('true');
    expect(toggle(container).getAttribute('aria-controls')).toBe(body(container).id);
    expect(body(container).hidden).toBe(false);
    act(() => toggle(container).click());
    expect(toggle(container).getAttribute('aria-expanded')).toBe('false');
    expect(body(container).hidden).toBe(true);
  });

  it('remembers each section under forge.inspector.<id>', () => {
    let container = render(<InspectorSection id="hooks" title="Hooks">content</InspectorSection>);
    act(() => toggle(container).click());
    expect(window.localStorage.getItem('forge.inspector.hooks')).toBe('closed');

    container = render(<InspectorSection id="hooks" title="Hooks">content</InspectorSection>);
    expect(toggle(container).getAttribute('aria-expanded')).toBe('false');
    // Another section keeps its own state.
    container = render(<InspectorSection id="node" title="Node">content</InspectorSection>);
    expect(toggle(container).getAttribute('aria-expanded')).toBe('true');
  });

  it('still toggles when storage throws', () => {
    breakStorage();
    const container = render(<InspectorSection id="hooks" title="Hooks">content</InspectorSection>);
    expect(toggle(container).getAttribute('aria-expanded')).toBe('true');
    act(() => toggle(container).click());
    expect(toggle(container).getAttribute('aria-expanded')).toBe('false');
  });
});
