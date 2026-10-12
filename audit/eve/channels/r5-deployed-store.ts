/* Eve repro 5: createDeployedServer mounts channels WITHOUT the agent's store
   (nodeServer.ts:95 calls `mountChannels(agent, options.channels)`). Channel
   transcripts go to a private in-memory MemorySessionStore even when the agent
   has a durable store — so `ctx.hasSession` (Slack follow-ups without a
   mention) and the transcripts themselves do not survive a restart, contrary
   to docs/channels.md's restart story on the node-server/docker targets. */
import * as http from 'node:http';
import { createDeployedServer } from '../../../src/deploy/nodeServer';
import { httpChannel } from '../../../src/channels/httpChannel';
import { createAgent } from '../../../src/createAgent';
import { mockModel } from '../../../src/testing';
import { memoryStore } from '../../../src/storage/agentStore';

const store = memoryStore();
const agent = createAgent({ provider: mockModel(['turn one reply', 'turn two reply']), store });

const { server } = createDeployedServer(agent, { env: {}, channels: [httpChannel()] });
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;

const res = await fetch(`http://localhost:${port}/channels/http`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionKey: 'u-42', input: 'hi' }),
});
const body = (await res.json()) as { sessionId: string };
console.log('turn ran, sessionId =', body.sessionId);

// If the channel shared the agent's store, the transcript would be in it:
const inAgentStore = await store.sessions.load(body.sessionId);
console.log('transcript in agent store:', inAgentStore === undefined ? 'NO — private in-memory store' : `yes (${inAgentStore.length} messages)`);
server.close();
