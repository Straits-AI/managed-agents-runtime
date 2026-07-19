import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const image = required('CONTAINER_IMAGE');
const releaseVersion = required('RELEASE_VERSION');
const releaseCommit = required('RELEASE_COMMIT');
const evidenceDir = required('RELEASE_EVIDENCE_DIR');

if (!/^[0-9a-f]{40}$/.test(releaseCommit)) {
  throw new Error('RELEASE_COMMIT must be a full lowercase Git SHA');
}

const packageDocument = JSON.parse(await readFile('package.json', 'utf8')) as {
  name?: string;
  version?: string;
};
if (packageDocument.version !== releaseVersion) {
  throw new Error(
    `package version ${packageDocument.version ?? '<missing>'} does not match ${releaseVersion}`,
  );
}

const inspected = JSON.parse(
  (await exec('docker', ['image', 'inspect', image], { maxBuffer: 10 * 1024 * 1024 })).stdout,
) as Array<{
  Id: string;
  RepoDigests?: string[];
  Architecture: string;
  Os: string;
  Config: {
    User?: string;
    Entrypoint?: string[];
    Cmd?: string[];
    Labels?: Record<string, string>;
  };
}>;
const descriptor = inspected[0];
if (!descriptor) throw new Error(`image not found: ${image}`);

const labels = descriptor.Config.Labels ?? {};
if (labels['org.opencontainers.image.version'] !== releaseVersion) {
  throw new Error('image version label does not match RELEASE_VERSION');
}
if (labels['org.opencontainers.image.revision'] !== releaseCommit) {
  throw new Error('image revision label does not match RELEASE_COMMIT');
}
if (!descriptor.Config.User || ['0', 'root'].includes(descriptor.Config.User)) {
  throw new Error('image user must be explicitly non-root');
}

const sbomSource = (
  await exec('npm', ['sbom', '--omit=dev', '--sbom-format', 'cyclonedx'], {
    maxBuffer: 25 * 1024 * 1024,
  })
).stdout;
JSON.parse(sbomSource);

await mkdir(evidenceDir, { recursive: true });
const imageEvidence = {
  schemaVersion: 1,
  package: packageDocument.name,
  version: releaseVersion,
  sourceCommit: releaseCommit,
  imageReference: image,
  imageConfigDigest: descriptor.Id,
  repositoryDigests: descriptor.RepoDigests ?? [],
  platform: `${descriptor.Os}/${descriptor.Architecture}`,
  user: descriptor.Config.User,
  entrypoint: descriptor.Config.Entrypoint ?? [],
  command: descriptor.Config.Cmd ?? [],
  labels,
};
const imageSource = `${JSON.stringify(imageEvidence, null, 2)}\n`;
const imagePath = join(evidenceDir, 'container-image.json');
const sbomPath = join(evidenceDir, 'container-sbom.cdx.json');
await writeFile(imagePath, imageSource);
await writeFile(sbomPath, sbomSource.endsWith('\n') ? sbomSource : `${sbomSource}\n`);

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const summary = {
  schemaVersion: 1,
  status: 'passed',
  version: releaseVersion,
  sourceCommit: releaseCommit,
  imageConfigDigest: descriptor.Id,
  artifacts: {
    image: {
      path: 'container-image.json',
      sha256: sha256(imageSource),
    },
    sbom: {
      path: 'container-sbom.cdx.json',
      sha256: sha256(sbomSource.endsWith('\n') ? sbomSource : `${sbomSource}\n`),
      format: 'CycloneDX',
    },
  },
};
await writeFile(join(evidenceDir, 'container-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`PASS container evidence ${descriptor.Id}\n`);
