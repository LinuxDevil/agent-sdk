/**
 * Shared test fixture: the `InProcessAgentHost` RunManager's `host` option
 * needs after D12b, built over fresh file stores under `baseDir`. The
 * file-backed stores are stateless, so the host's pair and a test's own
 * `new FileCheckpointStore(baseDir)`/`new FileApprovalStore(baseDir)` hit
 * the same on-disk state even as separate instances.
 */
import { InProcessAgentHost } from '../host/inProcessAgentHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import type { SecretsStore } from '../secretsStore';

export function newTestHost(baseDir: string, secretsStore?: SecretsStore): InProcessAgentHost {
  return new InProcessAgentHost({
    baseDir,
    checkpointStore: new FileCheckpointStore(baseDir),
    approvalStore: new FileApprovalStore(baseDir),
    secretsStore,
  });
}
