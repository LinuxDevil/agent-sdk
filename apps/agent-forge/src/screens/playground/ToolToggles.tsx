import { useEffect, useState } from 'react';
import { Wrench } from 'lucide-react';

import type { AgentListItem, AgentRecord } from '../../../shared/wireTypes';
import { toolNodeName } from '../../graph/v2/nodeIds';
import { runtimeClient } from '../../runtime/runtimeClient';

/** The saved agents (`GET /agents`); empty until they load, or when the server cannot say. */
function useAgentEntries(): AgentListItem[] {
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  useEffect(() => {
    let live = true;
    runtimeClient.listAgents().then(
      (list) => {
        if (live) setAgents(list);
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, []);
  return agents;
}

/** The selected agent's tool names, loaded on demand from `GET /agents/:id`. */
function useAgentTools(agentId: string): { record: AgentRecord | undefined; names: string[] } {
  const [record, setRecord] = useState<AgentRecord | undefined>(undefined);
  useEffect(() => {
    if (!agentId) return;
    let live = true;
    runtimeClient.loadAgent(agentId).then(
      (r) => {
        if (live) setRecord(r);
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [agentId]);
  return { record, names: agentId ? (record?.spec.tools ?? []).map(toolNodeName) : [] };
}

/** Pick an agent to borrow its tools, then toggle each one; `onChange` gets the enabled tool names. */
export function ToolToggles({ tools, onChange }: { tools: string[]; onChange: (tools: string[]) => void }) {
  const agents = useAgentEntries();
  const [agentId, setAgentId] = useState('');
  const { names: available } = useAgentTools(agentId);

  const pick = (id: string) => {
    setAgentId(id);
    // The toggles pre-check what the borrowed agent already enables once its record arrives.
    if (!id) {
      onChange([]);
      return;
    }
    runtimeClient.loadAgent(id).then(
      (record) => onChange((record?.spec.tools ?? []).map(toolNodeName)),
      () => undefined
    );
  };
  const toggle = (name: string, on: boolean) => onChange(on ? [...tools, name] : tools.filter((t) => t !== name));

  return (
    <fieldset className="pg-tools">
      <legend className="pg-section-title overline">Tools</legend>
      <label className="pg-field">
        <span className="visually-hidden">Tools from agent</span>
        <select className="select" value={agentId} onChange={(e) => pick(e.target.value)}>
          <option value="">No tools</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {`Tools of ${a.name || a.id}`}
            </option>
          ))}
        </select>
      </label>
      {!agentId && <p className="pg-hint">Borrow the tools of a saved agent, then switch each one on or off.</p>}
      {agentId && available.length === 0 && <p className="pg-hint">This agent has no tools.</p>}
      {available.length > 0 && (
        <ul className="pg-tool-list">
          {available.map((name) => (
            <li key={name}>
              <label className="pg-tool-row">
                <Wrench aria-hidden="true" size={14} strokeWidth={1.75} />
                <span className="pg-tool-name" title={name}>
                  {name}
                </span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={tools.includes(name)}
                  onChange={(e) => toggle(name, e.target.checked)}
                />
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
