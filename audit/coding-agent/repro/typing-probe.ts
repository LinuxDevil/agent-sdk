// Typing probe: calling workspace tools directly, as a harness/test would. `npx tsc --noEmit -p .` from audit/.
import { createFsTools, createShellTool, MemoryWorkspace } from '@lousho/build-ai-agent';
const ws = new MemoryWorkspace({ files: { 'a.txt': 'x' } });
const [readFile] = createFsTools(ws);
const shell = createShellTool(ws, { needsApproval: false });
export const a = await readFile.execute({ path: "a.txt" }, {} as never);           // what type is the result?
export const b = await shell.execute({ command: "ls" }, {} as never);               // ShellToolResult?
// @ts-expect-error -- F14: the shell result is typed `unknown`, so `.exitCode` does not type-check
export const exit: number | null = b.exitCode;
export const bad = await readFile.execute({ nope: 1 }, {} as never); // F14: compiles - args are untyped
