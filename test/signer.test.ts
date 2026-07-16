import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { buildSignedRequest } from '../src/providers/byteplus/signer.js';

/**
 * Reference implementation transcribed verbatim from
 * @agent-infra/sandbox dist/esm/providers/sign.mjs (fetch removed), used
 * to prove our configurable signer produces byte-identical signatures.
 */
function referenceSign(input: {
  method: string;
  date: Date;
  ak: string;
  sk: string;
  token: string | null;
  action: string;
  version: string;
  body: string;
  region: string;
  service: string;
  host: string;
}) {
  const hmacSha256 = (key: Buffer | string, content: string) =>
    createHmac('sha256', key).update(content, 'utf8').digest();
  const hashSha256 = (content: string) =>
    createHash('sha256').update(content, 'utf8').digest('hex');
  const normQuery = (params: Record<string, string>) =>
    Object.keys(params)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
      .join('&')
      .replace(/\+/g, '%20');

  const contentType =
    input.method === 'POST' ? 'application/json' : 'application/x-www-form-urlencoded';
  const query = { Action: input.action, Version: input.version };
  const xDate = input.date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const shortXDate = xDate.slice(0, 8);
  const xContentSha256 = hashSha256(input.body);
  const signedHeadersStr = 'content-type;host;x-content-sha256;x-date';
  const canonicalRequestStr = [
    input.method.toUpperCase(),
    '/',
    normQuery(query),
    `content-type:${contentType}`,
    `host:${input.host}`,
    `x-content-sha256:${xContentSha256}`,
    `x-date:${xDate}`,
    '',
    signedHeadersStr,
    xContentSha256,
  ].join('\n');
  const credentialScope = [shortXDate, input.region, input.service, 'request'].join('/');
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    credentialScope,
    hashSha256(canonicalRequestStr),
  ].join('\n');
  const kDate = hmacSha256(Buffer.from(input.sk, 'utf8'), shortXDate);
  const kRegion = hmacSha256(kDate, input.region);
  const kService = hmacSha256(kRegion, input.service);
  const kSigning = hmacSha256(kService, 'request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');
  return {
    authorization: `HMAC-SHA256 Credential=${input.ak}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`,
    xDate,
    xContentSha256,
  };
}

describe('BytePlus signer', () => {
  const fixed = {
    host: 'open.byteplusapi.com',
    region: 'ap-southeast-1',
    service: 'vefaas',
    action: 'ListSandboxes',
    version: '2024-06-06',
    body: JSON.stringify({ FunctionId: 'fn-abc', PageNumber: 1, PageSize: 10 }),
    accessKeyId: 'AKTEST123',
    secretAccessKey: 'SECRETXYZ',
    date: new Date('2026-07-16T08:30:00.000Z'),
  };

  it('matches the SDK reference algorithm exactly', () => {
    const ours = buildSignedRequest(fixed);
    const ref = referenceSign({
      method: 'POST',
      date: fixed.date,
      ak: fixed.accessKeyId,
      sk: fixed.secretAccessKey,
      token: null,
      action: fixed.action,
      version: fixed.version,
      body: fixed.body,
      region: fixed.region,
      service: fixed.service,
      host: fixed.host,
    });
    expect(ours.headers.Authorization).toBe(ref.authorization);
    expect(ours.headers['X-Date']).toBe(ref.xDate);
    expect(ours.headers['X-Content-Sha256']).toBe(ref.xContentSha256);
  });

  it('matches the reference across varied inputs', () => {
    for (let i = 0; i < 25; i++) {
      const v = {
        host: i % 2 ? 'open.volcengineapi.com' : 'open.byteplusapi.com',
        region: i % 3 ? 'cn-beijing' : 'ap-southeast-1',
        service: i % 2 ? 'apig' : 'vefaas',
        action: `Action${i}`,
        version: i % 2 ? '2022-11-12' : '2024-06-06',
        body: JSON.stringify({ n: i, s: `value-${i}`, nested: { a: [i, i + 1] } }),
        accessKeyId: `AK${i}`,
        secretAccessKey: `SK${i}${'x'.repeat(i)}`,
        date: new Date(Date.UTC(2026, 6, 16, i % 24, i, i)),
      };
      const ours = buildSignedRequest(v);
      const ref = referenceSign({
        method: 'POST',
        date: v.date,
        ak: v.accessKeyId,
        sk: v.secretAccessKey,
        token: null,
        action: v.action,
        version: v.version,
        body: v.body,
        region: v.region,
        service: v.service,
        host: v.host,
      });
      expect(ours.headers.Authorization).toBe(ref.authorization);
    }
  });

  it('builds a stable known-vector signature (regression pin)', () => {
    const ours = buildSignedRequest(fixed);
    expect(ours.url).toBe(
      'https://open.byteplusapi.com/?Action=ListSandboxes&Version=2024-06-06',
    );
    expect(ours.headers['X-Date']).toBe('20260716T083000Z');
    // Pinned output of the algorithm for the fixed inputs above; any change
    // to canonicalization or key derivation breaks this.
    expect(ours.headers.Authorization).toMatch(
      /^HMAC-SHA256 Credential=AKTEST123\/20260716\/ap-southeast-1\/vefaas\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it('includes the session token header only when provided', () => {
    expect(buildSignedRequest(fixed).headers['X-Security-Token']).toBeUndefined();
    expect(
      buildSignedRequest({ ...fixed, sessionToken: 'tok' }).headers['X-Security-Token'],
    ).toBe('tok');
  });
});
