// api-overview.md:286
import { loadMcpTools, type SkippedMcpTool } from '@lousho/build-ai-agent/mcp';

const skipped: SkippedMcpTool[] = [];
const tools = await loadMcpTools(mcpClient, 'my-server', {
  logger: console,
  onSkip: (tool) => skipped.push(tool), // { name, reason }
});
export {};
