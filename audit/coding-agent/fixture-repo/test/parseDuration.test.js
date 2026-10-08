import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/index.js';

test('milliseconds and seconds', () => {
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('3s'), 3000);
});

test('minutes and hours', () => {
  assert.equal(parseDuration('2m'), 120000);
  assert.equal(parseDuration('1h'), 3600000);
});

test('fractional values', () => {
  assert.equal(parseDuration('1.5s'), 1500);
  assert.equal(parseDuration('0.5h'), 1800000);
});

test('rejects garbage', () => {
  assert.throws(() => parseDuration('soon'), /Invalid duration/);
});
