import { useCallback, useEffect, useMemo, useState } from 'react';

import { agentSpecV2JsonSchema, type AgentSpecV2 } from 'lousho/spec';

import type { AgentRecord } from '../../../../shared/wireTypes';
import { RuntimeApiError, runtimeClient } from '../../../runtime/runtimeClient';
import { useAppState } from '../../../state/AppState';
import type { JsonSchema, SchemaIssue } from '../../../ui/schemaForm/types';
import { issuesByPath, validateSchemaValue } from '../../../ui/schemaForm/validate';
import { useToast } from '../../../ui/Toast';
import { changedSections, sectionOf } from './sections';

/** What {@link useConfigureDraft} hands the Configure tab. */
export interface ConfigureDraft {
  /** The editable spec; starts as the record's and follows it after a save/refresh. */
  draft: AgentSpecV2;
  /** Validation complaints against the draft, in schema order. */
  issues: SchemaIssue[];
  /** `issues` flattened to `{ pathKey: message }` for each section form's `errors` prop. */
  errors: Record<string, string>;
  /** Section ids whose keys differ from the saved spec, in section order. */
  changed: string[];
  /** Issue count per section id (hidden-key issues count nowhere). */
  issueCounts: Record<string, number>;
  /** Whether the draft differs from the saved spec at all. */
  dirty: boolean;
  /** Replaces the whole draft (Discard). */
  reset(): void;
  /**
   * Merges one section form's edited value back into the draft: the section
   * schema only carries its own keys, so keys it dropped are deleted and the
   * rest of the spec is untouched.
   */
  applySection(keys: string[], next: unknown): void;
}

/**
 * The Configure tab's draft state (A07): the spec copy being edited, its
 * schema validation and the per-section dirty/issue bookkeeping. The draft
 * re-seeds whenever `record.spec` changes identity (a save's refresh or a
 * `setRecord`), so an outside edit never leaves a stale form behind.
 */
export function useConfigureDraft(record: AgentRecord): ConfigureDraft {
  const root = useMemo(() => agentSpecV2JsonSchema() as unknown as JsonSchema, []);
  const [draft, setDraft] = useState<AgentSpecV2>(() => record.spec);

  useEffect(() => {
    setDraft(record.spec);
  }, [record.spec]);

  const issues = useMemo(() => validateSchemaValue(root, draft), [root, draft]);
  const errors = useMemo(() => issuesByPath(issues), [issues]);
  const changed = useMemo(() => changedSections(record.spec, draft), [record.spec, draft]);
  const issueCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const issue of issues) {
      const section = sectionOf(issue.path);
      if (section !== undefined) counts[section] = (counts[section] ?? 0) + 1;
    }
    return counts;
  }, [issues]);

  const reset = useCallback(() => setDraft(record.spec), [record.spec]);

  const applySection = useCallback((keys: string[], next: unknown) => {
    setDraft((prev) => {
      const merged = { ...(prev as unknown as Record<string, unknown>) };
      const section = (next ?? {}) as Record<string, unknown>;
      for (const key of keys) {
        if (section[key] !== undefined) merged[key] = section[key];
        else delete merged[key];
      }
      return merged as unknown as AgentSpecV2;
    });
  }, []);

  return {
    draft,
    issues,
    errors,
    changed,
    issueCounts,
    dirty: changed.length > 0,
    reset,
    applySection,
  };
}

/** What {@link useConfigureSave} hands the Configure tab's save bar. */
export interface ConfigureSave {
  saving: boolean;
  save(): Promise<void>;
}

/**
 * The Configure tab's save action (A07): PUTs the draft spec, toasts the
 * outcome and refreshes the record. When the canvas holds this same agent
 * open and clean, `switchAgent` reloads its document so it picks the save
 * up; a dirty canvas keeps its own copy (the save-bar note warns).
 */
export function useConfigureSave(
  record: AgentRecord,
  draft: AgentSpecV2,
  refresh: () => void,
): ConfigureSave {
  const app = useAppState();
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await runtimeClient.saveAgent(record.id, draft);
      refresh();
      toast.show({ message: 'Changes saved', tone: 'success' });
      if (app.agentId === record.id && !app.dirty) void app.switchAgent(record.id);
    } catch (err) {
      if (err instanceof RuntimeApiError && err.status === 400) {
        toast.show({ message: err.message, tone: 'error' });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        toast.show({ message: `Could not save: ${message}`, tone: 'error' });
      }
    } finally {
      setSaving(false);
    }
  }, [app, draft, record.id, refresh, toast]);

  return { saving, save };
}
