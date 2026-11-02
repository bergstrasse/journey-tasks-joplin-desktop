import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('export scan excludes tests and follows named, star, aliased and namespace re-exports', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-exports-'));
  try {
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'));
    const files = {
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2020' }, include: ['src/**/*.ts', 'tests/**/*.ts'] }),
      'src/values.ts': `export const live = 1; export const testOnly = 2; export const dead = 3;
        const localDead = 4; export { localDead }; export interface PublicType { value: string }
        const localLive = 5; export { localLive }; export default 6;`,
      'src/barrel.ts': `export { live as renamed, testOnly } from './values'; export * from './values';`,
      'src/namespace-values.ts': `export const usedNamespace = 7;`,
      'src/namespace.ts': `export * as values from './namespace-values';`,
      'src/type-only.ts': `class TypeOnlyClass {} export type { TypeOnlyClass };`,
      'src/default.ts': `import value from './values'; export { value as renamedDefault };`,
      'src/consumer.ts': `import { renamed, localLive } from './barrel'; import { renamedDefault } from './default';
        import * as group from './namespace'; console.log(renamed, localLive, renamedDefault, group.values.usedNamespace);`,
      'tests/consumer.ts': `import { testOnly } from '../src/barrel'; console.log(testOnly);`,
    };
    for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
    const scan = () => spawnSync(process.execPath, [resolve('scripts/check-unused-exports.mjs'), join(root, 'tsconfig.json')], { encoding: 'utf8' });
    const result = scan();
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.stderr.trim().split('\n'), [
      'src/barrel.ts: dead', 'src/barrel.ts: localDead', 'src/barrel.ts: live', 'src/barrel.ts: testOnly',
      'src/values.ts: dead', 'src/values.ts: localDead', 'src/values.ts: testOnly',
    ].sort());
    writeFileSync(join(root, 'src/consumer.ts'), `import * as barrel from './barrel'; import * as values from './values';
      import * as namespace from './namespace'; import { renamedDefault } from './default';
      console.log(barrel, values, namespace, renamedDefault);`);
    const passing = scan();
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /No unused value exports/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
