import { agentTabPath } from '../agents/agentTabs';
import { Card } from '../../ui/Card';
import { useAgentDetail } from './AgentDetailContext';
import './agentOverview.css';

/** Lines of the instructions string the Overview card shows before the "N more lines" note. */
const INSTRUCTIONS_LINES = 12;

/**
 * The Overview tab's first card (A05; A06 adds the rest of the tab): the
 * agent's instructions as the spec carries them - a `{ file }` reference
 * names its prompt file, a string shows its first lines with the overflow
 * counted.
 */
export function AgentOverviewTab() {
  const { record } = useAgentDetail();
  const instructions = record.spec.instructions;
  const editHref = `#${agentTabPath(record.id, 'canvas')}`;
  const lines = typeof instructions === 'string' ? instructions.split('\n') : [];
  const shown = lines.slice(0, INSTRUCTIONS_LINES);
  const hidden = lines.length - shown.length;

  return (
    <div className="agent-overview">
      <Card
        title="Instructions"
        actions={
          <a className="btn btn-sm btn-ghost" href={editHref}>
            Edit on canvas
          </a>
        }
      >
        {typeof instructions === 'string' ? (
          <>
            <pre className="agent-overview-instructions">{shown.join('\n')}</pre>
            {hidden > 0 && <p className="agent-overview-more">{`${hidden} more lines`}</p>}
          </>
        ) : (
          <p>
            Loaded from <code>{instructions.file}</code>
          </p>
        )}
      </Card>
    </div>
  );
}
