import { describe, expect, it } from 'vitest';
import { exposureWarning } from './dev';

describe('lousho dev --host warning', () => {
  it.each(['127.0.0.1', 'localhost', '::1'])('says nothing for the loopback host %s', (host) => {
    expect(exposureWarning(host, 3737)).toBeUndefined();
  });

  it.each(['0.0.0.0', '::', '192.168.1.20'])('warns that %s exposes an unauthenticated agent', (host) => {
    expect(exposureWarning(host, 3737)).toMatch(new RegExp(`no authentication.*anyone who can reach ${host.replace(/\./g, '\\.')}:3737`));
  });
});
