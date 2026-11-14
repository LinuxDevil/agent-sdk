import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { agentSpecV2JsonSchema } from '@linuxdevil/lousho/spec';

import { useQueryState } from '../../../router/useRoute';
import { useAppState } from '../../../state/AppState';
import { Card } from '../../../ui/Card';
import { SchemaForm } from '../../../ui/schemaForm/SchemaForm';
import type { JsonSchema } from '../../../ui/schemaForm/types';
import { useAgentDetail } from '../AgentDetailContext';
import {
  CONFIGURE_SECTIONS,
  pickSection,
  sectionSchema,
  type ConfigureSection,
} from './sections';
import { useConfigureDraft, useConfigureSave } from './useConfigureDraft';
import { useActiveSection } from './useActiveSection';
import './configure.css';

/** Scrolls `el` into view, instantly under `prefers-reduced-motion: reduce`. */
function scrollToSection(el: HTMLElement | null): void {
  if (el === null) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
}

/** The sticky left index: one button per section with a changed-dot and an issue count. */
function SectionIndex({
  active,
  changed,
  issueCounts,
  onSelect,
}: {
  active: string;
  changed: string[];
  issueCounts: Record<string, number>;
  onSelect(id: string): void;
}): JSX.Element {
  return (
    <nav className="configure-index" aria-label="Sections">
      <ul>
        {CONFIGURE_SECTIONS.map((section) => {
          const issues = issueCounts[section.id] ?? 0;
          return (
            <li key={section.id}>
              <button
                type="button"
                className="configure-index-item"
                aria-current={active === section.id ? 'true' : undefined}
                onClick={() => onSelect(section.id)}
              >
                {section.title}
                {changed.includes(section.id) && <span className="configure-dot" aria-hidden="true" />}
                {issues > 0 && (
                  <span className="configure-issues tabular-nums">
                    {issues}
                    <span className="visually-hidden">{` (${issues} problem${issues === 1 ? '' : 's'})`}</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The sticky bottom bar, rendered only while the draft is dirty. */
function SaveBar({
  changedCount,
  issueCount,
  saving,
  canvasDirty,
  readOnlyTitle,
  onDiscard,
  onSave,
}: {
  changedCount: number;
  issueCount: number;
  saving: boolean;
  canvasDirty: boolean;
  /** W11c: the read-only workspace's banner text - Save disables with it as `title`. */
  readOnlyTitle?: string;
  onDiscard(): void;
  onSave(): void;
}): JSX.Element {
  return (
    <div className="configure-savebar" role="region" aria-label="Unsaved changes">
      <span className="configure-savebar-text">
        {`${changedCount} section${changedCount === 1 ? '' : 's'} changed`}
        {canvasDirty && (
          <span className="configure-savebar-note">
            {' The canvas has unsaved edits to this agent. Saving here will be overwritten when the canvas saves.'}
          </span>
        )}
      </span>
      <button type="button" className="btn" onClick={onDiscard} disabled={saving}>
        Discard
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={issueCount > 0 || saving || readOnlyTitle !== undefined}
        title={
          readOnlyTitle ?? (issueCount > 0 ? `Fix ${issueCount} problem${issueCount === 1 ? '' : 's'} first` : undefined)
        }
        onClick={onSave}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

/**
 * `#/agents/:id/configure` (A07): the whole spec v2 as eight stacked section
 * cards drawn by the schema-driven {@link SchemaForm} from
 * `agentSpecV2JsonSchema`. Edits stay in a local draft until Save PUTs the
 * spec (`runtimeClient.saveAgent`); Discard restores the saved spec. The
 * sticky index tracks the section nearest the top and mirrors `?section=`.
 */
export function ConfigureTab(): JSX.Element {
  const { record, refresh, readOnlyTitle } = useAgentDetail();
  const app = useAppState();
  const { draft, issues, errors, changed, issueCounts, dirty, reset, applySection } =
    useConfigureDraft(record);
  const { saving, save } = useConfigureSave(record, draft, refresh);

  const root = useMemo(() => agentSpecV2JsonSchema() as unknown as JsonSchema, []);
  const sectionSchemas = useMemo(
    () =>
      Object.fromEntries(
        CONFIGURE_SECTIONS.map((section) => [section.id, sectionSchema(root, section.keys)]),
      ) as Record<string, JsonSchema>,
    [root],
  );

  const [sectionParam, setSectionParam] = useQueryState<string | null>(
    'section',
    (s) => s,
    (v) => v,
  );
  const [activeId, setActiveId] = useState<string>(() => sectionParam ?? CONFIGURE_SECTIONS[0].id);
  const scrolledRef = useRef(false);

  // Deep link: on mount, scroll to `?section=` when present.
  useEffect(() => {
    if (scrolledRef.current) return;
    scrolledRef.current = true;
    if (sectionParam !== null && sectionParam !== undefined) {
      scrollToSection(document.getElementById(`configure-${sectionParam}`));
    }
  }, [sectionParam]);

  // `aria-current` follows the section nearest the top of the viewport;
  // without IntersectionObserver (jsdom, old browsers) the last click wins.
  useActiveSection(setActiveId);

  const selectSection = useCallback(
    (id: string) => {
      setActiveId(id);
      setSectionParam(id);
      scrollToSection(document.getElementById(`configure-${id}`));
    },
    [setSectionParam],
  );

  // Warn on tab close while dirty; in-app navigation stays unblocked (the
  // save bar is the cue) - see the ticket's Out of scope.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const canvasDirty = app.agentId === record.id && app.dirty;
  const totalIssues = issues.length;

  return (
    <div className="configure">
      <SectionIndex active={activeId} changed={changed} issueCounts={issueCounts} onSelect={selectSection} />
      <div className="configure-sections">
        {CONFIGURE_SECTIONS.map((section: ConfigureSection) => (
          <Card
            key={section.id}
            as="section"
            id={`configure-${section.id}`}
            className="configure-section"
            title={section.title}
            description={section.description}
          >
            <SchemaForm
              schema={sectionSchemas[section.id]}
              value={pickSection(draft, section.keys)}
              onChange={(next) => applySection(section.keys, next)}
              idPrefix={`configure-${section.id}`}
              errors={errors}
            />
          </Card>
        ))}
        {dirty && (
          <SaveBar
            changedCount={changed.length}
            issueCount={totalIssues}
            saving={saving}
            canvasDirty={canvasDirty}
            readOnlyTitle={readOnlyTitle}
            onDiscard={reset}
            onSave={() => void save()}
          />
        )}
      </div>
    </div>
  );
}
