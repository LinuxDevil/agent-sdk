import { z } from 'zod';
import { ExpressionError, safeExpressionVariables } from '../../flows/safeExpression';
import { checkForbiddenKeys, FORBIDDEN_HARNESS_KEYS, type ForbiddenKeyError, type ForbiddenKeyRule } from './forbiddenKeys';
import type { Harness } from './harness';

/** The closed component catalog by palette group; a page UI may use no other component (R15). */
export const UI_COMPONENTS = {
  /** Containers that arrange other components. */
  layout: ['stack', 'row', 'tabs', 'section', 'card'],
  /** Fields bound to the harness's `inputs.schema` with `bind`. */
  inputs: ['text', 'textarea', 'number', 'select', 'radio', 'toggle', 'slider', 'file', 'schemaForm'],
  /** Controls that start, cancel or revise a run. */
  actions: ['runButton', 'cancelButton', 'reviseBox'],
  /** Views of the run's `outputs.schema` fields (`source`) and artifacts (`artifact`). */
  outputs: ['text', 'markdown', 'json', 'table', 'artifact', 'artifactGallery'],
  /** The run's status, progress and trace. */
  status: ['runStatus', 'progress', 'traceLink'],
  /** The page's revisions. */
  revisions: ['versionList', 'compare'],
} as const;

/** Every component type in {@link UI_COMPONENTS}. */
export type UiComponentType = (typeof UI_COMPONENTS)[keyof typeof UI_COMPONENTS][number];

/** Props every catalog component accepts. */
export interface UiComponentBase {
  /** Shows the component only while this safe expression over `inputs`, `outputs` and `status` is true. */
  visibleWhen?: string;
  /** Plain-text label or heading; never markup or a URL. */
  label?: string;
}

/** A layout container: a vertical stack, a row, a titled section or a card. */
export interface UiContainer extends UiComponentBase {
  /** The container kind. */
  type: 'stack' | 'row' | 'section' | 'card';
  /** The components inside, in order. */
  children: UiComponent[];
}

/** One tab of a `tabs` component. */
export interface UiTab {
  /** The tab's plain-text title. */
  label: string;
  /** The components on the tab, in order. */
  children: UiComponent[];
}

/** A set of tabs. */
export interface UiTabs extends UiComponentBase {
  /** Always `tabs`. */
  type: 'tabs';
  /** The tabs, in order. */
  tabs: UiTab[];
}

/** Plain text: an input when it has `bind`, an output when it has `source`; exactly one is set. */
export interface UiText extends UiComponentBase {
  /** Always `text`. */
  type: 'text';
  /** The input field it edits, as `inputs.<path>`. */
  bind?: string;
  /** The output field it shows, as `outputs` or `outputs.<path>`. */
  source?: string;
  /** Plain-text hint shown while the input is empty. */
  placeholder?: string;
}

/** A long-text box, a boolean toggle, or a form over a whole object of the input schema. */
export interface UiInputField extends UiComponentBase {
  /** The input kind. */
  type: 'textarea' | 'toggle' | 'schemaForm';
  /** The input field it edits, as `inputs` or `inputs.<path>`. */
  bind: string;
  /** Plain-text hint shown while the input is empty. */
  placeholder?: string;
}

/** A number box or a slider. */
export interface UiNumberField extends UiComponentBase {
  /** The input kind. */
  type: 'number' | 'slider';
  /** The input field it edits, as `inputs.<path>`. */
  bind: string;
  /** Lowest value offered; the schema's `minimum` still applies. */
  min?: number;
  /** Highest value offered; the schema's `maximum` still applies. */
  max?: number;
  /** Step between values. */
  step?: number;
}

/** One choice of a `select` or `radio`. */
export interface UiOption {
  /** The value; must be in the bound field's `enum`. */
  value: string | number | boolean;
  /** Plain-text label; the value is shown when absent. */
  label?: string;
}

/** A choice from the bound field's `enum`, as a dropdown or radio buttons. */
export interface UiChoiceField extends UiComponentBase {
  /** The input kind. */
  type: 'select' | 'radio';
  /** The input field it edits, as `inputs.<path>`. */
  bind: string;
  /** The choices offered, a subset of the schema's `enum`; the whole enum when absent. */
  options?: UiOption[];
}

/** A file upload, stored in the artifact store and passed as an `ArtifactRef`, never a path. */
export interface UiFileField extends UiComponentBase {
  /** Always `file`. */
  type: 'file';
  /** The input field that receives the `ArtifactRef`, as `inputs.<path>`. */
  bind: string;
  /** Media types accepted, such as `image/png` or `image/*`. */
  accept?: string[];
}

