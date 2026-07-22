import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseProviderManifest,
  selectProvidersByCapability,
} from '../src/providers/capabilities.js';
import { loadProviderPortability } from '../src/providers/portability.js';

const root = resolve(import.meta.dirname, '..');

describe('provider capability portability boundary', () => {
  it('loads every capability group, three honest manifests, and capability-selected deployments', () => {
    const bundle = loadProviderPortability(root);
    expect(bundle.catalog.contracts).toHaveLength(11);
    expect(new Set(bundle.catalog.contracts.map((contract) => contract.group))).toEqual(new Set([
      'model',
      'sandbox',
      'object-store',
      'event',
      'credential',
      'knowledge',
      'memory',
      'tool',
    ]));
    expect(bundle.manifests.map((manifest) => `${manifest.providerId}/${manifest.profileId}`)).toEqual([
      'aws/public-s3-read',
      'byteplus/managed-runtime',
      'local/reference',
    ]);
    expect(bundle.deployments.map((deployment) => deployment.deploymentId)).toEqual([
      'aws-public-read',
      'kertas-managed',
    ]);
  });

  it('binds the complete Kertas runtime by capability, not a provider-name input', () => {
    const bundle = loadProviderPortability(root);
    const deployment = bundle.deployments.find(({ deploymentId }) => deploymentId === 'kertas-managed')!;
    const selection = selectProvidersByCapability({
      catalog: bundle.catalog,
      manifests: bundle.manifests,
      requirements: deployment.requirements,
    });
    expect(selection).toEqual(deployment.resolvedSelection);
    expect(selection.bindings.filter(({ providerId }) => providerId === 'byteplus').map(({ contract }) => contract))
      .toEqual([
        'model.chat/v1',
        'object.presign/v1',
        'object.read/v1',
        'object.write/v1',
        'sandbox.workspace/v1',
      ]);
    expect(selection.bindings.filter(({ providerId }) => providerId === 'local')).toHaveLength(6);
  });

  it('proves only the declared live AWS public-read subset', () => {
    const bundle = loadProviderPortability(root);
    const aws = bundle.manifests.find(({ providerId }) => providerId === 'aws')!;
    const supported = aws.capabilities.filter(({ status }) => status !== 'unsupported');
    expect(supported).toHaveLength(1);
    expect(supported[0]).toMatchObject({
      contract: 'object.read/v1',
      status: 'required',
      implementation: 'AwsPublicS3Reader',
      assurance: { level: 'live' },
    });
    expect(aws.capabilities.find(({ contract }) => contract === 'object.write/v1')).toMatchObject({
      status: 'unsupported',
      assurance: { level: 'none' },
    });
  });

  it('keeps one provider affinity for read, write, and presign object semantics', () => {
    const bundle = loadProviderPortability(root);
    const selection = selectProvidersByCapability({
      catalog: bundle.catalog,
      manifests: bundle.manifests,
      requirements: [
        { contract: 'object.read/v1', minimumAssurance: 'live' },
        { contract: 'object.write/v1', minimumAssurance: 'live' },
        { contract: 'object.presign/v1', minimumAssurance: 'live' },
      ],
    });
    expect(new Set(selection.bindings.map(({ providerId }) => providerId))).toEqual(new Set(['byteplus']));
  });

  it('rejects requirements that no declared subset can satisfy', () => {
    const bundle = loadProviderPortability(root);
    const aws = bundle.manifests.filter(({ providerId }) => providerId === 'aws');
    expect(() => selectProvidersByCapability({
      catalog: bundle.catalog,
      manifests: aws,
      requirements: [{ contract: 'model.chat/v1', minimumAssurance: 'unit' }],
    })).toThrow('no provider satisfies capability group model.chat/v1');
  });

  it('rejects duplicate, omitted, and dishonest unsupported declarations', () => {
    const bundle = loadProviderPortability(root);
    const raw = JSON.parse(readFileSync(resolve(
      root,
      'provider-conformance/providers/aws-public-s3.v1.json',
    ), 'utf8')) as {
      capabilities: Array<Record<string, unknown>>;
    } & Record<string, unknown>;

    expect(() => parseProviderManifest(bundle.catalog, {
      ...raw,
      capabilities: [...raw.capabilities, raw.capabilities[0]],
    })).toThrow('duplicates contract model.chat/v1');

    expect(() => parseProviderManifest(bundle.catalog, {
      ...raw,
      capabilities: raw.capabilities.slice(1),
    })).toThrow('omits contract model.chat/v1');

    const dishonest = structuredClone(raw) as typeof raw;
    dishonest.capabilities[0] = {
      ...dishonest.capabilities[0],
      implementation: 'PretendModel',
    };
    expect(() => parseProviderManifest(bundle.catalog, dishonest)).toThrow();
  });

  it('does not let read-only AWS satisfy the writable runtime object-store type', () => {
    const awsReader = readFileSync(resolve(root, 'src/providers/aws/publicS3Reader.ts'), 'utf8');
    expect(awsReader).not.toMatch(/\bput\s*\(/);
    expect(awsReader).not.toMatch(/\bpresign(?:Get|Put)\s*\(/);

    const types = readFileSync(resolve(root, 'src/providers/types.ts'), 'utf8');
    expect(types).toContain('export interface ReadableObjectStore');
    expect(types).toContain('export interface WritableObjectStore');
    expect(types).toContain('export interface PresigningObjectStore');
    expect(types).toContain('extends ReadableObjectStore, WritableObjectStore, PresigningObjectStore');
  });
});
