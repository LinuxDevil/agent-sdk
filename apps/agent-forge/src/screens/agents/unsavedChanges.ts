/**
 * The builder's one unsaved-changes prompt, shared by switching agents and
 * leaving the Agents screen. True when there is nothing unsaved, or the user
 * agrees to go on without it.
 */
export function confirmDiscardChanges(dirty: boolean, agentId: string): boolean {
  if (!dirty) return true;
  return window.confirm(`'${agentId}' has unsaved changes that haven't reached the workspace yet. Leave without saving?`);
}
