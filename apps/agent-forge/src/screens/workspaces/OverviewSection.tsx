import { useState } from 'react';
import workspaceJsonSchema from '../../../../../schemas/lousho.workspace.v1.json';
import type { ProblemView } from 'lousho/workspaces/client';
import { SchemaForm } from '../../ui/schemaForm/SchemaForm';
import type { JsonSchema } from '../../ui/schemaForm/types';
import { useWorkspace } from './WorkspaceContext';
import type { AuthoringOp, WorkspaceManifest } from './workspaceTypes';

const IDENTITY = ['name', 'version', 'description', 'domain'] as const;
type IdentityKey = (typeof IDENTITY)[number];
const OPTIONAL: ReadonlySet<IdentityKey> = new Set(['domain']);

const schema = workspaceJsonSchema as JsonSchema;
const HIDDEN_KEYS = Object.keys(schema.properties ?? {}).filter((key) => !(IDENTITY as readonly string[]).includes(key));

function pickIdentity(manifest: WorkspaceManifest): Record<string, unknown> {
  return Object.fromEntries(IDENTITY.map((key) => [key, manifest[key]] as const).filter(([, value]) => value !== undefined));
}

function errorsFor(problems: ProblemView[]): Record<string, string> {
  return Object.fromEntries(
    problems
      .filter((problem) => problem.file === 'workspace.json')
      .map((problem) => [problem.path, `${problem.code}: ${problem.message}`]),
  );
}

export function OverviewSection() {
  const { workspace, ops } = useWorkspace();
  const [form, setForm] = useState(() => ({ revision: workspace.revision, value: pickIdentity(workspace.manifest) }));
  if (form.revision !== workspace.revision) {
    setForm({ revision: workspace.revision, value: pickIdentity(workspace.manifest) });
  }
  const { value } = form;
  const manifest = workspace.manifest as unknown as Record<string, unknown>;
  const changed = IDENTITY.filter((key) => value[key] !== manifest[key]);

  const save = () => {
    const opsToSend: AuthoringOp[] = [];
    for (const key of IDENTITY) {
      const next = value[key];
      if (next === manifest[key]) continue;
      if (OPTIONAL.has(key) && (next === undefined || next === '')) opsToSend.push({ op: 'set_workspace_field', field: key });
      else opsToSend.push({ op: 'set_workspace_field', field: key, value: next });
    }
    if (opsToSend.length > 0) void ops.send(opsToSend);
  };

  return (
    <section className="ws-overview" aria-label="Overview">
      <SchemaForm
        schema={schema}
        value={value}
        onChange={(next) => setForm((current) => ({ ...current, value: next as Record<string, unknown> }))}
        idPrefix="ws-overview"
        hiddenKeys={HIDDEN_KEYS}
        errors={errorsFor(ops.problems)}
      />
      <div className="ws-overview-actions">
        <button type="button" className="btn btn-primary" disabled={changed.length === 0 || ops.pending} onClick={save}>
          Save
        </button>
      </div>
    </section>
  );
}
