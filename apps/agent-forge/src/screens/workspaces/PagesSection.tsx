import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { PageDetail } from 'lousho/workspaces/client';
import { ConfirmDialog, Dialog } from '../../ui/Dialog';
import { EmptyState } from '../../ui/EmptyState';
import { Field } from '../../ui/Field';
import { Input, Textarea } from '../../ui/controls';
import { onRovingKeyDown } from '../rovingKeys';
import { useWorkspace } from './WorkspaceContext';
import { useWorkspacesClient } from './workspacesClient';
import type { MainHarness } from './workspaceTypes';

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function useAddPage(open: boolean) {
  const { ops } = useWorkspace();
  const [pageId, setPageId] = useState('');
  const [pageName, setPageName] = useState('');
  const [pageDescription, setPageDescription] = useState('');
  const [pageAgent, setPageAgent] = useState('agent');

  useEffect(() => {
    if (!open) return;
    setPageId('');
    setPageName('');
    setPageDescription('');
    setPageAgent('agent');
  }, [open]);

  const idError = pageId !== '' && !KEBAB.test(pageId) ? 'Use kebab-case, e.g. tiktok-videos' : undefined;
  const canCreate =
    pageId !== '' && idError === undefined && pageName.trim() !== '' && pageDescription.trim() !== '' && pageAgent.trim() !== '' && !ops.pending;

  const create = async (): Promise<boolean> => {
    const view = await ops.send([
      {
        op: 'create_page',
        page: pageId,
        name: pageName,
        description: pageDescription,
        execution: { type: 'single', single: { agent: pageAgent } },
      },
    ]);
    return view !== undefined;
  };

  return { pageId, setPageId, pageName, setPageName, pageDescription, setPageDescription, pageAgent, setPageAgent, idError, canCreate, create };
}

function AddPageDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const form = useAddPage(open);
  const submit = async () => {
    if (await form.create()) onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add page"
      size="sm"
      description="Creates a single-agent page; the draft shows PRD018 until an agent with that alias is attached (P2.8)."
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!form.canCreate} onClick={() => void submit()}>
            Create
          </button>
        </>
      }
    >
      <div className="ws-add-fields">
        <Field id="add-page-id" label="Id" required error={form.idError} hint="Kebab-case; becomes the pages/ folder name.">
          <Input value={form.pageId} onChange={(event) => form.setPageId(event.target.value)} />
        </Field>
        <Field id="add-page-name" label="Name" required>
          <Input value={form.pageName} onChange={(event) => form.setPageName(event.target.value)} />
        </Field>
        <Field id="add-page-description" label="Description" required hint="The main agent routes on this">
          <Textarea value={form.pageDescription} onChange={(event) => form.setPageDescription(event.target.value)} />
        </Field>
        <Field id="add-page-agent" label="First agent alias" required hint="The page runs as a single agent with this alias.">
          <Input value={form.pageAgent} onChange={(event) => form.setPageAgent(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

interface PageRowProps {
  page: PageDetail;
  index: number;
  count: number;
  pending: boolean;
  onMove(index: number, delta: -1 | 1): void;
  onRemove(page: PageDetail): void;
}

function PageRow({ page, index, count, pending, onMove, onRemove }: PageRowProps) {
  const name = page.manifest.name;
  return (
    <li className="ws-page">
      <div className="ws-page-info">
        <span className="ws-page-name">{name}</span>
        <code className="ws-page-id">{page.id}</code>
        <span className="ws-page-desc">{page.manifest.description}</span>
        <span className="ws-page-type">{page.manifest.execution.type}</span>
      </div>
      <span className="ws-page-actions dt-actions">
        <button
          type="button"
          className="btn btn-sm"
          data-roving
          aria-label={`Move ${name} up`}
          title={`Move ${name} up`}
          disabled={index === 0 || pending}
          onClick={() => onMove(index, -1)}
        >
          <ArrowUp size={14} strokeWidth={1.75} aria-hidden="true" />
          Move up
        </button>
        <button
          type="button"
          className="btn btn-sm"
          aria-label={`Move ${name} down`}
          title={`Move ${name} down`}
          disabled={index === count - 1 || pending}
          onClick={() => onMove(index, 1)}
        >
          <ArrowDown size={14} strokeWidth={1.75} aria-hidden="true" />
          Move down
        </button>
        <button
          type="button"
          className="btn btn-sm"
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
          disabled={pending}
          onClick={() => onRemove(page)}
        >
          <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
          Remove
        </button>
      </span>
    </li>
  );
}

function PagesList({
  pages,
  pending,
  onMove,
  onRemove,
}: {
  pages: PageDetail[];
  pending: boolean;
  onMove(index: number, delta: -1 | 1): void;
  onRemove(page: PageDetail): void;
}) {
  return (
    <ul className="ws-pages" onKeyDown={onRovingKeyDown}>
      {pages.map((page, index) => (
        <PageRow key={page.id} page={page} index={index} count={pages.length} pending={pending} onMove={onMove} onRemove={onRemove} />
      ))}
    </ul>
  );
}

function RemovePageDialog({ page, onClose }: { page: PageDetail | undefined; onClose(): void }) {
  const { workspace, ops } = useWorkspace();
  const client = useWorkspacesClient();
  const [mainHarness, setMainHarness] = useState<MainHarness | undefined>(undefined);

  useEffect(() => {
    setMainHarness(undefined);
    if (page === undefined) return;
    let cancelled = false;
    void client
      .call('getMainHarness', { params: { id: workspace.id } })
      .then((view) => {
        if (!cancelled) setMainHarness(view.harness);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, workspace.id, page]);

  const routesToPage = page !== undefined && (mainHarness?.routes?.some((route) => route.page === page.id) ?? false);
  const confirm = () => {
    if (page !== undefined) void ops.send([{ op: 'remove_page', page: page.id }]);
    onClose();
  };

  return (
    <ConfirmDialog
      open={page !== undefined}
      title={page === undefined ? 'Remove page?' : `Remove “${page.manifest.name}”?`}
      description={
        page === undefined ? (
          ''
        ) : (
          <>
            This deletes <code>pages/{page.id}/</code> — page.json, harness/, agents.json, ui/ and resources/.
            {routesToPage ? ' The main harness routes to this page; that route will need fixing (PRD015).' : ''}
          </>
        )
      }
      confirmLabel="Remove page"
      pending={ops.pending}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}

export function PagesSection() {
  const { workspace, ops } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PageDetail | undefined>(undefined);
  const pages = workspace.pages;

  const move = (index: number, delta: -1 | 1) => {
    const ids = pages.map((page) => page.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    void ops.send([{ op: 'reorder_pages', pages: ids }]);
  };

  return (
    <section className="ws-pages-section" aria-label="Pages">
      {pages.length > 0 ? (
        <div className="ws-pages-head">
          <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
            Add page
          </button>
        </div>
      ) : null}
      {pages.length === 0 ? (
        <EmptyState
          title="No pages yet"
          action={
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              Add page
            </button>
          }
        />
      ) : (
        <PagesList pages={pages} pending={ops.pending} onMove={move} onRemove={setRemoving} />
      )}
      <AddPageDialog open={adding} onClose={() => setAdding(false)} />
      <RemovePageDialog page={removing} onClose={() => setRemoving(undefined)} />
    </section>
  );
}
