import { describe, it, expect } from 'vitest';
import { mergeWranglerToml, type OwnedTomlKey } from './wranglerToml';

const owned = (crons: string | undefined): OwnedTomlKey[] => [
  { key: 'name', value: '"bot"' },
  { key: 'main', value: '"dist/worker.js"' },
  { key: 'compatibility_date', value: '"2026-09-01"', keepExisting: true },
  { key: 'no_bundle', value: 'true' },
  { table: 'triggers', key: 'crons', value: crons },
];

describe('mergeWranglerToml', () => {
  it('updates the owned keys and keeps everything else, comments and a hand-set date included', () => {
    const existing = [
      '# my notes',
      'name = "old"',
      'main = "dist/worker.js"',
      'compatibility_date = "2026-10-01"',
      'workers_dev = false # keep me',
      '',
      '[vars]',
      'LOUSHO_ALLOW_OPEN_TRANSCRIPTS = "1"',
      'FOO = "a [bracket] # not a comment"',
      '',
      '[[kv_namespaces]]',
      'binding = "AGENT_CHECKPOINTS"',
      'id = "abc"',
      '',
    ].join('\n');
    expect(mergeWranglerToml(existing, owned('["0 * * * *"]'))).toBe(
      [
        '# my notes',
        'name = "bot"',
        'main = "dist/worker.js"',
        'compatibility_date = "2026-10-01"',
        'workers_dev = false # keep me',
        'no_bundle = true',
        '',
        '[vars]',
        'LOUSHO_ALLOW_OPEN_TRANSCRIPTS = "1"',
        'FOO = "a [bracket] # not a comment"',
        '',
        '[[kv_namespaces]]',
        'binding = "AGENT_CHECKPOINTS"',
        'id = "abc"',
        '',
        '[triggers]',
        'crons = ["0 * * * *"]',
      ].join('\n')
    );
  });

  it('replaces a multi-line crons array and drops [triggers] once it has no crons', () => {
    const existing = ['name = "bot"', '', '[triggers]', 'crons = [', '  "0 * * * *",', '  "5 * * * *",', ']', '', '[vars]', 'A = "1"'].join('\n');
    expect(mergeWranglerToml(existing, owned('["1 * * * *"]'))).toBe(
      ['name = "bot"', 'main = "dist/worker.js"', 'compatibility_date = "2026-09-01"', 'no_bundle = true', '', '[triggers]', 'crons = ["1 * * * *"]', '', '[vars]', 'A = "1"'].join('\n')
    );
    expect(mergeWranglerToml(existing, owned(undefined))).toBe(
      ['name = "bot"', 'main = "dist/worker.js"', 'compatibility_date = "2026-09-01"', 'no_bundle = true', '', '', '[vars]', 'A = "1"'].join('\n')
    );
  });

  it('keeps a [triggers] table that still has other keys', () => {
    const existing = ['name = "bot"', '[triggers]', 'crons = ["0 * * * *"]', 'other = 1'].join('\n');
    expect(mergeWranglerToml(existing, [{ table: 'triggers', key: 'crons', value: undefined }])).toBe(['name = "bot"', '[triggers]', 'other = 1'].join('\n'));
  });
});
