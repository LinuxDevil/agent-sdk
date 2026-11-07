/**
 * `KindRules` for `hook` nodes — every `spec.hooks` entry (`HookSpec`): a
 * `{ id, file }` reference to a code file inside the agent's folder, or an
 * `{ id, inline }` entry whose JS function-body `code` Studio's sandbox runs
 * at one of the four hook points. `validate` checks the file ref, the
 * inline name, code presence on an enabled hook and the id pattern;
 * `duplicateData` gives the copy the next free `h<n>` item id. The
 * `agent → hook` re-own uses the default attach effect, so there is no
 * `connectFrom` here.
 */
import type { KindRules } from '../kindRules';
import { nextItemId } from '../nodeIds';
import { arrayItemSpecPath } from '../order';
import { isSafeRelativePath, SPEC_ID_PATTERN } from '../specTypes';
import type { Graph, HookNodeData, Problem } from '../types';

/**
 * The `item.id` rule the Inspector and the validator share — the SDK's
 * `specIdSchema` pattern (`SPEC_ID_PATTERN`), re-exported through
 * `specTypes`, so the canvas flags exactly the ids a spec cannot carry.
 */
export const HOOK_ID_PATTERN = SPEC_ID_PATTERN;

/**
 * Every hook's `item.id` — the `taken` set for `nextItemId('h', …)` when the
 * palette entry or a duplicate names a new hook (hook ids are unique across
 * the whole graph, per the `duplicateItemIds` core check).
 */
export function allHookIds(graph: Graph): string[] {
  return graph.nodes
    .filter((n) => n.kind === 'hook')
    .map((n) => (n.data as HookNodeData).item.id);
}

/**
 * A hook `file` the canvas accepts: a relative path with forward slashes
 * that stays inside the agent's folder and names a `.ts` or `.js` file —
 * narrower than the spec schema's extension list on purpose, so the
 * Inspector only writes paths Studio can hand to the hook loader.
 */
export function hookFileOk(file: string): boolean {
  return isSafeRelativePath(file) && /\.(ts|js)$/.test(file);
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}

/**
 * `hook` kind rules: validation plus the duplicate's fresh `h<n>` id.
 * `CONNECTION_RULES.hook` is empty (a hook ends an edge), and `note`-style
 * non-spec kinds never reach a validator — notes are not in `orderedNodes`.
 */
export const hookRules: KindRules<'hook'> = {
  validate: (node, graph) => {
    const path = arrayItemSpecPath(graph, node, 'hooks');
    const { item } = node.data;
    const problems: Problem[] = [];
    if ('file' in item) {
      if (!hookFileOk(item.file)) {
        problems.push(
          error(node.id, 'Use a .ts or .js file inside the agent folder', `${path}.file`),
        );
      }
    } else {
      if (item.inline.name.trim() === '') {
        problems.push(error(node.id, 'The hook needs a name', `${path}.inline.name`));
      }
      if (item.inline.enabled !== false && item.inline.code.trim() === '') {
        problems.push(error(node.id, 'This hook is on but has no code', `${path}.inline.code`));
      }
    }
    if (!HOOK_ID_PATTERN.test(item.id)) {
      problems.push(
        error(node.id, 'The id can use letters, digits, dash or underscore', `${path}.id`),
      );
    }
    return problems;
  },
  duplicateData: (node, graph) => ({
    item: {
      ...structuredClone(node.data.item),
      id: nextItemId('h', allHookIds(graph)),
    },
  }),
};
