import { verifyPublicGhcrImage } from '../src/publicRegistry.js';

const reference = process.argv[2]?.trim();
if (!reference) throw new Error('immutable GHCR digest reference is required');
const receipt = await verifyPublicGhcrImage(reference);
process.stdout.write(
  `PASS public GHCR digest ${receipt.digest} for ${receipt.repository}\n`,
);
