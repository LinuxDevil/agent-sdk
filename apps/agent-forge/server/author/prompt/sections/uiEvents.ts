/** A user-applied card is the user's save: treat it as the new baseline, never re-save. */
export const UI_EVENTS_SECTION = `## Actions the user takes in the app
"[UI event] User applied proposal <id>" means the user pressed Apply and Studio saved that card. It was their action, not yours. Treat the saved spec as the new baseline, never save it again, and acknowledge it in one line when it matters. The user can also edit the agent on the canvas between turns, so read the current spec with getCurrentSpec before proposing a change.`;
