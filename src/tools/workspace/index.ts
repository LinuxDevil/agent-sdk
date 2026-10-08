/**
 * Workspace tools (LOU-X6): file system and shell tools over pluggable
 * providers. See docs/workspace-tools.md for the security model.
 */
export type {
  FsProvider,
  ShellProvider,
  ShellExecOptions,
  ShellExecResult,
  Workspace,
  WorkspaceDirEntry,
  WorkspaceEntryType,
  WorkspaceStat,
} from './types';
export { WorkspaceError, normalizeWorkspacePath } from './paths';
export { NodeWorkspace, type NodeWorkspaceOptions } from './NodeWorkspace';
export {
  MemoryWorkspace,
  type MemoryExecCall,
  type MemoryExecHandler,
  type MemoryExecReply,
  type MemoryWorkspaceOptions,
} from './MemoryWorkspace';
export { SandboxShell, type SandboxShellOptions } from './SandboxShell';
export {
  createFsTools,
  type FsToolApprovals,
  type FsToolArgs,
  type FsToolName,
  type FsToolsOptions,
} from './fsTools';
export {
  WorkspaceCheckpoints,
  MemoryWorkspaceCheckpointStore,
  type RewindResult,
  type WorkspaceCheckpointStore,
  type WorkspaceCheckpointsOptions,
  type WorkspaceFileBackup,
} from './checkpoints';
export { FileWorkspaceCheckpointStore } from './checkpointFileStore';
export { createShellTool, type CommandPattern, type CommandRule, type ShellToolOptions, type ShellToolResult } from './shellTool';
