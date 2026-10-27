import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
execSync('npm run build', { stdio: 'inherit' });
const [{ files }] = JSON.parse(execSync('npm pack --dry-run --json --ignore-scripts', { encoding: 'utf8' }));
const paths = new Set(files.map((file) => file.path));
for (const entry of [pkg.exports['.'], pkg.types]) {
  if (!paths.has(entry.replace(/^\.\//, ''))) throw new Error(`Package entrypoint is missing: ${entry}`);
}
console.log(`Verified ${pkg.name} entrypoints in ${paths.size} package files`);
