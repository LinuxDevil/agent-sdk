import type * as http from 'node:http';

/** Write `value` as a JSON response body with the given status. */
export function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
