import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve('clients/kertas-runtime');
const sourceRoot = join(root, 'src');
const forbidden = [
  /(?:from|import\s*)\s*['"][^'"]*(?:\/src\/|\/migrations\/|\/test\/)/,
  /['"](?:\.\.\/){3,}(?:src|migrations|test)(?:\/|['"])/,
  /@straits-ai\/managed-agents-runtime\/internal/,
];

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }));
  return nested.flat();
}

const violations: string[] = [];
for (const path of await files(sourceRoot)) {
  if (!['.ts', '.js', '.mts', '.mjs'].includes(extname(path))) continue;
  const source = await readFile(path, 'utf8');
  if (forbidden.some((pattern) => pattern.test(source))) {
    violations.push(relative(root, path));
  }
}
if (violations.length > 0) {
  throw new Error(`Kertas client imports runtime internals: ${violations.join(', ')}`);
}
process.stdout.write('PASS Kertas client public-contract boundary\n');
