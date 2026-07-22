import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const workflowsDir = join(root, '.github', 'workflows');
const workflowSources = readdirSync(workflowsDir)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort()
  .map((file) => readFileSync(join(workflowsDir, file), 'utf8'));
const controlledAlpha = readFileSync(
  join(workflowsDir, 'controlled-alpha-gate.yml'),
  'utf8',
);
const publishAlpha = readFileSync(
  join(workflowsDir, 'publish-controlled-alpha.yml'),
  'utf8',
);
const containerSmoke = readFileSync(join(root, 'scripts', 'smoke-container.ts'), 'utf8');
const provenance = readFileSync(
  join(root, 'docs', 'CONTROLLED-ALPHA-RELEASE-GATE.md'),
  'utf8',
);

const reviewedActions = [
  {
    repository: 'actions/checkout',
    tag: 'v7.0.0',
    sha: '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
  },
  {
    repository: 'actions/download-artifact',
    tag: 'v8.0.0',
    sha: '70fc10c6e5e1ce46ad2ea6f2b72d43f7d47b13c3',
  },
  {
    repository: 'actions/setup-node',
    tag: 'v7.0.0',
    sha: '820762786026740c76f36085b0efc47a31fe5020',
  },
  {
    repository: 'actions/upload-artifact',
    tag: 'v7.0.1',
    sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  },
] as const;

describe('controlled-alpha GitHub Actions supply chain', () => {
  it('uses only the reviewed Node 24-native actions at immutable SHAs', () => {
    const references = workflowSources.flatMap((workflow) => [
      ...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm),
    ].map(([, reference]) => reference!));

    expect([...new Set(references)].sort()).toEqual(
      reviewedActions.map(({ repository, sha }) => `${repository}@${sha}`).sort(),
    );

    for (const { repository, tag, sha } of reviewedActions) {
      expect(provenance).toContain(
        `| [\`${repository}\`](https://github.com/${repository}/releases/tag/${tag}) | \`${tag}\` | \`${sha}\` | \`node24\` |`,
      );
    }
  });

  it('pins the PostgreSQL gate dependency by multi-platform digest', () => {
    const postgres =
      'postgres:16@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20';
    expect(controlledAlpha).toContain(`image: ${postgres}`);
    expect(publishAlpha).toContain(`image: ${postgres}`);
    expect(containerSmoke).toContain(`const postgresImage = '${postgres}';`);
    expect(workflowSources.join('\n')).not.toMatch(/image:\s+postgres:16\s*$/m);
  });

  it('keeps container health smoke inside the isolated Docker network', () => {
    expect(containerSmoke).toContain("['exec', container, 'node', '--input-type=module'");
    expect(containerSmoke).not.toContain("'-p', '127.0.0.1::8080'");
    expect(containerSmoke).not.toContain('http://127.0.0.1:${port}');
  });

  it('keeps validation read-only and publishes only a verified annotated main tag', () => {
    expect(publishAlpha).toContain('validate:');
    expect(publishAlpha).toContain('permissions:\n      actions: read\n      contents: read');
    expect(publishAlpha).toContain('publish:\n    needs: validate');
    expect(publishAlpha).toContain('persist-credentials: false');
    expect(publishAlpha).toContain("git cat-file -t \"refs/tags/${RELEASE_TAG}\"");
    expect(publishAlpha).toContain('refs/remotes/origin/main');
    expect(publishAlpha).toContain('controlled-alpha-gate.yml');
    expect(publishAlpha).toContain('conclusion == \"success\"');
  });

  it('tests the immutable registry digest before promoting release tags', () => {
    const push = publishAlpha.indexOf('--push');
    const digestImage = publishAlpha.indexOf('REGISTRY_IMAGE_WITH_DIGEST');
    const smoke = publishAlpha.indexOf('npm run container:smoke', digestImage);
    const promote = publishAlpha.indexOf('docker buildx imagetools create', smoke);

    expect(push).toBeGreaterThan(-1);
    expect(digestImage).toBeGreaterThan(push);
    expect(smoke).toBeGreaterThan(digestImage);
    expect(promote).toBeGreaterThan(smoke);
    expect(publishAlpha).toContain('docker logout ghcr.io');
    expect(publishAlpha).toContain('npm run release:attestations');
    expect(publishAlpha).toContain("'BuildKit SLSA provenance'");
    expect(publishAlpha).toContain("'SPDX-2.3'");
  });

  it('passes the pulled immutable digest to container smoke and evidence generation', () => {
    const exportImage = publishAlpha.indexOf(
      'echo "CONTAINER_IMAGE=${registry_image_with_digest}" >> "${GITHUB_ENV}"',
    );
    const smoke = publishAlpha.indexOf('npm run container:smoke');
    const evidence = publishAlpha.indexOf('npm run container:evidence');

    expect(exportImage).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(exportImage);
    expect(evidence).toBeGreaterThan(smoke);
  });

  it('proves the release digest can be pulled without registry credentials', () => {
    const logout = publishAlpha.indexOf('docker logout ghcr.io');
    const tokenProof = publishAlpha.indexOf(
      'npm run release:public-image -- "${REGISTRY_IMAGE_WITH_DIGEST}"',
    );
    const anonymousConfig = publishAlpha.indexOf('anonymous_docker_config="$(mktemp -d)"');
    const anonymousPull = publishAlpha.indexOf(
      'DOCKER_CONFIG="${anonymous_docker_config}" docker pull "${REGISTRY_IMAGE_WITH_DIGEST}"',
    );
    const smoke = publishAlpha.indexOf('npm run container:smoke');

    expect(logout).toBeGreaterThan(-1);
    expect(tokenProof).toBeGreaterThan(logout);
    expect(anonymousConfig).toBeGreaterThan(logout);
    expect(anonymousConfig).toBeGreaterThan(tokenProof);
    expect(anonymousPull).toBeGreaterThan(anonymousConfig);
    expect(smoke).toBeGreaterThan(anonymousPull);
  });

  it('attaches the exact-commit kernel evidence to the prerelease', () => {
    expect(publishAlpha).toContain('controlled-alpha-kernel-evidence.tar.gz');
    expect(publishAlpha).toContain('release-evidence/kernel/summary.json');
  });
});
