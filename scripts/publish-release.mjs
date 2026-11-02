import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`);
if (response.status === 404) {
  execFileSync('npm', ['publish', '--access', 'public', '--provenance', '--ignore-scripts'], { stdio: 'inherit' });
} else {
  if (!response.ok) throw new Error(`npm lookup failed: HTTP ${response.status}`);
  const published = await response.json();
  const [local] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
  assert.equal(local.integrity, published.dist.integrity, 'Version already exists with different contents; increment the version instead of overwriting');
  console.log(`${pkg.name}@${pkg.version} already published with identical contents; skipping`);
}