/** An output field rendered as sanitised Markdown with links shown as text, as JSON, or as a table. */
export interface UiOutputField extends UiComponentBase {
  /** The output kind. */
  type: 'markdown' | 'json' | 'table';
  /** The output field it shows, as `outputs` or `outputs.<path>`. */
  source: string;
}

/** A preview of one artifact the run produced, read from the artifact store. */
export interface UiArtifactView extends UiComponentBase {
  /** Always `artifact`. */
  type: 'artifact';
  /** The artifact's name, declared in the harness's `outputs.artifacts`. */
  artifact: string;
}

/** A component bound to the run itself rather than to a field: run controls, status, trace, revisions and the artifact gallery. */
export interface UiRunWidget extends UiComponentBase {
  /** The widget kind. */
  type: 'runButton' | 'cancelButton' | 'reviseBox' | 'artifactGallery' | 'runStatus' | 'progress' | 'traceLink' | 'versionList' | 'compare';
}

/** One component of the closed catalog, discriminated by `type`. */
export type UiComponent = UiContainer | UiTabs | UiText | UiInputField | UiNumberField | UiChoiceField | UiFileField | UiOutputField | UiArtifactView | UiRunWidget;

/** A `page.ui.json` document (`lousho.ui/1`): a page's declarative UI, built only from the catalog (R15). */
export interface PageUi {
  /** Schema id; always `lousho.ui/1`. */
  schema: 'lousho.ui/1';
  /** Plain-text page title. */
  title?: string;
  /** The root component. */
  layout: UiComponent;
}

/** Stable codes of UI binding problems: UI001 missing input, UI002 input type, UI003 option outside enum, UI004 missing output, UI005 output type, UI006 undeclared artifact, UI007 unbound required input, UI008 unresolved schema path. */
export type UiProblemCode = 'UI001' | 'UI002' | 'UI003' | 'UI004' | 'UI005' | 'UI006' | 'UI007' | 'UI008';

/** One UI binding error. */
export interface UiProblem {
  /** Stable code. */
  code: UiProblemCode;
  /** Path inside the UI document. */
  path: (string | number)[];
  /** What is wrong, naming the binding. */
  message: string;
}

/** The parts of an effective harness that UI bindings point at, with schemas already resolved to objects. */
export type UiBindingTarget = Pick<Harness, 'inputs' | 'outputs'>;

const MARKUP = /<[A-Za-z!/?]/;
const URL_LIKE = /[A-Za-z][\w+.-]*:\/\/|(?:^|\s)\/\/\S|(?:java|vb)script\s*:|data:[\w.+-]+\/[\w.+-]+/i;
const PROTOTYPE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const SEGMENT = '[A-Za-z_][\\w-]*';
const INPUT_PATH = new RegExp(`^inputs(?:\\.${SEGMENT})*$`);
const OUTPUT_PATH = new RegExp(`^outputs(?:\\.${SEGMENT})*$`);
const ARTIFACT_NAME = /^[A-Za-z0-9][\w.-]*$/;
const MEDIA_TYPE = /^[a-z]+\/(?:\*|[a-z0-9][\w.+-]*)$/i;
const VISIBLE_WHEN_SCOPE = new Set(['inputs', 'outputs', 'status']);

const uiText = z
  .string()
  .min(1, 'must not be empty')
  .max(500)
  .refine((text) => !MARKUP.test(text), 'must be plain text: no HTML or markup (R15)')
  .refine((text) => !URL_LIKE.test(text), 'must not contain a URL; artifacts come only from the artifact store (R15)');

function fieldPath(pattern: RegExp, root: string): z.ZodType<string> {
  return z
    .string()
    .regex(pattern, `must be ${root} or ${root}.<field>.<field>…`)
    .refine((path) => !path.split('.').some((segment) => PROTOTYPE_SEGMENTS.has(segment)), 'must not name __proto__, constructor or prototype');
}

const bindPath = fieldPath(INPUT_PATH, 'inputs');
const sourcePath = fieldPath(OUTPUT_PATH, 'outputs');

function checkVisibleWhen(expression: string, ctx: z.RefinementCtx): void {
  try {
    const outside = safeExpressionVariables(expression).filter((name) => !VISIBLE_WHEN_SCOPE.has(name));
    if (outside.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `may read only inputs, outputs and status, not ${outside.join(', ')}` });
  } catch (error) {
    if (!(error instanceof ExpressionError)) throw error;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message });
  }
}

const base = {
  visibleWhen: z.string().min(1).max(500).superRefine(checkVisibleWhen).optional(),
  label: uiText.optional(),
};

