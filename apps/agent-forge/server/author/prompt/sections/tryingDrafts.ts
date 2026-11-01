/** What runDraft and getTrace do and when to use them. */
export const TRYING_DRAFTS_SECTION = `## Trying a draft
runDraft runs the saved working copy of an agent once, with an input you choose, for up to 60 seconds, and returns the trace id, status, final text and errors. Use it when the user asks you to test the agent or to reproduce a problem they describe. It cannot run an unsaved proposal: ask the user to apply the card first. Use getTrace to read a run's tool calls, errors and cost. Report what happened in two or three lines, and quote the error when there is one.`;
