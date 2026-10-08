import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/index.js';

test('lower-cases and joins words with dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('drops punctuation and surrounding whitespace', () => {
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
});

test('keeps digits', () => {
  assert.equal(slugify('Top 10 tips'), 'top-10-tips');
});
