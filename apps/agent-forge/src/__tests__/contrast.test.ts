import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Eve DUI-F9: text tokens must meet WCAG AA (4.5:1) against the surfaces
 * they are drawn on, in both the light and the dark scheme. Reads the real
 * `light-dark(<light>, <dark>)` pairs out of theme.css.
 */
const css = readFileSync(resolve(__dirname, '../theme.css'), 'utf8');

function token(name: string): { light: string; dark: string } {
  const match = new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, 'i').exec(css);
  if (!match) throw new Error(`token --${name} not found in theme.css`);
  return { light: match[1], dark: match[2] };
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const PAIRS: [text: string, background: string][] = [
  ['text-muted', 'surface'],
  ['text-muted', 'surface-2'],
  ['text-muted', 'bg'],
  ['text-faint', 'surface'],
  ['text-faint', 'surface-2'],
  ['text-faint', 'bg'],
  // Status pills and the Run/Stop buttons draw the status colour on its soft tint.
  ['success', 'success-soft'],
  ['danger', 'danger-soft'],
  ['warning', 'warning-soft'],
  ['danger', 'surface'],
  ['info', 'surface'],
];

describe('theme contrast (Eve DUI-F9)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    for (const [text, background] of PAIRS) {
      it(`--${text} on --${background} is >= 4.5:1 (${scheme})`, () => {
        expect(contrast(token(text)[scheme], token(background)[scheme])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
