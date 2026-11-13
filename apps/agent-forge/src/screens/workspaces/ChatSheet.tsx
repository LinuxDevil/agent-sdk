import { EmptyState } from '../../ui/EmptyState';
import { Sheet } from '../../ui/Sheet';

export interface ChatSheetProps {
  open: boolean;
  focus?: { pageId?: string };
  onClose(): void;
}

export function ChatSheet({ open, focus, onClose }: ChatSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Authoring chat"
      description={focus?.pageId ? `Page in focus: ${focus.pageId}` : undefined}
    >
      <EmptyState
        title="The authoring chat is not built yet"
        hint="It lands with P2.19. Until then, edit with the forms on each tab."
      />
    </Sheet>
  );
}
