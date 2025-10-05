/**
 * SDK Configuration
 */
export interface SDKConfig {
  databaseIdHash: string;
  storageKey?: string;
  llm?: {
    provider: 'openai' | 'ollama' | string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  storage?: {
    provider: string;
    options?: Record<string, any>;
  };
  security?: {
    encryption?: boolean;
    encryptionKey?: string;
  };
}

/**
 * Configuration manager for SDK
 */
export class ConfigManager {
  private config: SDKConfig;

  constructor(config: SDKConfig) {
    this.validate(config);
    this.config = config;
  }

  /**
   * Get configuration
   */
  public getConfig(): SDKConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  public updateConfig(updates: Partial<SDKConfig>): void {
    this.config = { ...this.config, ...updates };
    this.validate(this.config);
  }

  /**
   * Get specific config value
   */
  public get<K extends keyof SDKConfig>(key: K): SDKConfig[K] {
    return this.config[key];
  }

  /**
   * Validate configuration
   */
  private validate(config: SDKConfig): void {
    if (!config.databaseIdHash) {
      throw new Error('databaseIdHash is required in SDK configuration');
    }
  }
}
