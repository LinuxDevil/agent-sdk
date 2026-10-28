import { useState, type ReactNode } from 'react';
import { readStored, writeStored } from './storedValue';

/** localStorage key prefix of each section's open/closed state (`forge.inspector.<id>`). */
const INSPECTOR_SECTION_KEY_PREFIX = 'forge.inspector.';

/**
 * A collapsible Inspector section: a header button (`aria-expanded`) over a
 * body that stays mounted while hidden. Sections start open, and each one's
 * open/closed state is remembered per viewer under `forge.inspector.<id>`.
 */
export function InspectorSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const key = `${INSPECTOR_SECTION_KEY_PREFIX}${id}`;
  const [open, setOpen] = useState(() => readStored(key) !== 'closed');
  const bodyId = `inspector-section-${id}`;

  function toggle() {
    setOpen(!open);
    writeStored(key, open ? 'closed' : 'open');
  }

  return (
    <section className="inspector-section">
      <h2 className="inspector-section-head">
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
          <span className="inspector-section-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          {title}
        </button>
      </h2>
      <div className="inspector-section-body" id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
