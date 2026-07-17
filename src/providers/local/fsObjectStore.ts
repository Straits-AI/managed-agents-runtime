import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ObjectStore } from '../types.js';

/**
 * Filesystem-backed ObjectStore for the no-BytePlus local stack (memo §21
 * portability). A drop-in for TosObjectStore: objects live under a base dir, and
 * a tiny loopback HTTP server issues presigned-style GET/PUT URLs so the
 * existing curl-based workspace flow (WorkspaceManager) works unchanged — the
 * sandbox curls 127.0.0.1 instead of TOS.
 */
export class FsObjectStore implements ObjectStore {
  private readonly server: Server;
  private port = 0;
  private readonly tokens = new Map<string, { key: string; op: 'get' | 'put'; exp: number }>();

  constructor(private readonly baseDir: string) {
    mkdirSync(baseDir, { recursive: true });
    this.server = createServer((req, res) => this.handle(req, res));
  }

  /** Start the loopback presign server; must be called before presign URLs are used. */
  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private path(key: string): string {
    // Contain keys under baseDir; hash any traversal-y key components.
    const safe = key.replace(/\.\./g, '_');
    return join(this.baseDir, safe);
  }

  async put(key: string, body: Buffer): Promise<{ etag: string | null }> {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    return { etag: createHash('md5').update(body).digest('hex') };
  }
  async get(key: string): Promise<Buffer> {
    return readFileSync(this.path(key));
  }
  async exists(key: string): Promise<boolean> {
    return existsSync(this.path(key));
  }

  private presign(key: string, op: 'get' | 'put', ttlSec: number): string {
    const token = randomBytes(16).toString('hex');
    this.tokens.set(token, { key, op, exp: Date.now() + ttlSec * 1000 });
    return `http://127.0.0.1:${this.port}/o?token=${token}`;
  }
  async presignPut(key: string, ttlSec: number): Promise<string> {
    return this.presign(key, 'put', ttlSec);
  }
  async presignGet(key: string, ttlSec: number): Promise<string> {
    return this.presign(key, 'get', ttlSec);
  }

  private handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = url.searchParams.get('token') ?? '';
    const entry = this.tokens.get(token);
    if (!entry || entry.exp < Date.now()) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (req.method === 'GET' && entry.op === 'get') {
      try {
        res.writeHead(200).end(readFileSync(this.path(entry.key)));
      } catch {
        res.writeHead(404).end('not found');
      }
      return;
    }
    if (req.method === 'PUT' && entry.op === 'put') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const p = this.path(entry.key);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, Buffer.concat(chunks));
        res.writeHead(200).end('ok');
      });
      return;
    }
    res.writeHead(405).end('method not allowed');
  }
}
