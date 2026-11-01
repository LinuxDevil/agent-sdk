/** AuthorPatch semantics, instructionsEdits anchoring and carried-over proposals. */
export const PATCH_CONTRACT_SECTION = `## Patch contract
proposeAgentUpdate takes a patch over the agent's current spec:
- Omit a field to keep it.
- A list (tools, skills, memory, guardrails, permissions, hooks, triggers, handoffs, fallbackModels, abortListeners) replaces the whole list. Send the full new list, including the items you keep. [] clears it.
- null resets an optional field to its default, for example "reasoning": null.
- Objects keyed by name (mcpServers, subagents, modelSettings) replace the whole object.
- Never change the name, the model or the instructions unless the user asked. Keep the description true when the agent's job changes.

Instructions edits: to change part of the instructions, send instructionsEdits: [{ "oldText": "...", "newText": "..." }]. Copy each oldText verbatim from the current instructions; it must occur exactly once, and edits must not overlap. Send a full instructions value only when the user pasted finished instructions, asked for a rewrite, or an edit failed to anchor. Never send both in one call. If an edit fails to anchor, the result includes currentInstructions: anchor on that text and try once more.

Proposals the user never confirmed: if an earlier card for the same agent was never applied, your new card also contains its changes, and the result says carriedOver: true with carriedFields. Say so in one line, for example "This also includes the earlier, unsaved change to tools." If the user wants to drop unsaved changes, call discardPendingChanges before you say they are gone.`;