const componentRef = z.lazy(() => componentSchema);
const children = z.array(componentRef);

export const uiComponentOptions = [
  z.object({ ...base, type: z.enum(['stack', 'row', 'section', 'card']), children }).strict(),
  z.object({ ...base, type: z.literal('tabs'), tabs: z.array(z.object({ label: uiText, children }).strict()) }).strict(),
  z.object({ ...base, type: z.literal('text'), bind: bindPath.optional(), source: sourcePath.optional(), placeholder: uiText.optional() }).strict(),
  z.object({ ...base, type: z.enum(['textarea', 'toggle', 'schemaForm']), bind: bindPath, placeholder: uiText.optional() }).strict(),
  z
    .object({ ...base, type: z.enum(['number', 'slider']), bind: bindPath, min: z.number().finite().optional(), max: z.number().finite().optional(), step: z.number().positive().finite().optional() })
    .strict(),
  z
    .object({
      ...base,
      type: z.enum(['select', 'radio']),
      bind: bindPath,
      options: z.array(z.object({ value: z.union([uiText, z.number().finite(), z.boolean()]), label: uiText.optional() }).strict()).optional(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('file'), bind: bindPath, accept: z.array(z.string().regex(MEDIA_TYPE, 'must be a media type such as image/png or image/*')).optional() }).strict(),
  z.object({ ...base, type: z.enum(['markdown', 'json', 'table']), source: sourcePath }).strict(),
  z.object({ ...base, type: z.literal('artifact'), artifact: z.string().max(200).regex(ARTIFACT_NAME, 'must be an artifact name declared in outputs.artifacts, never a URL or path') }).strict(),
  z.object({ ...base, type: z.enum(['runButton', 'cancelButton', 'reviseBox', 'artifactGallery', 'runStatus', 'progress', 'traceLink', 'versionList', 'compare']) }).strict(),
] as const;

const componentSchema: z.ZodType<UiComponent> = z.discriminatedUnion('type', [...uiComponentOptions]);

interface Visit {
  node: UiComponent;
  path: (string | number)[];
}

function childVisits(node: UiComponent, path: (string | number)[]): Visit[] {
  if (node.type === 'tabs') return node.tabs.flatMap((tab, t) => tab.children.map((child, i) => ({ node: child, path: [...path, 'tabs', t, 'children', i] })));
  if ('children' in node) return node.children.map((child, i) => ({ node: child, path: [...path, 'children', i] }));
  return [];
}

function visitAll(node: UiComponent, path: (string | number)[]): Visit[] {
  return [{ node, path }, ...childVisits(node, path).flatMap((child) => visitAll(child.node, child.path))];
}

function checkTextBindings(ui: { layout: UiComponent }, ctx: z.RefinementCtx): void {
  for (const { node, path } of visitAll(ui.layout, ['layout'])) {
    if (node.type === 'text' && (node.bind === undefined) === (node.source === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'text needs exactly one of bind (an input) or source (an output)', path });
    }
  }
}

export const pageUiObjectSchema = z
  .object({ schema: z.literal('lousho.ui/1'), title: uiText.optional(), layout: componentRef })
  .strict()
  .superRefine(checkTextBindings);

