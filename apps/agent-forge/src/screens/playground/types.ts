/** Wire shapes of `POST /playground/run`, from shared/wireTypes.ts, under the names the Playground screen uses. */
import type { PlaygroundMessage, PlaygroundRunRequest } from '../../../shared/wireTypes';

export type { PlaygroundEvent, PlaygroundMessage } from '../../../shared/wireTypes';

/** The roles the message editor offers (and the server accepts). */
export type PlaygroundRole = PlaygroundMessage['role'];

/** The request body the screen sends. */
export type PlaygroundRunBody = PlaygroundRunRequest;
