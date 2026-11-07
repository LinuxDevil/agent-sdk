import { Bot } from 'lucide-react';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { useAppState } from '../../state/AppState';
import { EmptyState } from '../../ui/EmptyState';
import { agentTabPath } from '../agents/agentTabs';
import './agentList.css';

/**
 * `#/agents` - the agents list. A placeholder until A02 builds the real card
 * grid: an EmptyState for a workspace without agents, else a plain list of
 * links into each agent's overview tab (which redirects to canvas until A05).
 */
export function AgentListScreen() {
  const { agents, agentsLoaded } = useAppState();
  return (
    <>
      <ScreenHeader title="Agents" description="Every agent in this workspace." />
      <div className="agent-list-screen">
        {agentsLoaded && agents.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            hint="Open the builder to make your first agent."
            action={
              <a className="btn btn-primary" href="#/agents/untitled-agent/canvas">
                Open the builder
              </a>
            }
          />
        ) : (
          <ul className="agent-list-placeholder">
            {agents.map((agent) => (
              <li key={agent.id}>
                <a href={`#${agentTabPath(agent.id, 'overview')}`}>{agent.name || agent.id}</a>{' '}
                <span>{agent.id}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
