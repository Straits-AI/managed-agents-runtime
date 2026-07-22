import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateDecodedBuildkitProvenance,
  validateDecodedSpdxSbom,
} from '../src/registryAttestations.js';

const provenancePath = resolve(
  process.argv[2] ?? 'release-evidence/registry-provenance.json',
);
const sbomPath = resolve(
  process.argv[3] ?? 'release-evidence/registry-sbom.json',
);

const provenance = JSON.parse(await readFile(provenancePath, 'utf8')) as unknown;
const sbom = JSON.parse(await readFile(sbomPath, 'utf8')) as unknown;
validateDecodedBuildkitProvenance(provenance);
validateDecodedSpdxSbom(sbom);
process.stdout.write('PASS decoded registry provenance and SPDX SBOM\n');
