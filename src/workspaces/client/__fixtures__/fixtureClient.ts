import { WorkspaceApiError, type ApiClient, type RunEventsRequest } from '../apiClient';
import { WORKSPACE_ROUTES, type JsonRouteName, type WorkspaceRouteName } from '../wire';
import type { WireRunEvent } from '../wireTypes';
import fixtures from './wire.fixtures.json';

const responses = fixtures.responses as unknown as Record<WorkspaceRouteName, unknown>;

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function respond(name: JsonRouteName): Promise<never> {
  const parsed = WORKSPACE_ROUTES[name].response.safeParse(responses[name]);
  if (!parsed.success) throw new WorkspaceApiError(`the fixture for ${name} does not match the wire contract`, 500);
  return copy(parsed.data) as never;
}

async function* eventsAfter(request: RunEventsRequest): AsyncGenerator<WireRunEvent> {
  const after = request.lastEventId ?? -1;
  for (const event of copy(responses.streamRunEvents as WireRunEvent[])) {
    if (event.id > after) yield event;
  }
}

/** A fake {@link ApiClient} that answers every route with the wire fixture generated from the Marketing reference workspace; for UI tests and the Forge track. */
export function fixtureClient(): ApiClient {
  return { call: respond, streamRunEvents: eventsAfter };
}
