import type { HarnessLayer } from '../baseHarness';
import type { Harness } from '../harness';

export function layer(source: string, harness: Omit<Harness, 'schema'>, texts: Record<string, string> = {}): HarnessLayer {
  return { source, harness: { schema: 'lousho.harness/1', ...harness }, texts };
}

export const base = layer(
  'workspace base',
  {
    instructions: ['brand.md'],
    audience: { description: 'Customers of the brand.', traits: { tone: 'warm' } },
    constraints: [
      { id: 'no-competitors', text: 'Never name a competitor.' },
      { id: 'plain-language', text: 'Use plain language.' },
    ],
    evaluation: { criteria: [{ id: 'on-brand', description: 'The voice matches the brand.', rubric: 'Warm, never sarcastic.' }] },
    runtime: { limits: { maxTurns: 10, maxCostUsd: 1 } },
    context: { resources: ['shared/brand-palette.md'] },
  },
  { 'brand.md': 'Write as the brand: warm and direct.' }
);

export const instagram = layer(
  'workspace:platforms/instagram',
  {
    id: 'instagram',
    version: '1.0.0',
    instructions: ['voice.md', 'format.md'],
    audience: { description: 'Followers who skim on mobile.', traits: { tone: 'playful', persona: 'creator' } },
    platform: { id: 'instagram', requirements: { aspectRatio: '4:5', captionMaxChars: 2200, hashtags: { max: 30, banned: ['#ad'] } } },
    inputs: { schema: { type: 'object', properties: { brief: { type: 'string' } }, required: ['brief'] } },
    outputs: { schema: { type: 'object', properties: { caption: { type: 'string' } } }, artifacts: [{ name: 'image', mediaType: 'image/png', required: true }] },
    capabilities: { require: ['image.generate'] },
    constraints: [{ id: 'caption-length', text: 'Keep the caption under 2200 characters.' }],
    evaluation: { criteria: [{ id: 'caption-length', description: 'The caption fits Instagram.', check: 'checks/caption-length.ts', weight: 2 }], threshold: 0.7 },
    runtime: { limits: { maxDurationMs: 120000, maxTurns: 20 }, modelHints: { temperature: 0.9 } },
    context: { resources: ['resources/instagram-specs.md'] },
  },
  { 'voice.md': 'Sound like a person, not a brochure.', 'format.md': 'Lead with a hook in the first line.' }
);

export const educational = layer(
  'workspace:formats/educational',
  {
    id: 'educational',
    version: '1.0.0',
    instructions: ['teach.md'],
    audience: { description: 'Learners new to the topic.', traits: { level: 'beginner' } },
    platform: { id: 'instagram', requirements: { hashtags: { max: 10 } } },
    constraints: [{ id: 'one-idea', text: 'Teach one idea per post.' }],
    evaluation: { criteria: [{ id: 'teaches-one-idea', description: 'The post teaches exactly one idea.', rubric: 'One idea, explained simply.' }] },
    capabilities: { require: ['web.search', 'image.generate'] },
    runtime: { limits: { maxTurns: 12 }, modelHints: { temperature: 0.5, reasoning: 'medium' } },
    context: { resources: ['resources/glossary.md'] },
  },
  { 'teach.md': 'Explain one idea with one example.' }
);

export const general = layer(
  'global:audiences/general@1.2.0',
  {
    id: 'general',
    version: '1.2.0',
    instructions: ['general.md'],
    audience: { description: 'A general audience.' },
    constraints: [{ id: 'no-jargon', text: 'Avoid jargon.' }],
    runtime: { limits: { maxCostUsd: 0.5 } },
  },
  { 'general.md': 'Assume no prior knowledge.' }
);

export const page = layer(
  'page',
  {
    extends: ['workspace:platforms/instagram', 'workspace:formats/educational', 'global:audiences/general@1.2.0'],
    instructions: ['page.md'],
    platform: { id: 'instagram', requirements: { captionMaxChars: 1000 } },
    outputs: { schema: { merge: 'allOf', type: 'object', required: ['caption'] }, artifacts: [{ name: 'image', mediaType: 'image/jpeg', required: true }, { name: 'caption', mediaType: 'text/plain' }] },
    constraints: [{ id: 'cta', text: 'End with one call to action.' }],
    evaluation: { criteria: [{ id: 'has-cta', description: 'The post ends with a call to action.', check: 'checks/has-cta.ts' }] },
    runtime: { limits: { maxTurns: 15, maxDurationMs: 60000 } },
  },
  { 'page.md': 'Write the weekly tip post.' }
);

export const profiles = [instagram, educational, general];
