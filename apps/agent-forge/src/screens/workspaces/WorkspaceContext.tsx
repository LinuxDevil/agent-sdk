import { createContext, useContext } from 'react';
import type { DraftView, ProblemView, WorkspaceDetail } from '@linuxdevil/lousho/workspaces/client';
import type { OpsSender } from './useWorkspaceOps';

export interface WorkspaceContextValue {
  workspace: WorkspaceDetail;
  problems: ProblemView[];
  drafts: DraftView[];
  ops: OpsSender;
  refresh(): void;
  openChat(focus?: { pageId?: string }): void;
  openDraft(): void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (context === null) throw new Error('useWorkspace needs a workspace route');
  return context;
}
