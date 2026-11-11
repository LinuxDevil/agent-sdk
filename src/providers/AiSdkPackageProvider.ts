import type { LanguageModel } from 'ai';
import { ConfigurationError } from '../execution/errors';
import { AiSdkProvider, type AiSdkProviderConfig } from './aiSdkProvider';
import { aiMajorOf } from './aiSdkCompat';
import { lazyValue, loadOptionalPeer } from './optionalPeer';

export interface AiSdkPackageProviderConfig extends AiSdkProviderConfig {
  name: string;
  packageName: string;
}

type ProviderInstance = ((modelId: string) => LanguageModel) & { languageModel?: (modelId: string) => LanguageModel };

export class AiSdkPackageProvider extends AiSdkProvider<AiSdkPackageProviderConfig> {
  readonly name: string;
  protected readonly fallbackModel = '';

  constructor(config: AiSdkPackageProviderConfig) {
    super(config);
    this.name = config.name;
  }

  private readonly loadProvider = lazyValue(async () => {
    const packageName = this.config.packageName;
    const exports = (await loadOptionalPeer(packageName, () => import(packageName), aiMajorOf(this.ai))) as Record<string, unknown>;
    const creators = Object.keys(exports).filter((key) => /^create[A-Z]/.test(key) && typeof exports[key] === 'function');
    const wanted = `create${packageName.slice(packageName.lastIndexOf('/') + 1).replace(/-/g, '')}`.toLowerCase();
    const creator = creators.find((key) => key.toLowerCase() === wanted) ?? (creators.length === 1 ? creators[0] : undefined);
    if (!creator) {
      throw new ConfigurationError(
        `'${packageName}' has no single create<Provider>() export to build '${this.name}' models with ` +
          `(found: ${creators.join(', ') || 'none'}). Build the model yourself and pass createAgent({ provider: fromAiSdk(model) }).`,
        'model',
        'LOUSHO_PROVIDER_UNKNOWN'
      );
    }
    return (exports[creator] as (options: unknown) => ProviderInstance)(this.clientOptions());
  });

  protected async createModel(modelId: string): Promise<LanguageModel> {
    const provider = await this.loadProvider();
    return typeof provider.languageModel === 'function' ? provider.languageModel(modelId) : provider(modelId);
  }

  supportsTools(_model: string): boolean {
    return true;
  }

  supportsStreaming(_model: string): boolean {
    return true;
  }

  async getModels(): Promise<string[]> {
    return this.config.defaultModel ? [this.config.defaultModel] : [];
  }
}
