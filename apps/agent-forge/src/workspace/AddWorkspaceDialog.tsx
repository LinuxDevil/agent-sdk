import { useState, type FormEvent } from 'react';

import type { WorkspaceListItem } from '../../shared/wireTypes';
import { runtimeClient, RuntimeApiError } from '../runtime/runtimeClient';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';
import { Input } from '../ui/controls';

export interface AddWorkspaceDialogProps {
  open: boolean;
  onClose(): void;
  onAdded(item: WorkspaceListItem): void;
}

/**
 * "Add workspace → folder path" (W05a): a small dialog that registers a
 * project folder with `POST /workspaces`. The path goes in the request
 * body, never a URL. A 400/409's server `error` text becomes the field
 * error; success hands the new item to `onAdded`.
 */
export function AddWorkspaceDialog({ open, onClose, onAdded }: AddWorkspaceDialogProps): JSX.Element | null {
  const [root, setRoot] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);

  const close = () => {
    setRoot('');
    setError(undefined);
    setPending(false);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const path = root.trim();
    if (path === '') {
      setError('Enter a folder path.');
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const item = await runtimeClient.addWorkspace(path);
      close();
      onAdded(item);
    } catch (err) {
      setError(err instanceof RuntimeApiError ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add workspace"
      description="Studio shows the agents in a project folder. Paste the folder's full path."
      size="md"
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={pending}>
            Cancel
          </button>
          <button type="submit" form="add-workspace-form" className="btn btn-primary" disabled={pending}>
            {pending ? 'Adding…' : 'Add workspace'}
          </button>
        </>
      }
    >
      <form id="add-workspace-form" onSubmit={(e) => void submit(e)}>
        <Field
          label="Folder path"
          hint="For example /home/me/support-bot or C:\\code\\support-bot."
          error={error}
        >
          <Input
            autoFocus
            placeholder="/path/to/project"
            spellCheck={false}
            autoComplete="off"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
