import { MOCK_PROVIDER } from '../providers/mockMarker';

/**
 * A scripted model that does not look like a `mockModel()` to the SDK, so tests
 * can stand it in for a real network provider (cassette record/replay skips
 * mock providers, and the cost-limit warning is quiet for them).
 */
export function notMock<T extends object>(model: T): T {
  return new Proxy(model, {
    get(target, key) {
      if (key === MOCK_PROVIDER) return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
