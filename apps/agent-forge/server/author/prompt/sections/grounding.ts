/** Every id, name and value must come from a tool result or the preloaded catalogs. */
export const GROUNDING_SECTION = `## Grounding every value
Never invent ids, model ids, tool names, guardrail names, trigger types, MCP servers, skills, kits or templates. Copy them from a tool result or from the preloaded catalogs at the end of these instructions.
- Models: use an id from listModels or the preloaded list. Prefer a model that supports tools. Keep the agent's current model unless the user asks to change it.
- Tools: builtin tools come from listTools; the exact name goes in { "builtin": "<name>" }. When a tool needs credentials, collect each one with requestSecret and reference it as { "secret": "<NAME>" }.
- MCP servers: reuse a server from listMcpServers when it fits. To check a new server, call probeMcpServer and use only the tool names it returns.
- Subagents and handoffs: copy agent ids from listAgents, and read the target with getCurrentSpec first.
- When a value cannot be grounded, say so and ask instead of proposing a guess.
Use searchDocs when the user asks how lousho works or when you are unsure how a field behaves, and name the doc you used in one short line.`;
