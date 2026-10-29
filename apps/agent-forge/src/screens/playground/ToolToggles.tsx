import { useEffect, useState } from 'react';
import { Wrench } from 'lucide-react';

import type { AgentStoreEntry } from '../../persistence/AgentStore';
import { runtimeClient } from '../../runtime/runtimeClient';

/** The saved agents (`GET /agents`); empty until they load, or when the server cannot say. */
function useAgentEntries(): AgentStoreEntry[] {
  const [agents, setAgents] = useState<AgentStoreEntry[]>([]);
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

/** Pick an agent to borrow its tools, then toggle each one; `onChange` gets the enabled tool names. */
export function ToolToggles({ tools, onChange }: { tools: string[]; onChange: (tools: string[]) => void }) {
  const agents = useAgentEntries();
  const [agentId, setAgentId] = useState('');
  const toolsOf = (id: string) => agents.find((a) => a.id === id)?.spec.tools ?? [];
  const available = toolsOf(agentId);

  const pick = (id: string) => {
    setAgentId(id);
    onChange(toolsOf(id));
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
              {`Tools of ${a.spec.name || a.id}`}
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
                  className="pg-switch"
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
