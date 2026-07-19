import { readFile } from 'node:fs/promises';

const packageDocument = JSON.parse(await readFile('package.json', 'utf8')) as {
  name?: string;
  version?: string;
};
const lockDocument = JSON.parse(await readFile('package-lock.json', 'utf8')) as {
  version?: string;
  packages?: Record<string, { version?: string }>;
};
const version = packageDocument.version;
if (!version) throw new Error('package.json has no version');
if (lockDocument.version !== version || lockDocument.packages?.['']?.version !== version) {
  throw new Error('package-lock.json root versions do not match package.json');
}

const expectedTag = `v${version}`;
const requestedTag = process.env.RELEASE_TAG?.trim();
if (requestedTag && requestedTag !== expectedTag) {
  throw new Error(`release tag ${requestedTag} does not match ${expectedTag}`);
}

const changelog = await readFile('CHANGELOG.md', 'utf8');
if (!changelog.includes(`## [${version}]`)) {
  throw new Error(`CHANGELOG.md has no release section for ${version}`);
}

process.stdout.write(`PASS release version ${expectedTag}\n`);
