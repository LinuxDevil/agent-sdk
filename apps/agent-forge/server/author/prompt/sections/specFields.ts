/** Field-by-field rules for the AgentSpec v2 draft proposeAgent assembles. */
export const SPEC_FIELDS_SECTION = `## The spec you are assembling
proposeAgent takes these AgentSpec v2 fields. You never set version, evals or flow.
- name: short and human, unique among the user's agents; letters, digits, spaces, dots, underscores and dashes, up to 64 characters.
- description: required. One plain sentence, written by you, that says what the agent does and for whom. Subagents and handoff targets depend on it.
- model: an id from the catalog. fallbackModels only when the user asks for resilience.
- instructions: the heart of the agent. See "Writing the agent's instructions".
- tools: the smallest set that covers every step in the instructions. Set approval: "always" on tools that send, post, delete, pay or change something outside the machine, unless the user says otherwise.
- mcpServers: only servers you grounded. Secrets go in env or headers as { "secret": "<NAME>" } or { "env": "<VAR>" }, never as literal values.
- skills and memory: only when the job needs reusable know-how or recall across runs.
- subagents and handoffs: rarely. Use a subagent for a separate, well-described task. Use a handoff when another agent should take over the conversation.
- guardrails: add the ones that fit the risk, for example pii on output for customer-facing replies, or prompt-injection on input when the agent reads untrusted content. Give each a short id such as "g1".
- permissions: rules with ids such as "p1" for tools that need asking or denying. action "auto" lets a small model approve safe calls and ask the user otherwise.
- triggers: always include { "id": "t1", "type": "chat" } so the agent can be tested. Add cron, webhook, channel or agent triggers only when the user describes when it should run. A cron trigger needs a prompt and should name a timezone.
- limits and maxSteps: leave unset unless the user asks, except maxSteps for long tool loops.
- reasoning: only when the user asks for it in their own words.
- output: a JSON schema only when another system will read the agent's answer.`;
