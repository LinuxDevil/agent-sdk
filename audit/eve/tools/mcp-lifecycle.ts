// Repro: stdio lifecycle on Windows via `npx` shim (docs example form), crash -> status, orphan check.
// Run: cd E:\agent-sdk\audit && npx tsx eve/tools/mcp-lifecycle.ts
import { connectMcp } from '@lousho/build-ai-agent/mcp';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, 'mcp-evil-server.mjs');

function serverProcs(): string[] {
  const out = execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*mcp-evil-server.mjs*' -and $_.CommandLine -notlike '*Get-CimInstance*' } | ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.Name }"`,
    { encoding: 'utf8' }
  );
  return out.split(/\r?\n/).filter(Boolean);
}

const mcp = await connectMcp({ evil: { command: 'npx', args: ['--no-install', 'tsx', serverPath], stderr: 'capture' } });
console.log('connected via npx shim; status', mcp.status());
console.log('server-related processes while open:', serverProcs());
await mcp.close();
await new Promise((r) => setTimeout(r, 3000));
console.log('status after close', mcp.status());
const left = serverProcs();
console.log('processes left 3s after close():', left);
for (const p of left) execSync(`taskkill /F /PID ${p.split(' ')[0]}`, { stdio: 'ignore' });
