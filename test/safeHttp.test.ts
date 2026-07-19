import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import {
  SafeHttpClient,
  assertPublicAddress,
  type AddressResolver,
  type EgressPolicy,
} from '../src/net/safeHttp.js';

const closeServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(
    closeServers.splice(0).map((close) => close()),
  );
});

const policy = (overrides: Partial<EgressPolicy> = {}): EgressPolicy => ({
  allowedOrigins: [],
  proxyUrl: null,
  connectTimeoutMs: 100,
  totalTimeoutMs: 500,
  maxRedirects: 3,
  maxResponseBytes: 1_024,
  ...overrides,
});

async function httpServer(
  handler: RequestListener,
): Promise<{ origin: string }> {
  const server = createServer(handler);
  closeServers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  return { origin: `http://127.0.0.1:${address.port}` };
}

describe('egress address policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '192.88.99.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00:ec2::254',
    'fec0::1',
    '64:ff9b:1::1',
    '100::1',
    '2002:7f00:1::',
    'ff02::1',
    '::ffff:127.0.0.1',
  ])('rejects non-public address %s', (address) => {
    expect(() => assertPublicAddress(address)).toThrow(/not permitted/);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => expect(() => assertPublicAddress(address)).not.toThrow(),
  );

  it.each([
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://0x7f000001/',
    'http://[::ffff:7f00:1]/',
  ])('rejects alternate loopback encoding %s', async (url) => {
    await expect(new SafeHttpClient(policy()).request({ url, method: 'GET' })).rejects.toThrow(
      /not permitted/,
    );
  });

  it('rejects every answer when DNS rebinding returns public then private', async () => {
    const resolver: AddressResolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    await expect(
      new SafeHttpClient(policy(), { resolver }).request({
        url: 'http://rebind.example/path',
        method: 'GET',
      }),
    ).rejects.toThrow(/not permitted/);
  });

  it('does not let an exact-granted hostname pivot into metadata address space', async () => {
    const resolver: AddressResolver = async () => [
      { address: '169.254.169.254', family: 4 },
    ];
    await expect(
      new SafeHttpClient(policy(), { resolver }).request({
        url: 'http://internal.example/latest/meta-data/',
        method: 'GET',
        privateOrigins: ['http://internal.example'],
      }),
    ).rejects.toThrow(/restricted|metadata|literal/i);
  });

  it.each(['127.0.0.1', '100.100.100.200'])(
    'does not let an exact-granted hostname pivot to restricted address %s',
    async (address) => {
      const resolver: AddressResolver = async () => [{ address, family: 4 }];
      await expect(
        new SafeHttpClient(policy(), { resolver }).request({
          url: 'http://internal.example/resource',
          method: 'GET',
          privateOrigins: ['http://internal.example'],
        }),
      ).rejects.toThrow(/restricted|literal/i);
    },
  );

  it('does not let an exact-granted hostname pivot to AWS IPv6 metadata', async () => {
    const resolver: AddressResolver = async () => [
      { address: 'fd00:ec2::254', family: 6 },
    ];
    await expect(
      new SafeHttpClient(policy(), { resolver }).request({
        url: 'http://internal.example/resource',
        method: 'GET',
        privateOrigins: ['http://internal.example'],
      }),
    ).rejects.toThrow(/restricted|literal/i);
  });

  it('requires every plaintext proxy address to be loopback', async () => {
    const resolver: AddressResolver = async (hostname) => hostname === 'localhost'
      ? [
          { address: '127.0.0.1', family: 4 },
          { address: '93.184.216.34', family: 4 },
        ]
      : [{ address: '93.184.216.34', family: 4 }];
    await expect(new SafeHttpClient(policy({
      proxyUrl: 'http://localhost:9080/forward',
    }), { resolver }).request({
      url: 'https://api.example.test/items',
      method: 'GET',
    })).rejects.toThrow(/loopback/i);
  });

  it('applies the total deadline while DNS is unresolved', async () => {
    const resolver: AddressResolver = async () =>
      new Promise((resolve) => setTimeout(() => resolve([
        { address: '93.184.216.34', family: 4 },
      ]), 200));
    await expect(
      new SafeHttpClient(policy({ totalTimeoutMs: 50 }), { resolver }).request({
        url: 'https://slow-dns.example/',
        method: 'GET',
      }),
    ).rejects.toThrow(/total deadline/);
  });

  it('enforces the configured origin allowlist before DNS or transport', async () => {
    const client = new SafeHttpClient(policy({
      allowedOrigins: ['https://api.example.com', 'https://*.trusted.example'],
    }));
    await expect(client.request({
      url: 'https://untrusted.example/resource', method: 'GET',
    })).rejects.toThrow(/egress allowlist/);
  });

  it('routes validated targets through a configured controlled proxy', async () => {
    let forwardedTarget = '';
    let pinnedAddress = '';
    let pinnedFamily = '';
    const { origin: proxyOrigin } = await httpServer((req, res) => {
      forwardedTarget = String(req.headers['x-managed-agents-target-url'] ?? '');
      pinnedAddress = String(req.headers['x-managed-agents-target-address'] ?? '');
      pinnedFamily = String(req.headers['x-managed-agents-target-family'] ?? '');
      res.end('proxied');
    });
    let targetResolutions = 0;
    const resolver: AddressResolver = async (hostname) => {
      if (hostname !== 'api.example.test') {
        return [{ address: '127.0.0.1', family: 4 }];
      }
      targetResolutions += 1;
      return targetResolutions === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    };
    const response = await new SafeHttpClient(policy({
      proxyUrl: `${proxyOrigin}/forward`,
    }), { resolver }).request({
      url: 'https://api.example.test/items?limit=2',
      method: 'GET',
    });
    expect(response.body).toBe('proxied');
    expect(forwardedTarget).toBe('https://api.example.test/items?limit=2');
    expect(pinnedAddress).toBe('93.184.216.34');
    expect(pinnedFamily).toBe('4');
    expect(targetResolutions).toBe(1);
  });
});

