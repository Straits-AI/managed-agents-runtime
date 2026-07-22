import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseProviderContractCatalog,
  parseProviderDeploymentManifest,
  parseProviderManifest,
  selectProvidersByCapability,
  type ProviderContractCatalogV1,
  type ProviderDeploymentManifestV1,
  type ProviderManifestV1,
} from './capabilities.js';

export interface ProviderPortabilityBundle {
  catalog: ProviderContractCatalogV1;
  manifests: ProviderManifestV1[];
  deployments: ProviderDeploymentManifestV1[];
}

export function loadProviderPortability(
  root: string,
  options: { verifyTestFiles?: boolean } = {},
): ProviderPortabilityBundle {
  const directory = resolve(root, 'provider-conformance');
  const providerDirectory = resolve(directory, 'providers');
  const catalog = parseProviderContractCatalog(readJson(resolve(directory, 'contracts.v1.json')));
  const packageVersion = String((readJson(resolve(root, 'package.json')) as { version?: unknown }).version ?? '');
  const manifests = readdirSync(providerDirectory)
    .filter((name) => name.endsWith('.v1.json'))
    .sort()
    .map((name) => parseProviderManifest(catalog, readJson(resolve(providerDirectory, name))));
  if (manifests.length < 3) throw new Error('provider portability requires local and at least two cloud manifests');
  const identities = new Set<string>();
  for (const manifest of manifests) {
    const identity = `${manifest.providerId}/${manifest.profileId}`;
    if (identities.has(identity)) throw new Error(`duplicate provider manifest ${identity}`);
    identities.add(identity);
    if (manifest.releaseVersion !== packageVersion) {
      throw new Error(`${identity} release version does not match package.json`);
    }
    verifyManifestFiles(root, manifest, options.verifyTestFiles ?? true);
  }
  const cloudProviders = new Set(
    manifests.filter((manifest) => manifest.providerClass === 'cloud').map((manifest) => manifest.providerId),
  );
  if (cloudProviders.size < 2) throw new Error('provider portability requires two distinct cloud providers');
  if (!manifests.some((manifest) => manifest.providerClass === 'local')) {
    throw new Error('provider portability requires a local reference manifest');
  }
  const deploymentDirectory = resolve(root, 'deploy/provider-profiles');
  const deployments = readdirSync(deploymentDirectory)
    .filter((name) => name.endsWith('.v1.json'))
    .sort()
    .map((name) => parseProviderDeploymentManifest(readJson(resolve(deploymentDirectory, name))));
  if (deployments.length < 2) throw new Error('provider portability requires deployment profiles');
  for (const deployment of deployments) {
    const selected = selectProvidersByCapability({
      catalog,
      manifests,
      requirements: deployment.requirements,
    });
    if (JSON.stringify(selected) !== JSON.stringify(deployment.resolvedSelection)) {
      throw new Error(`deployment ${deployment.deploymentId} has stale capability bindings`);
    }
  }
  return { catalog, manifests, deployments };
}

function verifyManifestFiles(
  root: string,
  manifest: ProviderManifestV1,
  verifyTestFiles: boolean,
): void {
  for (const declaration of manifest.capabilities) {
    if (declaration.status === 'unsupported') continue;
    for (const test of declaration.assurance.tests) {
      if (!/^test\/[A-Za-z0-9._/-]+\.test\.ts$/.test(test)
        || (verifyTestFiles && !existsSync(resolve(root, test)))) {
        throw new Error(`${manifest.providerId}/${manifest.profileId} references missing test ${test}`);
      }
    }
    if (declaration.assurance.level !== 'live') continue;
    const path = resolve(root, declaration.assurance.evidencePath);
    if (!existsSync(path)) {
      throw new Error(`${manifest.providerId}/${manifest.profileId} live evidence is missing`);
    }
    const source = readFileSync(path);
    const hash = createHash('sha256').update(source).digest('hex');
    if (hash !== declaration.assurance.evidenceSha256) {
      throw new Error(`${manifest.providerId}/${manifest.profileId} live evidence hash mismatch`);
    }
    const evidence = JSON.parse(source.toString('utf8')) as {
      source?: { commit?: unknown };
      provider?: unknown;
      retrievedAt?: unknown;
    };
    if (!evidence.source || typeof evidence.source.commit !== 'string'
      || !/^[a-f0-9]{40}$/.test(evidence.source.commit)
      || typeof evidence.provider !== 'string'
      || typeof evidence.retrievedAt !== 'string') {
      throw new Error(`${manifest.providerId}/${manifest.profileId} live evidence provenance is invalid`);
    }
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
