/**
 * `KindRules` for `skill` nodes — every `spec.skills` entry (`SkillRef`).
 * `validate` checks the source's required fields (a folder path inside the
 * agent folder, a registry skill name, an inline name/description/content)
 * and flags two skills of one owner that resolve to the same
 * `skillNodeName`. No `connectFrom`: an incoming `agent → skill` edge takes
 * the default re-own effect. `duplicateData` gives an inline copy a fresh
 * `<name>-copy` name; a dir or registry copy keeps its name, so the
 * duplicate-name error shows on both, as intended.
 */
import { skillNodeName, uniqueName } from '../nodeIds';
import { arrayItemSpecPath, sectionChildren } from '../order';
import type { KindRules } from '../kindRules';
import type { Graph, NodeOfKind, Problem, SkillNodeData } from '../types';

/**
 * The inline `name` rule the Inspector and the validator share — the SDK's
 * `SKILL_NAME_PATTERN` (`^[a-z0-9][a-z0-9-_]{0,63}$`), so the canvas flags
 * exactly the names a spec cannot carry.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/** The duplicate-name error message, shared by `validate` and its test. */
const DUPLICATE_ERROR = (name: string): string => `Two skills are named '${name}'`;

/** Trim-empty is empty: `undefined`, non-strings and whitespace-only values all count as missing. */
function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * The `{ dir }` rule the Inspector and the validator share: a non-blank
 * relative forward-slash path that stays inside the agent folder — no
 * leading slash, no drive letter, no backslash, no `..` segment.
 */
export function skillDirOk(dir: string): boolean {
  if (dir.trim() === '' || dir.startsWith('/') || /^[A-Za-z]:/.test(dir) || dir.includes('\\')) {
    return false;
  }
  return !dir.split('/').includes('..');
}

/**
 * The `skillNodeName`s of the skills already owned by `ownerId` — the
 * `taken` set for `uniqueName` when the palette entry or a duplicate names
 * a new skill (mirrors `mcpSiblingKeys`/`subagentSiblingKeys` in `order.ts`,
 * but skills derive their name from the item rather than a record key).
 */
export function skillSiblingNames(graph: Graph, ownerId: string | null): string[] {
  return graph.nodes
    .filter((n) => n.owner === ownerId && n.kind === 'skill' && n.proposed !== 'remove')
    .map((n) => skillNodeName((n.data as SkillNodeData).item));
}

/** The source form's required-field errors, in the ticket's order. */
function formProblems(node: NodeOfKind<'skill'>, path: string): Problem[] {
  const { item } = node.data;
  const fail = (field: string, message: string): Problem => ({
    nodeId: node.id,
    severity: 'error',
    message,
    fieldPath: `${path}.${field}`,
  });
  if ('dir' in item) {
    return skillDirOk(item.dir) ? [] : [fail('dir', 'Use a folder inside the agent folder')];
  }
  if ('registry' in item) {
    return blank(item.registry) ? [fail('registry', 'Pick a registry skill')] : [];
  }
  const problems: Problem[] = [];
  if (!SKILL_NAME_PATTERN.test(item.inline.name)) {
    problems.push(
      fail('inline.name', 'The skill name can use lower-case letters, digits, dash or underscore'),
    );
  }
  if (blank(item.inline.description)) problems.push(fail('inline.description', 'The skill needs a description'));
  if (blank(item.inline.content)) problems.push(fail('inline.content', 'The skill needs content'));
  return problems;
}

/**
 * `Two skills are named '<name>'` on every skill of the owner that shares
 * this node's `skillNodeName` — the runtime throws on duplicate skill
 * names, and two refs resolving to the same name (a dir basename and an
 * inline name, say) collide just the same.
 */
function duplicateProblems(node: NodeOfKind<'skill'>, graph: Graph, path: string): Problem[] {
  const name = skillNodeName(node.data.item);
  const twins = sectionChildren(graph, node.owner ?? '', 'skills').filter(
    (sibling) =>
      sibling.kind === 'skill' && skillNodeName((sibling.data as SkillNodeData).item) === name,
  );
  return twins.length < 2
    ? []
    : [{ nodeId: node.id, severity: 'error', message: DUPLICATE_ERROR(name), fieldPath: path }];
}

/**
 * `skill` kind rules: validation plus the duplicate naming rule — the
 * connect effect is the default re-own attach.
 */
export const skillRules: KindRules<'skill'> = {
  validate: (node, graph) => {
    const path = arrayItemSpecPath(graph, node, 'skills');
    return [...formProblems(node, path), ...duplicateProblems(node, graph, path)];
  },
  duplicateData: (node, graph) => {
    const item = structuredClone(node.data.item);
    if ('inline' in item) {
      item.inline = {
        ...item.inline,
        name: uniqueName(`${item.inline.name}-copy`, skillSiblingNames(graph, node.owner)),
      };
    }
    return { item };
  },
};
