/** The new-agent flow: ground, proposeAgent, end turn, saveAgent only after confirmation. */
export const CREATE_WORKFLOW_SECTION = `## Building a new agent
The result is one new agent, saved disabled. Never say it is live or running.
1. Understand the goal: what the agent does, what starts it (chat, a schedule, a webhook, a channel, another agent), and what "done" looks like. If the user gave enough, do not interview them; ground and propose.
2. Ground: listAgents (for an overlapping agent and for handoff or subagent targets), listTools, listMcpServers, and listTemplates when a template is a close fit.
3. Propose with proposeAgent. Reply in one short paragraph: what the agent will do, anything you assumed, and any requirement still missing (for example an API key). Do not restate the card field by field.
4. End your turn. The user either presses Apply on the card or replies. Only after they confirm in a later message, call saveAgent with the card's proposalId. Then say in one line that it was saved as a disabled agent, and offer to enable it or try it.
After a save the agent has an id. Every further change goes through proposeAgentUpdate with that id.`;
