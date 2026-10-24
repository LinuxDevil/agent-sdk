/**
 * Health and status. `/health` is the port-collision marker: `lousho observe
 * start` probes it on EADDRINUSE, and the `service` field is what tells a
 * running collector apart from anything else that grabbed the port - it must
 * stay unauthenticated for attach detection to work. Its `db` path (a home
 * dir, so a username) is told only to callers on this machine (isLocalCaller).
 * `/api/v1/status` is the
 * row-count surface `lousho observe status` prints.
 */

import * as path from 'node:path';
import type * as http from 'node:http';
import { isLoopbackHost } from '../../server/hostCheck';
import { VERSION } from '../../version';
import { observeCounts } from '../store';
import { sendJson, type Route } from './httpKit';

const unmapped = (address: string | undefined): string | undefined => address?.replace(/^::ffff:/i, '');

/**
 * Whether `req` comes from this machine: a loopback peer, or one connected
 * from the very address it reached (the CLI probing a daemon bound to this
 * machine's LAN address). Anyone else is told the service marker only.
 */
function isLocalCaller(req: http.IncomingMessage): boolean {
  const remote = unmapped(req.socket.remoteAddress);
  if (remote === undefined) return false;
  return isLoopbackHost(remote) || remote === unmapped(req.socket.localAddress);
}

export const statusRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: '/health',
    handle: ({ req, res, dbPath }) => {
      // `db` lets `start`/`stop` (run on this machine) tell which database a port or pid serves.
      const db = dbPath === ':memory:' ? dbPath : path.resolve(dbPath);
      sendJson(res, 200, { service: 'lousho-observe', ok: true, version: VERSION, ...(isLocalCaller(req) ? { db } : {}) });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/status',
    handle: ({ db, res }) => {
      sendJson(res, 200, { service: 'lousho-observe', ok: true, version: VERSION, counts: observeCounts(db) });
    },
  },
];
