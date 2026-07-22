import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = join(import.meta.dirname, '..');
const entrypoints = ['README.md', 'docs', 'examples'];

function markdownFiles(path: string): string[] {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return path.endsWith('.md') ? [path] : [];
  return readdirSync(absolute, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => markdownFiles(join(path, entry.name)));
}

function linkTarget(raw: string): string | null {
  const value = raw.trim();
  if (value.startsWith('<')) {
    const end = value.indexOf('>');
    return end > 1 ? value.slice(1, end) : null;
  }
  return value.match(/^\S+/)?.[0] ?? null;
}

const failures: string[] = [];
const files = entrypoints.flatMap(markdownFiles);

for (const file of files) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = linkTarget(match[1]!);
      if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const withoutSuffix = target.split('#', 1)[0]!.split('?', 1)[0]!;
      if (!withoutSuffix) continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(withoutSuffix);
      } catch {
        failures.push(`${file}:${index + 1} has invalid URL encoding: ${target}`);
        continue;
      }
      const destination = resolve(root, dirname(file), decoded);
      if (!existsSync(destination)) {
        failures.push(`${file}:${index + 1} has missing target: ${target}`);
      }
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Internal documentation link check failed:\n${failures.join('\n')}`);
}

process.stdout.write(`PASS internal documentation links (${files.length} Markdown files)\n`);
