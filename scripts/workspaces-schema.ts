import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderWorkspaceSchemas } from './workspacesSchema';

const SCHEMAS_DIR = path.resolve(__dirname, '..', 'schemas');

function isStale(file: string, content: string): boolean {
  const target = path.join(SCHEMAS_DIR, file);
  return !fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content;
}

function main(): void {
  const outputs = renderWorkspaceSchemas();
  if (process.argv.includes('--check')) {
    const stale = Object.entries(outputs).filter(([file, content]) => isStale(file, content));
    if (stale.length > 0) {
      console.error(`schemas are stale: run npm run workspaces:schema (out of date: ${stale.map(([file]) => file).join(', ')})`);
      process.exit(1);
    }
    return;
  }
  fs.mkdirSync(SCHEMAS_DIR, { recursive: true });
  for (const [file, content] of Object.entries(outputs)) fs.writeFileSync(path.join(SCHEMAS_DIR, file), content);
}

main();