const R15_KEYS = ['html', 'innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'script', 'eval', 'href', 'src', 'srcset', 'srcdoc', 'url', 'style', 'css', 'className', 'class', '__proto__', 'constructor', 'prototype'];

const UI_KEY_RULES: readonly ForbiddenKeyRule[] = [
  { keys: R15_KEYS, message: (at, key) => `${at}: page UIs use only the catalog props; ${key} is not allowed (R15)` },
  { keys: FORBIDDEN_HARNESS_KEYS, message: (at, key) => `${at}: a page UI describes the screen; the runtime enforces ${key} (R13)` },
];

function formatPath(path: readonly (string | number)[]): string {
  return path.map((segment) => (typeof segment === 'number' ? `[${segment}]` : /^[A-Za-z_$][\w$]*$/.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`)).join('');
}

function handlerErrors(value: unknown, path: (string | number)[]): ForbiddenKeyError[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const at = Array.isArray(value) ? [...path, Number(key)] : [...path, key];
    const own = !Array.isArray(value) && /^on/i.test(key.replace(/[\s_-]/g, '')) ? [{ path: at, message: `ui${formatPath(at)}: event handlers are not allowed; page UIs are declarative (R15)` }] : [];
    return [...own, ...handlerErrors(child, at)];
  });
}

function scannedCopy(value: unknown, ctx: z.RefinementCtx): unknown {
  const { errors, data } = checkForbiddenKeys(value, UI_KEY_RULES, 'ui');
  const all = [...errors, ...handlerErrors(data, [])];
  for (const error of all) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message, path: error.path });
  return all.length > 0 ? z.NEVER : data;
}

/** Zod schema for `page.ui.json` (`lousho.ui/1`): the closed catalog with strict props; HTML, scripts, URLs, styles, event handlers and R13 keys are errors (R15). */
export const pageUiSchema: z.ZodType<PageUi> = z.any().transform(scannedCopy).pipe(pageUiObjectSchema);

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parts(schema: JsonSchema): JsonSchema[] {
  const allOf = Array.isArray(schema.allOf) ? schema.allOf.filter(isRecord) : [];
  return [schema, ...allOf.flatMap(parts)];
}

function propertyOf(schema: JsonSchema, name: string): JsonSchema | undefined {
  for (const part of parts(schema)) {
    const properties = part.properties;
    if (isRecord(properties) && Object.hasOwn(properties, name) && isRecord(properties[name])) return properties[name];
  }
  return undefined;
}

function schemaAt(root: JsonSchema, path: string): JsonSchema | undefined {
  return path
    .split('.')
    .slice(1)
    .reduce<JsonSchema | undefined>((schema, name) => (schema === undefined ? undefined : propertyOf(schema, name)), root);
}

function typesOf(schema: JsonSchema): string[] {
  return parts(schema).flatMap((part) => (typeof part.type === 'string' ? [part.type] : Array.isArray(part.type) ? part.type.filter((t): t is string => typeof t === 'string') : []));
}

function enumOf(schema: JsonSchema): unknown[] | undefined {
  for (const part of parts(schema)) {
    if (Array.isArray(part.enum)) return part.enum;
    if ('const' in part) return [part.const];
  }
  return undefined;
}

function requiredOf(schema: JsonSchema): string[] {
  return [...new Set(parts(schema).flatMap((part) => (Array.isArray(part.required) ? part.required.filter((name): name is string => typeof name === 'string') : [])))];
}

function hasDefault(schema: JsonSchema): boolean {
  return parts(schema).some((part) => 'default' in part);
}

interface Accepts {
  types: readonly string[];
  wording: string;
}

const STRING: Accepts = { types: ['string'], wording: 'a string' };
const NUMBER: Accepts = { types: ['number', 'integer'], wording: 'a number' };
const OBJECT: Accepts = { types: ['object'], wording: 'an object' };

const INPUT_ACCEPTS: Partial<Record<UiComponentType, Accepts>> = {
  text: STRING,
  textarea: STRING,
  number: NUMBER,
  slider: NUMBER,
  toggle: { types: ['boolean'], wording: 'a boolean' },
  file: OBJECT,
  schemaForm: OBJECT,
};

const OUTPUT_ACCEPTS: Partial<Record<UiComponentType, Accepts>> = {
  text: { types: ['string', 'number', 'integer', 'boolean'], wording: 'a string, number or boolean' },
  markdown: STRING,
  table: { types: ['array'], wording: 'an array' },
};

type Root = { schema: JsonSchema } | 'path' | undefined;

function rootOf(schema: Record<string, unknown> | string | undefined): Root {
  if (typeof schema === 'string') return 'path';
  return schema === undefined ? undefined : { schema };
}

interface Side {
  root: Root;
  name: 'inputs' | 'outputs';
  accepts: Partial<Record<UiComponentType, Accepts>>;
  missing: UiProblemCode;
  mismatch: UiProblemCode;
}

interface Checker {
  unresolved: Set<string>;
}

function typeProblem(side: Side, node: UiComponent, field: JsonSchema, path: (string | number)[], at: string): UiProblem[] {
  const accepts = side.accepts[node.type];
  const types = typesOf(field);
  if (accepts === undefined || types.length === 0 || types.some((type) => accepts.types.includes(type))) return [];
  return [{ code: side.mismatch, path, message: `${at}: ${node.type} needs ${accepts.wording} field, but the schema says ${types.join(' or ')}` }];
}

function optionProblems(node: UiComponent, field: JsonSchema, path: (string | number)[], at: string): UiProblem[] {
  if (node.type !== 'select' && node.type !== 'radio') return [];
  const allowed = enumOf(field);
  if (allowed === undefined) return [{ code: 'UI003', path: [...path, 'bind'], message: `${at}: ${node.type} needs a field with an enum` }];
  return (node.options ?? []).flatMap((option, i) =>
    allowed.includes(option.value) ? [] : [{ code: 'UI003' as const, path: [...path, 'options', i, 'value'], message: `${at}: option '${String(option.value)}' is not in the schema's enum` }]
  );
}

function fieldProblems(checker: Checker, side: Side, visit: Visit, prop: 'bind' | 'source', at: string): UiProblem[] {
  const path = [...visit.path, prop];
  if (side.root === 'path') {
    checker.unresolved.add(side.name);
    return [];
  }
  const field = side.root === undefined ? undefined : schemaAt(side.root.schema, at);
  if (field === undefined) return [{ code: side.missing, path, message: `${at}: no such field in the harness's ${side.name}.schema` }];
  return [...typeProblem(side, visit.node, field, path, at), ...optionProblems(visit.node, field, visit.path, at)];
}

function artifactProblems(visit: Visit, declared: ReadonlySet<string>): UiProblem[] {
  if (visit.node.type !== 'artifact' || declared.has(visit.node.artifact)) return [];
  return [{ code: 'UI006', path: [...visit.path, 'artifact'], message: `artifact '${visit.node.artifact}' is not declared in the harness's outputs.artifacts` }];
}

function isCovered(path: string, binds: readonly string[]): boolean {
  return binds.some((bind) => path === bind || path.startsWith(`${bind}.`));
}

function isPartlyBound(path: string, binds: readonly string[]): boolean {
  return binds.some((bind) => bind.startsWith(`${path}.`));
}

function unboundField(field: JsonSchema | undefined, path: string, binds: readonly string[]): string[] {
  if (field === undefined) return [path];
  if (hasDefault(field)) return [];
  return isPartlyBound(path, binds) ? unboundRequired(field, path, binds) : [path];
}

function unboundRequired(schema: JsonSchema, prefix: string, binds: readonly string[]): string[] {
  return requiredOf(schema).flatMap((name) => {
    const path = `${prefix}.${name}`;
    return isCovered(path, binds) ? [] : unboundField(propertyOf(schema, name), path, binds);
  });
}

function requiredProblems(root: Root, binds: readonly string[]): UiProblem[] {
  if (root === undefined || root === 'path') return [];
  return unboundRequired(root.schema, 'inputs', binds).map((path) => ({ code: 'UI007', path: ['layout'], message: `${path} is required and has no default, but no input binds it` }));
}

function bindOf(node: UiComponent): string | undefined {
  return 'bind' in node ? node.bind : undefined;
}

function sourceOf(node: UiComponent): string | undefined {
  return 'source' in node ? node.source : undefined;
}

function visitProblems(checker: Checker, sides: { inputs: Side; outputs: Side }, visit: Visit, declared: ReadonlySet<string>): UiProblem[] {
  const bind = bindOf(visit.node);
  const source = sourceOf(visit.node);
  return [
    ...(bind === undefined ? [] : fieldProblems(checker, sides.inputs, visit, 'bind', bind)),
    ...(source === undefined ? [] : fieldProblems(checker, sides.outputs, visit, 'source', source)),
    ...artifactProblems(visit, declared),
  ];
}

function sidesOf(harness: UiBindingTarget): { inputs: Side; outputs: Side } {
  return {
    inputs: { root: rootOf(harness.inputs?.schema), name: 'inputs', accepts: INPUT_ACCEPTS, missing: 'UI001', mismatch: 'UI002' },
    outputs: { root: rootOf(harness.outputs?.schema), name: 'outputs', accepts: OUTPUT_ACCEPTS, missing: 'UI004', mismatch: 'UI005' },
  };
}

function declaredArtifacts(harness: UiBindingTarget): Set<string> {
  return new Set((harness.outputs?.artifacts ?? []).map((artifact) => artifact.name));
}

function unresolvedProblems(checker: Checker): UiProblem[] {
  return (['inputs', 'outputs'] as const)
    .filter((name) => checker.unresolved.has(name))
    .map((name) => ({ code: 'UI008', path: [], message: `${name}.schema is a file path; resolve it before checking UI bindings` }));
}

/** Checks a parsed page UI against the effective harness: binds, options, sources, artifacts and required inputs; pure, so `validateWorkspace` (P0.10) and the Studio call it on unsaved state. */
export function validateUiBindings(ui: PageUi, harness: UiBindingTarget): UiProblem[] {
  const sides = sidesOf(harness);
  const checker: Checker = { unresolved: new Set(sides.inputs.root === 'path' ? ['inputs'] : []) };
  const declared = declaredArtifacts(harness);
  const visits = visitAll(ui.layout, ['layout']);
  const problems = visits.flatMap((visit) => visitProblems(checker, sides, visit, declared));
  const binds = visits.flatMap((visit) => bindOf(visit.node) ?? []);
  return [...unresolvedProblems(checker), ...problems, ...requiredProblems(sides.inputs.root, binds)];
}
