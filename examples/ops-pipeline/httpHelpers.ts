/**
 * Small node:http helpers shared by the ops-pipeline's two listeners
 * (monitor.ts's POST /webhook and index.ts's POST /slack/interactions).
 */
import * as http from 'node:http';

/** Writes a JSON response with the given status code. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Writes the plain-text 404 used for every unrecognised route. */
export function sendNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

/**
 * Starts `server` listening and resolves with the port it actually bound
 * (which differs from `port` when `port` is 0, i.e. an ephemeral port).
 */
export async function listenOn(server: http.Server, port: number, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  return typeof address === 'object' && address ? address.port : port;
}

/** Promise wrapper around http.Server#close. */
export function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
