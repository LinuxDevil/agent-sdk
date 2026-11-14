/**
 * The import sheet (L08b, on the U04 Sheet at size lg): paste YAML/JSON or a
 * Studio bundle, or pick a `.yaml`/`.yml`/`.json` file; a debounced preview
 * (`useImportPreview`) shows the name, model, capabilities, requirements,
 * clash and warnings before the user picks a mode (`new` / `copy` /
 * `replace`) and commits through `POST /agents/import`. Success toasts,
 * navigates to the agent's Overview and closes; failures stay in the sheet.
 *
 * All state lives in {@link ImportSheetForm}, which only mounts while the
 * sheet is open - closing (Escape, scrim, Cancel, success) unmounts it, so
 * text, file name, mode, target and preview reset for free on the next open.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { LoaderCircle, Upload } from 'lucide-react';
import type {
  AgentListItem,
  AgentRecord,
  ImportMode,
  ImportPreview,
  ImportRequest,
  Requirement,
} from '../../../../shared/wireTypes';
import { runtimeClient } from '../../../runtime/runtimeClient';
import { navigate } from '../../../router/router';
import { agentTabPath } from '../../agents/agentTabs';
import { Field } from '../../../ui/Field';
import { Select } from '../../../ui/controls';
import { Textarea } from '../../../ui/controls';
import { AgentTile } from '../../../ui/AgentTile';
import { StatusBadge } from '../../../ui/StatusBadge';
import type { StatusKey } from '../../../ui/status';
import { Sheet } from '../../../ui/Sheet';
import { Skeleton } from '../../../ui/Skeleton';
import { useToast } from '../../../ui/Toast';
import { PortabilityPanel } from '../../agentDetail/export/PortabilityPanel';
import { useImportPreview, type ImportPreviewState } from './useImportPreview';
import './importSheet.css';

/** Mirrors the server's 1 MB cap (`MAX_IMPORT_BYTES` in server/lifecycle/import.ts). */
const MAX_IMPORT_BYTES = 1024 * 1024;
const ACCEPT = '.yaml,.yml,.json';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const FORMAT_LABEL: Record<ImportPreview['format'], string> = { yaml: 'YAML', json: 'JSON', bundle: 'bundle' };

