/**
 * The `KindView` for `memory` nodes — every `spec.memory` entry
 * (`MemorySpec`). The card's title is the slot name, its chip the provider
 * (`in-memory` / `file` / `vector`), and its rows the scope, the
 * last-message recall and what the model may do. `Fields` is the memory
 * Inspector (`memory/MemoryFields.tsx`); the palette offers a single
 * "Memory" entry under Capabilities that creates a session-scoped
 * in-memory slot with a fresh `notes`, `notes-2`, … name.
 */
import { Database } from 'lucide-react';
import { uniqueName } from '../../graph/v2/nodeIds';
import { memorySiblingNames } from '../../graph/v2/kinds/memory';
import type { MemorySpec } from '../../graph/v2/specTypes';
import type { NodeOfKind } from '../../graph/v2/types';
import { MemoryFields } from './memory/MemoryFields';
import type { KindView, NodeRow, PaletteEntry } from './index';

/** The chip text per provider type. */
function chip(provider: MemorySpec['provider']): string {
  return provider.type === 'sqlite-vector' ? 'vector' : provider.type;
}

/** The scope row text: `global`, `session` or `per <metadataKey>`. */
function scopeText(scope: MemorySpec['scope']): string {
  if (scope === 'global' || scope === 'session') return scope;
  return `per ${scope.metadataKey}`;
}

/** The recall row text when the slot recalls the last message: `last message` plus `· <maxItems>` when set. */
function recallText(recall: MemorySpec['recall']): string | undefined {
  if (recall?.query !== 'last-input') return undefined;
  return recall.maxItems === undefined ? 'last message' : `last message · ${recall.maxItems}`;
}

/**
 * The model row text: the `remember`/`recall`/`forget` tools the model gets
 * — `read` for `recall`, `write` for `remember` (both on by default),
 * `forget` only when a spec turns it on.
 */
function modelText(expose: MemorySpec['expose']): string {
  const tools = [
    (expose?.recall ?? true) ? 'read' : undefined,
    (expose?.remember ?? true) ? 'write' : undefined,
    expose?.forget === true ? 'forget' : undefined,
  ].filter((tool): tool is string => tool !== undefined);
  return tools.length === 0 ? 'none' : tools.join(', ');
}

/** The card rows: scope always, recall only when set to the last message, model always. */
function rows(node: NodeOfKind<'memory'>): NodeRow[] {
  const { item } = node.data;
  const result: NodeRow[] = [{ k: 'scope', v: scopeText(item.scope) }];
  const recall = recallText(item.recall);
  if (recall !== undefined) result.push({ k: 'recall', v: recall });
  result.push({ k: 'model', v: modelText(item.expose) });
  return result;
}

const PALETTE: PaletteEntry[] = [
  {
    id: 'memory',
    group: 'Capabilities',
    label: 'Memory',
    description: 'Remembers across turns',
    kind: 'memory',
    create: (graph, owner) => ({
      kind: 'memory',
      data: {
        item: {
          name: uniqueName('notes', memorySiblingNames(graph, owner)),
          scope: 'session',
          provider: { type: 'in-memory' },
        },
      },
    }),
  },
];

/** The `memory` kind's card + Inspector, registered in `KIND_VIEWS` (canvas/kinds/index.ts). */
export const MEMORY_VIEW: KindView<'memory'> = {
  label: 'Memory',
  tone: 'info',
  Icon: Database,
  title: (node) => node.data.item.name || '(unnamed)',
  chip: (node) => chip(node.data.item.provider),
  rows,
  ports: { in: true, out: false },
  Fields: MemoryFields,
  palette: PALETTE,
};
