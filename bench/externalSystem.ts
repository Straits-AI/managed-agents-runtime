import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

/**
 * The benchmark's "external system" (memo §24): an HTTP service with real
 * side-effect semantics — every accepted POST is recorded as an action,
 * duplicate requests with the same Idempotency-Key return the original
 * result without creating a second action. A query API lets the benchmark
 * assert exactly-once behaviour.
 */
export interface RecordedAction {
  id: string;
  idempotencyKey: string | null;
  method: string;
  path: string;
  body: unknown;
  receivedCount: number;
  firstReceivedAt: string;
}

export interface ExternalSystem {
  url: string;
  actions(): RecordedAction[];
  close(): Promise<void>;
}

export function startExternalSystem(port = 0): Promise<ExternalSystem> {
  const byKey = new Map<string, RecordedAction>();
  const all: RecordedAction[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/actions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ actions: all }));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/actions/')) {
        const key = decodeURIComponent(url.pathname.slice('/actions/'.length));
        const action = byKey.get(key);
        res.writeHead(action ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(action ?? { error: 'not found' }));
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: url.pathname }));
        return;
      }

      // Mutating request: record as an action, dedupe on Idempotency-Key.
      const idemKey = (req.headers['idempotency-key'] as string | undefined) ?? null;
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        body = Buffer.concat(chunks).toString('utf8');
      }

      if (idemKey && byKey.has(idemKey)) {
        const existing = byKey.get(idemKey)!;
        existing.receivedCount += 1;
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-transaction-id': existing.id,
          'x-idempotent-replay': 'true',
        });
        res.end(JSON.stringify({ ok: true, transactionId: existing.id, replay: true }));
        return;
      }

      const action: RecordedAction = {
        id: `txn_${randomBytes(8).toString('hex')}`,
        idempotencyKey: idemKey,
        method: req.method ?? 'POST',
        path: url.pathname,
        body,
        receivedCount: 1,
        firstReceivedAt: new Date().toISOString(),
      };
      all.push(action);
      if (idemKey) byKey.set(idemKey, action);

      res.writeHead(201, {
        'content-type': 'application/json',
        'x-transaction-id': action.id,
      });
      res.end(JSON.stringify({ ok: true, transactionId: action.id }));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        actions: () => all,
        close: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}
