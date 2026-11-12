import { isRecord } from './schema';

export function getAt(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (isRecord(node) && Object.hasOwn(node, key) ? node[key] : undefined), root);
}

export function setAt(root: Record<string, unknown>, segments: readonly string[], value: unknown): Record<string, unknown> {
  if (segments.length === 0) return isRecord(value) ? value : {};
  const [head, ...rest] = segments;
  const child = isRecord(root[head]) ? root[head] : {};
  return { ...root, [head]: rest.length === 0 ? value : setAt(child, rest, value) };
}

export function inputSegments(bind: string): string[] {
  return bind.split('.').slice(1);
}
