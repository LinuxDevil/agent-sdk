/**
 * The template detail sheet (A10, on the U04 Sheet at size lg): what the
 * template needs and its README as plain text (never markdown - the Studio
 * has no renderer), with Use template creating the agent through
 * `POST /agents { from: { template } }` and opening its canvas. The detail
 * itself comes from `GET /templates/:id`; the sheet's own loading/error
 * states are separate from the list's.
 */
import { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type { TemplateDetail, TemplateSummary } from '../../../shared/wireTypes';
import { runtimeClient } from '../../runtime/runtimeClient';
import { navigate } from '../../router/router';
import { agentTabPath } from '../agents/agentTabs';
import { Sheet } from '../../ui/Sheet';
import { SkeletonRows } from '../../ui/Skeleton';
import { useToast } from '../../ui/Toast';
import { REQUIRE_LABELS } from './templatesModel';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The detail fetch for one template id; `for` guards a stale answer outliving its id. */
type DetailState =
  | { for: string; status: 'loading' }
  | { for: string; status: 'error'; message: string }
  | { for: string; status: 'loaded'; detail: TemplateDetail };

export interface TemplateSheetProps {
  /** The `?template=` id; `null` keeps the sheet closed. */
  templateId: string | null;
  /** The card's summary when the list already loaded it (title/category fallbacks). */
  summary: TemplateSummary | undefined;
  onClose(): void;
}

function useTemplateDetail(templateId: string | null) {
  const [detailState, setDetailState] = useState<DetailState>({ for: '', status: 'loading' });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (templateId === null) return;
    const id = templateId;
    let cancelled = false;
    setDetailState({ for: id, status: 'loading' });
    runtimeClient
      .getTemplate(id)
      .then((detail) => {
        if (cancelled) return;
        if (detail === undefined) setDetailState({ for: id, status: 'error', message: `No template '${id}'.` });
        else setDetailState({ for: id, status: 'loaded', detail });
      })
      .catch((error: unknown) => {
        if (!cancelled) setDetailState({ for: id, status: 'error', message: messageOf(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [templateId, reload]);

  // Until the fetch for THIS id lands, the sheet shows its loading state - a
  // previous template's detail never leaks into the next sheet.
  const current = templateId !== null && detailState.for === templateId ? detailState : undefined;
  return {
    status: current?.status ?? 'loading',
    detail: current?.status === 'loaded' ? current.detail : undefined,
    detailError: current?.status === 'error' ? current.message : undefined,
    retry: () => setReload((n) => n + 1),
  };
}

function useCreateFromTemplate(templateId: string | null, title: string) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);

  const create = () => {
    if (templateId === null || creating) return;
    const id = templateId;
    setCreating(true);
    runtimeClient
      .createAgentRecord({ from: { template: id } })
      .then((record) => {
        toast.show({ message: `Created “${record.spec.name}” from ${title}`, tone: 'success' });
        navigate(agentTabPath(record.id, 'canvas'));
      })
      .catch((error: unknown) => toast.show({ message: messageOf(error), tone: 'error' }))
      .finally(() => setCreating(false));
  };

  return { creating, create };
}

function TemplateSheetDetail({ detail }: { detail: TemplateDetail }) {
  const requires = detail.summary.requires ?? [];
  return (
    <>
      <section className="template-sheet-section" aria-label="Requirements">
        <h3 className="overline">What it needs</h3>
        {requires.length === 0 ? (
          <p className="template-sheet-note">Nothing extra. It runs with your default model.</p>
        ) : (
          <ul className="template-requirements">
            {requires.map((kind) => (
              <li key={kind}>
                <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
                {REQUIRE_LABELS[kind]}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="template-sheet-section" aria-label="About">
        <h3 className="overline">About</h3>
        <pre className="template-readme">{detail.readme}</pre>
      </section>
    </>
  );
}

export function TemplateSheet({ templateId, summary, onClose }: TemplateSheetProps) {
  const { status, detail, detailError, retry } = useTemplateDetail(templateId);

  const title = detail?.summary.title ?? summary?.title ?? templateId ?? '';
  const category = detail?.summary.category ?? summary?.category;
  const { creating, create } = useCreateFromTemplate(templateId, title);

  return (
    <Sheet
      open={templateId !== null}
      onClose={onClose}
      size="lg"
      title={title}
      description={category}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={creating} onClick={create}>
            {creating ? 'Creating…' : 'Use template'}
          </button>
        </>
      }
    >
      {status === 'loading' && <SkeletonRows rows={8} />}
      {status === 'error' && (
        <div className="template-sheet-error-row">
          <p className="template-sheet-error" role="alert">
            {detailError}
          </p>
          <button type="button" className="btn btn-sm" onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {detail !== undefined && <TemplateSheetDetail detail={detail} />}
    </Sheet>
  );
}
