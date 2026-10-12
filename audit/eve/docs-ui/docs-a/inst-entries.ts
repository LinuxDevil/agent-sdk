// installation.md:139-159 — every entry and the names the table says it holds
const table: Record<string, string[]> = {
  '': ['createAgent','defineTool','defineChannel','memoryStore','fileStore','SDKError','HookRegistry','globalToolRegistry','MissingPeerDependencyError','resolveProvider'],
  '/executor': ['AgentExecutor','AgentBuilder','resumeAfterApproval','streamResumeAfterApproval','resumeRequest','ToolRegistry','globalToolRegistry'],
  '/tools': ['defineTool','ToolRegistry','httpTool','currentDateTool','loadMcpTools'],
  '/flows': ['FlowBuilder','FlowExecutor','validateFlow'],
  '/integrations': ['createJiraTools','createGitHubTools','createSlackTool','slackTool','postSlackAlert','createEmailTool'],
  '/utils': ['EncryptionUtils','sha256','generatePassword','StorageService','StorageServiceApprovalStore','LocalStorageCheckpointStore','validateWithSchema','isValidEmail'],
  '/mcp': ['connectMcp','loadMcpTools','serveMcp'],
  '/types': [],
  '/testing': ['mockModel','recordReplay','hashEmbedder'],
  '/otel': ['createOtelTraceExporter'],
  '/hooks': ['HookRegistry'],
  '/sqlite': ['SqliteStore','sqliteMemory','sqliteVectorMemory'],
  '/auth': ['routeAuth','jwt','oidc','basic','apiToken','anonymous'],
  '/kv': ['KVStore','KVCheckpointStore'],
  '/traces': ['fileTraceExporter','listTraces','readTrace'],
  '/triggers': ['WebhookTriggerAdapter','SlackTriggerAdapter','CronTriggerAdapter','TriggerRegistry'],
  '/react': ['useLoushoAgent','reduceAgentEvents','parseEventStream'],
  '/vue': ['useLoushoAgent'],
  '/svelte': ['loushoAgent'],
};
for (const [sub, names] of Object.entries(table)) {
  try {
    const m: any = await import('@lousho/build-ai-agent' + sub);
    const missing = names.filter((n) => !(n in m));
    console.log(sub || '.', missing.length ? 'MISSING ' + missing.join(',') : 'ok');
  } catch (e: any) { console.log(sub || '.', 'IMPORT FAIL', e.code, String(e.message).slice(0, 200)); }
}
// same class across entries
const root: any = await import('@lousho/build-ai-agent');
const hooks: any = await import('@lousho/build-ai-agent/hooks');
const ex: any = await import('@lousho/build-ai-agent/executor');
console.log('HookRegistry same:', root.HookRegistry === hooks.HookRegistry, 'globalToolRegistry same:', root.globalToolRegistry === ex.globalToolRegistry);