/** `Requirement.status` onto the badge's StatusKey: ok reads done, missing reads failed, unknown stays unknown. */
function requirementStatus(status: Requirement['status']): StatusKey {
  return status === 'ok' ? 'done' : status === 'missing' ? 'error' : 'unknown';
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The muted line under the preview name: model, tool/trigger counts (zero parts omitted) and the source format. */
function previewMeta(preview: ImportPreview): string {
  const { spec } = preview;
  const parts = [spec.model];
  const tools = spec.tools?.length ?? 0;
  const triggers = spec.triggers?.length ?? 0;
  if (tools > 0) parts.push(plural(tools, 'tool'));
  if (triggers > 0) parts.push(plural(triggers, 'trigger'));
  parts.push(FORMAT_LABEL[preview.format]);
  return parts.join(' · ');
}

/** One preview section state: skeleton while loading, the server's message on error, the card on success. */
function PreviewBody({ state }: { state: ImportPreviewState }): JSX.Element | null {
  if (state.loading) {
    return (
      <section className="import-preview" aria-live="polite" aria-label="Preview">
        <Skeleton className="import-preview-skeleton" />
      </section>
    );
  }
  if (state.error !== undefined) {
    return (
      <section className="import-preview" aria-live="polite" aria-label="Preview">
        <p className="import-error" role="alert">
          {state.error.message}
        </p>
      </section>
    );
  }
  if (state.preview === undefined) return null;
  return <ImportPreviewCard preview={state.preview} />;
}

/** The parsed spec's summary card: tile, name, meta line, readiness badges, warnings and the id clash. */
function ImportPreviewCard({ preview }: { preview: ImportPreview }): JSX.Element {
  return (
    <section className="import-preview" aria-live="polite" aria-label="Preview">
      <div className="import-preview-card">
        <AgentTile id={preview.resolvedId} size="sm" />
        <div className="import-preview-text">
          <p className="import-preview-name">{preview.spec.name}</p>
          <p className="import-preview-meta">{previewMeta(preview)}</p>
        </div>
      </div>
      {preview.requirements.length > 0 && (
        <ul className="import-requirements">
          {preview.requirements.map((req) => (
            <li key={req.id}>
              <StatusBadge status={requirementStatus(req.status)} label={req.label} size="sm" />
            </li>
          ))}
        </ul>
      )}
      {preview.warnings.length > 0 && (
        <ul className="import-warnings">
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {preview.clash !== null && (
        <p className="import-clash" role="status">
          An agent with the id <code>{preview.clash.id}</code> already exists (“{preview.clash.name}”).
        </p>
      )}
    </section>
  );
}

interface ModeOption {
  mode: ImportMode;
  label: string;
  /** The resolved-id hint for the selected mode; unselected modes get the generic line. */
  hint: (preview: ImportPreview | undefined, selected: boolean) => ReactNode;
}

const SAVED_AS = (preview: ImportPreview | undefined): ReactNode =>
  preview === undefined ? 'Saved under a new id' : (
    <>
      Saved as <code>{preview.resolvedId}</code>
    </>
  );

const MODE_OPTIONS: ModeOption[] = [
  { mode: 'new', label: 'Create a new agent', hint: (p, s) => (s ? SAVED_AS(p) : 'Saved under a new id') },
  { mode: 'copy', label: 'Make a copy', hint: (p, s) => (s ? SAVED_AS(p) : 'Saved under a new id') },
  {
    mode: 'replace',
    label: 'Replace an existing agent',
    hint: () => 'Writes a new version; history is kept',
  },
];

interface ImportModeFieldsProps {
  mode: ImportMode;
  preview: ImportPreview | undefined;
  agents: AgentListItem[] | undefined;
  targetId: string;
  namePrefix: string;
  onMode(mode: ImportMode): void;
  onTarget(targetId: string): void;
}

/** The "How to import" fieldset: the three mode radios and, for replace, the agent picker. */
function ImportModeFields({
  mode,
  preview,
  agents,
  targetId,
  namePrefix,
  onMode,
  onTarget,
}: ImportModeFieldsProps): JSX.Element {
  const options = (agents ?? []).map((agent) => ({ value: agent.id, label: agent.name }));
  // A target that is not in the list (still loading, or deleted since) stays selectable.
  if (targetId !== '' && !(agents ?? []).some((agent) => agent.id === targetId)) {
    options.unshift({ value: targetId, label: targetId });
  }
  return (
    <fieldset className="import-mode">
      <legend>How to import</legend>
      {MODE_OPTIONS.map((option) => {
        const selected = option.mode === mode;
        return (
          <label key={option.mode} className="import-mode-option">
            <input
              type="radio"
              name={namePrefix}
              value={option.mode}
              checked={selected}
              onChange={() => onMode(option.mode)}
            />
            <span className="import-mode-text">
              {option.label} <span className="hint">{option.hint(preview, selected)}</span>
            </span>
          </label>
        );
      })}
      {mode === 'replace' && (
        <Field label="Agent to replace">
          <Select
            value={targetId}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => onTarget(event.target.value)}
            options={options}
            placeholder={agents === undefined ? 'Loading agents…' : 'Pick an agent…'}
          />
        </Field>
      )}
    </fieldset>
  );
}

export interface ImportSheetProps {
  open: boolean;
  onClose(): void;
  /** When given (L09b/X06b reuse), the sheet opens on `replace` aimed at this agent. */
  initialTargetId?: string;
}

/**
 * The sheet shell: mounts {@link ImportSheetForm} only while `open`, so every
 * open starts from a fresh form (text, file, mode, target and preview all
 * reset on close - Escape, scrim and Cancel included).
 */
export function ImportSheet({ open, onClose, initialTargetId }: ImportSheetProps): JSX.Element {
  return <>{open ? <ImportSheetForm initialTargetId={initialTargetId} onClose={onClose} /> : null}</>;
}

/** The textarea text plus the picked file's name/error; `readVersion` drops stale FileReader results. */
function useImportSource(): {
  text: string;
  setText(text: string): void;
  fileName: string | undefined;
  sourceError: string | undefined;
  onPickFile(event: ChangeEvent<HTMLInputElement>): void;
} {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [sourceError, setSourceError] = useState<string | undefined>(undefined);
  const readVersion = useRef(0);

  const onPickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    const version = ++readVersion.current;
    setSourceError(undefined);
    setFileName(file.name);
    if (file.size > MAX_IMPORT_BYTES) {
      setSourceError('That file is larger than 1 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (readVersion.current !== version) return;
      setText(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      if (readVersion.current === version) setSourceError('Could not read that file.');
    };
    reader.readAsText(file);
  };

  return { text, setText, fileName, sourceError, onPickFile };
}

interface DisabledReasonArgs {
  importing: boolean;
  hasText: boolean;
  previewError: boolean;
  mode: ImportMode;
  targetId: string;
}

/** Why the Import button is disabled, in priority order; `undefined` means it can run. */
function importDisabledReason({ importing, hasText, previewError, mode, targetId }: DisabledReasonArgs): string | undefined {
  if (importing) return 'Importing…';
  if (!hasText) return 'Paste a spec first';
  if (previewError) return 'Fix the spec first';
  if (mode === 'replace' && targetId === '') return 'Pick the agent to replace';
  return undefined;
}

/** The mode/target the sheet opens on: `replace` aimed at `initialTargetId` when one is given. */
function initialMode(targetId: string | undefined): ImportMode {
  return targetId === undefined ? 'new' : 'replace';
}

/** The target the preview/import requests carry: only a picked replace target counts. */
function effectiveTarget(mode: ImportMode, targetId: string): string | undefined {
  return mode === 'replace' && targetId !== '' ? targetId : undefined;
}

/** The `POST /agents/import` body: `targetId` rides along only for a picked replace target. */
function importRequestOf(text: string, mode: ImportMode, targetId: string): ImportRequest {
  const target = effectiveTarget(mode, targetId);
  return target === undefined ? { text, mode } : { text, mode, targetId: target };
}

/** The success toast for a finished import: replace names the new version, new/copy the off-until-enabled note. */
function importToast(mode: ImportMode, record: AgentRecord): { message: string; tone: 'success' } {
  const name = record.spec.name;
  if (mode !== 'replace') return { message: `Imported ${name}. It is off until you turn it on.`, tone: 'success' };
  const version = record.latestVersion === null ? '' : ` (v${record.latestVersion})`;
  return { message: `Replaced ${name} with the imported spec${version}.`, tone: 'success' };
}

interface ImportSheetFormViewProps {
  formId: string;
  onClose(): void;
  onSubmit(event: FormEvent): void;
  source: ReturnType<typeof useImportSource>;
  previewState: ImportPreviewState;
  mode: ImportMode;
  preview: ImportPreview | undefined;
  agents: AgentListItem[] | undefined;
  targetId: string;
  radioName: string;
  onMode(mode: ImportMode): void;
  onTarget(targetId: string): void;
  importError: string | undefined;
  disabledReason: string | undefined;
  reasonId: string;
  importing: boolean;
}

/** The sheet's presentational half: Sheet chrome, footer actions and the form body. */
function ImportSheetFormView(props: ImportSheetFormViewProps): JSX.Element {
  const {
    formId,
    onClose,
    onSubmit,
    source,
    previewState,
    mode,
    preview,
    agents,
    targetId,
    radioName,
    onMode,
    onTarget,
    importError,
    disabledReason,
    reasonId,
    importing,
  } = props;
  const textArea = useRef<HTMLTextAreaElement>(null);
  return (
    <Sheet
      open
      onClose={onClose}
      size="lg"
      title="Import an agent"
      description="Paste a spec or a bundle exported from Studio, or pick a file."
      initialFocus={textArea}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="btn btn-primary"
            disabled={disabledReason !== undefined}
            title={disabledReason}
            aria-describedby={disabledReason === undefined ? undefined : reasonId}
          >
            {importing ? <LoaderCircle size={14} className="btn-spinner" aria-hidden="true" /> : null}
            {importing ? 'Importing…' : 'Import'}
          </button>
        </>
      }
    >
      <form id={formId} className="import-sheet" aria-describedby="import-note" onSubmit={onSubmit}>
        <ImportSourceRow source={source} />
        <Field label="Spec or bundle">
          <Textarea
            ref={textArea}
            className="import-text"
            rows={12}
            spellCheck={false}
            placeholder={'name: Support triage\nmodel: anthropic/claude-sonnet-5-5\ninstructions: …'}
            value={source.text}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => source.setText(event.target.value)}
          />
        </Field>
        <PreviewBody state={previewState} />
        {preview !== undefined ? (
          <PortabilityPanel
            key={source.text}
            run={() => runtimeClient.checkImportPortability(source.text)}
          />
        ) : null}
        <ImportModeFields
          mode={mode}
          preview={preview}
          agents={agents}
          targetId={targetId}
          namePrefix={radioName}
          onMode={onMode}
          onTarget={onTarget}
        />
        {importError !== undefined && (
          <p className="import-error" role="alert">
            {importError}
          </p>
        )}
        {disabledReason !== undefined && (
          <p className="hint" id={reasonId}>
            {disabledReason}
          </p>
        )}
        <p id="import-note" className="hint">
          Imported agents start turned off. Secrets are not part of a spec; add them in Settings.
        </p>
      </form>
    </Sheet>
  );
}

/** The Choose-file row plus the picked file's name and any client-side read error. */
function ImportSourceRow({ source }: { source: ReturnType<typeof useImportSource> }): JSX.Element {
  return (
    <>
      <div className="import-source" role="group" aria-label="Source">
        <label className="btn btn-secondary btn-sm import-file">
          <Upload size={14} strokeWidth={1.75} aria-hidden="true" />
          Choose file…
          <input type="file" accept={ACCEPT} className="visually-hidden" onChange={source.onPickFile} />
        </label>
        {source.fileName !== undefined && <span className="import-file-name">{source.fileName}</span>}
      </div>
      {source.sourceError !== undefined && (
        <p className="import-error" role="alert">
          {source.sourceError}
        </p>
      )}
    </>
  );
}

/** Everything inside the sheet; mounts per open so closing resets all of it. */
function ImportSheetForm({ initialTargetId, onClose }: { initialTargetId?: string; onClose(): void }): JSX.Element {
  const toast = useToast();
  const formId = useId();
  const radioName = useId();
  const reasonId = useId();
  const source = useImportSource();

  const [mode, setMode] = useState<ImportMode>(() => initialMode(initialTargetId));
  const [targetId, setTargetId] = useState(initialTargetId ?? '');
  const [agents, setAgents] = useState<AgentListItem[] | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | undefined>(undefined);

  const previewState = useImportPreview(source.text, mode, effectiveTarget(mode, targetId));

  useEffect(() => {
    let cancelled = false;
    runtimeClient
      .listAgents()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const disabledReason = importDisabledReason({
    importing,
    hasText: source.text.trim() !== '',
    previewError: previewState.error !== undefined,
    mode,
    targetId,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabledReason !== undefined) return;
    setImporting(true);
    setImportError(undefined);
    runtimeClient
      .importAgent(importRequestOf(source.text, mode, targetId))
      .then((record) => {
        toast.show(importToast(mode, record));
        navigate(agentTabPath(record.id, 'overview'));
        onClose();
      })
      .catch((error: unknown) => setImportError(messageOf(error)))
      .finally(() => setImporting(false));
  };

  return (
    <ImportSheetFormView
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      source={source}
      previewState={previewState}
      mode={mode}
      preview={previewState.preview}
      agents={agents}
      targetId={targetId}
      radioName={radioName}
      onMode={setMode}
      onTarget={setTargetId}
      importError={importError}
      disabledReason={disabledReason}
      reasonId={reasonId}
      importing={importing}
    />
  );
}

