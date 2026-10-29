import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Text tokens must meet WCAG AA (4.5:1) against the surfaces
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
  // The running status pill draws info on the neutral pill tint.
  ['info', 'surface-2'],
  // Primary buttons (Save) draw white text on the filled accent.
  ['on-accent', 'accent-solid'],
  // DataTable: header sort arrow and hovered/focused row text on the header/row tint.
  ['accent', 'surface-2'],
  ['text', 'surface-2'],
  // Monitoring: the selected window button draws text on the accent tint.
  ['text', 'accent-soft'],
  // Prompt label chips, the selected DataTable row and the Traces prompt chip (its x in text-muted) on the accent tint.
  ['text-muted', 'accent-soft'],
  // Prompt version links (runs, Playground) draw --accent on the version card's --surface. The diff's removed/added
  // lines reuse danger/danger-soft and success/success-soft, and its line numbers text-faint/surface (all listed above).
  ['accent', 'surface'],
  // Running status pills draw info on its own tint; violet (LLM/agent) pills likewise.
  ['info', 'info-soft'],
  ['violet', 'violet-soft'],
  // Pressed / selected neutrals and code blocks sit on --surface-3.
  ['text-muted', 'surface-3'],
  ['text', 'surface-3'],
  // A hovered or pressed primary button keeps white text on its deeper fill.
  ['on-accent', 'accent-solid-hover'],
  // A switched-on chip (Requires approval) draws --accent on the accent tint.
  ['accent', 'accent-soft'],
  // MetricCard: a good delta draws --success on the card's --surface (a bad one --danger, listed above).
  ['success', 'surface'],
  // JsonView on its --surface-3 code block: strings info, numbers violet, booleans accent, null/summaries text-faint
  // (keys text-muted, listed above). MessageView's assistant avatar draws violet on violet-soft (listed above).
  ['info', 'surface-3'],
  ['violet', 'surface-3'],
  ['accent', 'surface-3'],
  ['text-faint', 'surface-3'],
  // The nav rail and the shell frame sit on --nav-bg (U02): nav labels, section overlines, the active icon.
  ['text', 'nav-bg'],
  ['text-muted', 'nav-bg'],
  ['text-faint', 'nav-bg'],
  ['accent', 'nav-bg'],
  // Tinted toasts (U12) draw the message in --text and the close button in --text-muted on each -soft tint.
  ['text', 'success-soft'],
  ['text', 'danger-soft'],
  ['text', 'warning-soft'],
  ['text', 'info-soft'],
  ['text-muted', 'success-soft'],
  ['text-muted', 'danger-soft'],
  ['text-muted', 'warning-soft'],
  ['text-muted', 'info-soft'],
];

describe('theme contrast', () => {
  for (const scheme of ['light', 'dark'] as const) {
    for (const [text, background] of PAIRS) {
      it(`--${text} on --${background} is >= 4.5:1 (${scheme})`, () => {
        expect(contrast(token(text)[scheme], token(background)[scheme])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
