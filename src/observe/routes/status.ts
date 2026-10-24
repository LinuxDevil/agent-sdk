/**
 * Health and status. `/health` is the port-collision marker: `lousho observe
 * start` probes it on EADDRINUSE, and the `service` field is what tells a
 * running collector apart from anything else that grabbed the port - it must
 * stay unauthenticated for attach detection to work. `/api/v1/status` is the
 * row-count surface `lousho observe status` prints.
 */

import { VERSION } from '../../version';
import { observeCounts } from '../store';
import { sendJson, type Route } from './httpKit';

export const statusRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: '/health',
    handle: ({ res }) => {
      sendJson(res, 200, { service: 'lousho-observe', ok: true, version: VERSION });
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
