import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newCassette } from './cassette';

const thisDir = path.dirname(fileURLToPath(import.meta.url));

describe('cassette header', () => {
  it('stamps new cassettes with the SDK version read from package.json (LOU-R10)', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(thisDir, '..', '..', 'package.json'), 'utf8')
    ) as { version: string };

    const cassette = newCassette({ name: 'mock' });

    expect(cassette.sdkVersion).toBe(manifest.version);
  });
});
