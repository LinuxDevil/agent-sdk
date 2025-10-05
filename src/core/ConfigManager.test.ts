import { describe, it, expect } from 'vitest';
import { ConfigManager } from './ConfigManager';

describe('ConfigManager', () => {
  it('should create config manager with valid config', () => {
    const config = {
      databaseIdHash: 'test-db-hash'
    };

    const manager = new ConfigManager(config);
    expect(manager.getConfig()).toEqual(config);
  });

  it('should throw error when databaseIdHash is missing', () => {
    expect(() => {
      new ConfigManager({} as any);
    }).toThrow('databaseIdHash is required');
  });

  it('should get specific config value', () => {
    const config = {
      databaseIdHash: 'test-db-hash',
      storageKey: 'test-storage'
    };

    const manager = new ConfigManager(config);
    expect(manager.get('storageKey')).toBe('test-storage');
  });

  it('should update config', () => {
    const manager = new ConfigManager({
      databaseIdHash: 'test-db-hash'
    });

    manager.updateConfig({
      storageKey: 'new-storage'
    });

    expect(manager.get('storageKey')).toBe('new-storage');
  });

  it('should validate on update', () => {
    const manager = new ConfigManager({
      databaseIdHash: 'test-db-hash'
    });

    expect(() => {
      manager.updateConfig({
        databaseIdHash: ''
      });
    }).toThrow('databaseIdHash is required');
  });
});
