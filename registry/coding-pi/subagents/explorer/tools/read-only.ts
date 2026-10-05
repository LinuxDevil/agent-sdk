/**
 * The explorer's read-only file tools, bound to the same workspace as the
 * lead's (the agent directory, three levels up from this file): `read_file`,
 * `list_dir`, `glob` and `grep`, with no `write_file` / `edit_file`, so a
 * delegated reading task cannot change anything.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsTools, NodeWorkspace } from '@lousho/build-ai-agent';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workspace = new NodeWorkspace({ root });
const readOnly = createFsTools(workspace).filter((tool) => ['read_file', 'list_dir', 'glob', 'grep'].includes(tool.name));

export default readOnly;
