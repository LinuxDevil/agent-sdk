import { useEffect, useState } from 'react';
import type { CodeAgentDir } from '../../../shared/wireTypes';
import { runtimeClient } from '../../runtime/runtimeClient';

/**
 * X06b: the workspace's code-defined agent directories (`GET
 * /workspace/agent-dirs`, X06a). A failed request hides the section
 * silently - logged, never an error state on the agents list.
 */
export function useCodeAgentDirs(): CodeAgentDir[] {
  const [dirs, setDirs] = useState<CodeAgentDir[]>([]);
  useEffect(() => {
    let cancelled = false;
    runtimeClient
      .listCodeAgents()
      .then((list) => {
        if (!cancelled) setDirs(list);
      })
      .catch((error: unknown) => {
        console.warn('Could not list code agents', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return dirs;
}
