import { useEffect, type Key, type ReactElement } from 'react';
import type { UiComponent, UiComponentType, UiText } from '@linuxdevil/lousho/workspaces/client';
import type { RenderContext } from './context';
import { CancelButton, ReviseBox, RunButton } from './components/actions';
import { ChoiceRadio, ChoiceSelect, FileInput, NumberInput, SchemaFormField, TextArea, TextInput, Toggle } from './components/inputs';
import { Container, Tabs } from './components/layout';
import { ArtifactGallery, ArtifactOutput, JsonOutput, Markdown, TableOutput, TextOutput } from './components/outputs';
import { Progress, RunStatus, TraceLink, VersionsLater } from './components/status';
import { isVisible } from './visible';

type NodeOf<K extends UiComponentType> = UiComponent & { type: K };
type Renderer<K extends UiComponentType> = (props: { node: NodeOf<K>; ctx: RenderContext }) => ReactElement | null;
type RendererMap = { readonly [K in UiComponentType]: Renderer<K> };

function Text({ node, ctx }: { node: UiText; ctx: RenderContext }): ReactElement {
  return node.bind !== undefined ? <TextInput node={node} ctx={ctx} /> : <TextOutput node={node} ctx={ctx} />;
}

const RENDERERS: RendererMap = {
  stack: Container,
  row: Container,
  section: Container,
  card: Container,
  tabs: Tabs,
  text: Text,
  textarea: TextArea,
  number: NumberInput,
  slider: NumberInput,
  select: ChoiceSelect,
  radio: ChoiceRadio,
  toggle: Toggle,
  file: FileInput,
  schemaForm: SchemaFormField,
  runButton: RunButton,
  cancelButton: CancelButton,
  reviseBox: ReviseBox,
  markdown: Markdown,
  json: JsonOutput,
  table: TableOutput,
  artifact: ArtifactOutput,
  artifactGallery: ArtifactGallery,
  runStatus: RunStatus,
  progress: Progress,
  traceLink: TraceLink,
  versionList: VersionsLater,
  compare: VersionsLater,
};

function rendererFor(type: string): Renderer<UiComponentType> | undefined {
  return Object.hasOwn(RENDERERS, type) ? (RENDERERS[type as UiComponentType] as unknown as Renderer<UiComponentType>) : undefined;
}

function Unsupported({ type }: { type: string }): ReactElement {
  useEffect(() => {
    console.warn(`@lousho/workspaces-react: unsupported page UI component type ${JSON.stringify(type)}`);
  }, [type]);
  return (
    <p className="lwr-note" role="note">
      Unsupported component: {type}
    </p>
  );
}

function NodeView({ node, ctx }: { node: UiComponent; ctx: RenderContext }): ReactElement | null {
  const scope = { inputs: ctx.form.values, outputs: ctx.run.view?.result?.output ?? {}, status: ctx.run.status };
  if (!isVisible(node.visibleWhen, scope)) return null;
  const Render = rendererFor(String(node.type));
  return Render === undefined ? <Unsupported type={String(node.type)} /> : <Render node={node as NodeOf<UiComponentType>} ctx={ctx} />;
}

export function renderComponent(node: UiComponent, ctx: RenderContext, key?: Key): ReactElement {
  return <NodeView key={key} node={node} ctx={ctx} />;
}
