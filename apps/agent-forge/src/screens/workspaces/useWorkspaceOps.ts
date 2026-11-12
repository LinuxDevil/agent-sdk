import { useCallback, useState } from 'react';
import { WorkspaceApiError, type ApplyOpsView, type ProblemView } from 'lousho/workspaces/client';
import { useToast } from '../../ui/Toast';
import { useWorkspacesClient } from './workspacesClient';
import type { AuthoringOp } from './workspaceTypes';

// fallow-ignore-next-line unused-export -- contract surface: the 409 copy the workspace screens and later tickets assert on.
export const STALE_MESSAGE = 'This workspace changed since you opened it. The latest version is loaded.';

export interface OpsSender {
  send(ops: AuthoringOp[]): Promise<ApplyOpsView | undefined>;
  pending: boolean;
  problems: ProblemView[];
  draftId: string | undefined;
}

export function useWorkspaceOps(workspaceId: string, revision: string | undefined, onChanged: () => void): OpsSender {
  const client = useWorkspacesClient();
  const toast = useToast();
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [problems, setProblems] = useState<ProblemView[]>([]);
  const send = useCallback(
    async (ops: AuthoringOp[]) => {
      if (revision === undefined || ops.length === 0) return undefined;
      setPending(true);
      try {
        const view = await client.call('applyOps', {
          params: { id: workspaceId },
          body: { expectedRevision: revision, ops, ...(draftId !== undefined && { draftId }) },
        });
        setDraftId(view.draftId);
        setProblems(view.problems);
        onChanged();
        return view;
      } catch (error) {
        if (error instanceof WorkspaceApiError && error.status === 409) {
          setDraftId(undefined);
          toast.show({ message: STALE_MESSAGE, tone: 'warning' });
          onChanged();
          return undefined;
        }
        toast.show({
          message: 'Could not save the change',
          description: error instanceof Error ? error.message : String(error),
          tone: 'error',
        });
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [client, draftId, onChanged, revision, toast, workspaceId],
  );
  return { send, pending, problems, draftId };
}