describe('bounded redirects and transport', () => {
  it('revalidates each redirect and denies metadata destinations', async () => {
    const { origin } = await httpServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
      res.end();
    });
    await expect(
      new SafeHttpClient(policy()).request({
        url: `${origin}/redirect`,
        method: 'GET',
        privateOrigins: [origin],
      }),
    ).rejects.toThrow(/not permitted/);
  });

  it('follows a bounded same-origin redirect', async () => {
    const { origin } = await httpServer((req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302;
        res.setHeader('location', '/final');
        res.end();
        return;
      }
      res.end('done');
    });
    const result = await new SafeHttpClient(policy()).request({
      url: `${origin}/start`,
      method: 'GET',
      privateOrigins: [origin],
    });
    expect(result).toMatchObject({ status: 200, body: 'done', redirects: 1 });
  });

  it('strips credentials when a redirect crosses origins', async () => {
    let receivedAuthorization: string | undefined;
    const { origin: destination } = await httpServer((req, res) => {
      receivedAuthorization = req.headers.authorization;
      res.end('done');
    });
    const { origin: source } = await httpServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `${destination}/final`);
      res.end();
    });
    await new SafeHttpClient(policy()).request({
      url: `${source}/start`,
      method: 'GET',
      headers: { authorization: 'Bearer secret' },
      privateOrigins: [source, destination],
    });
    expect(receivedAuthorization).toBeUndefined();
  });

  it('enforces the redirect limit', async () => {
    const { origin } = await httpServer((req, res) => {
      const step = Number(new URL(req.url ?? '/', 'http://local').searchParams.get('n') ?? '0');
      res.statusCode = 302;
      res.setHeader('location', `/loop?n=${step + 1}`);
      res.end();
    });
    await expect(
      new SafeHttpClient(policy({ maxRedirects: 1 })).request({
        url: `${origin}/loop?n=0`, method: 'GET', privateOrigins: [origin],
      }),
    ).rejects.toThrow(/redirect limit/);
  });

  it('aborts a slow response at the total deadline', async () => {
    const { origin } = await httpServer((_req, res) => {
      setTimeout(() => res.end('late'), 200);
    });
    await expect(
      new SafeHttpClient(policy({ totalTimeoutMs: 50 })).request({
        url: origin, method: 'GET', privateOrigins: [origin],
      }),
    ).rejects.toThrow(/total deadline/);
  });

  it('aborts streaming bodies beyond the response byte limit', async () => {
    const { origin } = await httpServer((_req, res) => {
      res.write(Buffer.alloc(80, 'a'));
      res.end(Buffer.alloc(80, 'b'));
    });
    await expect(
      new SafeHttpClient(policy({ maxResponseBytes: 100 })).request({
        url: origin, method: 'GET', privateOrigins: [origin],
      }),
    ).rejects.toThrow(/response byte limit/);
  });

  it('aborts a stalled TLS handshake at the connect deadline', async () => {
    const server = createTcpServer(() => {});
    const sockets = new Set<import('node:net').Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    closeServers.push(() => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');
    const origin = `https://127.0.0.1:${address.port}`;
    await expect(
      new SafeHttpClient(policy({ connectTimeoutMs: 50, totalTimeoutMs: 500 })).request({
        url: origin, method: 'GET', privateOrigins: [origin],
      }),
    ).rejects.toThrow(/connect deadline/);
  });
});
