/**
 * Click/keyboard equivalents of the palette's drag-and-drop (C18): adding an
 * entry at the viewport centre through the same `addNode` mutation a canvas
 * drop uses, with the same `unavailable` refusal. Moved out of LeftRail so
 * the palette components (`NodePalette`) own it.
 */
import { useState } from 'react';
import { useStoreApi } from '@xyflow/react';
import { useAppState } from '../../state/AppState';
import { addNode, ownerForNewNode } from '../../graph/v2/mutations';
import { positionFor } from '../../graph/v2/reown';
import { viewportCentrePosition } from '../paletteActions';
import type { PaletteEntry } from '../kinds';
import { paletteOwnerTitle } from './paletteModel';

/**
 * `addAtViewportCentre(entry)` adds the entry's node at the centre of the
 * visible canvas, selects it and reports the outcome in `notice` (a
 * `role="status"` line): the `unavailable` reason on refusal, else
 * "Added <label> to <owner title>.".
 */
export function usePaletteActions() {
  const { graph, setGraph, selectedNodeId, setSelectedNodeId } = useAppState();
  const flow = useStoreApi();
  const [notice, setNotice] = useState<string | undefined>(undefined);

  function addAtViewportCentre(entry: PaletteEntry) {
    const { transform, width, height } = flow.getState();
    const position = viewportCentrePosition(transform, width, height);
    const owner = ownerForNewNode(graph, entry.kind, selectedNodeId);
    // Same refusal the drop applies: an `unavailable` entry cannot be added for this owner.
    const reason = entry.unavailable?.(graph, owner);
    if (reason !== undefined) {
      setNotice(reason);
      return;
    }
    // A selected group owns the new node - its position must be group-relative.
    const { graph: next, nodeId } = addNode(graph, entry.create(graph, owner), positionFor(graph, position, owner), owner);
    setGraph(() => next);
    setSelectedNodeId(nodeId);
    setNotice(`Added ${entry.label} to ${paletteOwnerTitle(graph, owner)}.`);
  }

  return { notice, addAtViewportCentre };
}
