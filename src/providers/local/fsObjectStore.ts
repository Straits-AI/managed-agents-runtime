import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
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

  constructor(
    private readonly baseDir: string,
    private readonly maxObjectBytes = 512 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) {
      throw new Error('FsObjectStore maxObjectBytes is invalid');
    }
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
    this.assertSize(body.length);
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    return { etag: createHash('md5').update(body).digest('hex') };
  }
  async get(key: string): Promise<Buffer> {
    const path = this.path(key);
    this.assertSize(statSync(path).size);
    return readFileSync(path);
  }
  async exists(key: string): Promise<boolean> {
    return existsSync(this.path(key));
  }

  private presign(key: string, op: 'get' | 'put', ttlSec: number): string {
    if (!Number.isSafeInteger(ttlSec) || ttlSec < 1 || ttlSec > 86_400) {
      throw new Error('FsObjectStore presign TTL is invalid');
    }
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
      const path = this.path(entry.key);
      if (!existsSync(path)) {
        res.writeHead(404).end('not found');
        return;
      }
      if (statSync(path).size > this.maxObjectBytes) {
        res.writeHead(413).end('object too large');
        return;
      }
      res.writeHead(200).end(readFileSync(path));
      return;
    }
    if (req.method === 'PUT' && entry.op === 'put') {
      const chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;
      req.on('data', (c: Buffer) => {
        total += c.length;
        if (total > this.maxObjectBytes) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        if (!tooLarge) chunks.push(c);
      });
      req.on('end', () => {
        if (tooLarge) {
          res.writeHead(413).end('object too large');
          return;
        }
        const p = this.path(entry.key);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, Buffer.concat(chunks));
        res.writeHead(200).end('ok');
      });
      return;
    }
    res.writeHead(405).end('method not allowed');
  }

  private assertSize(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes > this.maxObjectBytes) {
      throw new Error('FsObjectStore object exceeds configured byte limit');
    }
  }
}
