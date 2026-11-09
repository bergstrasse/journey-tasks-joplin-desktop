import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const script = resolve('scripts/sync-public.mjs');
const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const changelog = (version: string) => `# Changelog\n\n## v${version}\n\n### English\n\n- Notes.\n\n### 中文\n\n- 说明。\n`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'journey-sync-public-'));
  const repo = join(root, 'repo'), remote = join(root, 'remote.git');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  mkdirSync(join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git('init', '-q', '-b', 'main');
  const writeVersion = (version: string, manifestVersion = version) => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'joplin-plugin-sync-test', version }));
    writeFileSync(join(repo, 'src/manifest.json'), JSON.stringify({ version: manifestVersion }));
    writeFileSync(join(repo, 'changelog.md'), changelog(version));
  };
  writeVersion('1.2.3');
  writeFileSync(join(repo, 'stale.test.ts'), 'old');
  git('add', '.'); git('commit', '-qm', 'initial');
  git('checkout', '-qb', 'public');
  writeFileSync(join(repo, '.gitignore.public'), 'documents/\n');
  git('add', '.'); git('commit', '-qm', 'public');
  git('remote', 'add', 'github', remote);
  git('push', '-q', 'github', 'public:main');
  git('checkout', '-q', 'main');
  unlinkSync(join(repo, 'stale.test.ts'));
  writeFileSync(join(repo, 'fixed.ts'), 'new');
  git('add', '-A'); git('commit', '-qm', 'delete stale test and add fix');
  const run = () => spawnSync(process.execPath, [script, '--skip-check'], { cwd: repo, env, encoding: 'utf8' });
  const remoteGit = (...args: string[]) => execFileSync('git', args, { cwd: remote, encoding: 'utf8' }).trim();
  return { root, repo, git, run, remoteGit, writeVersion };
}

test('sync-public mirrors main deletions, keeps public-only files and pushes an annotated version tag', () => {
  const { root, run, git, remoteGit } = setup();
  try {
    const result = run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const files = remoteGit('ls-tree', '-r', '--name-only', 'main').split('\n').sort();
    assert.deepEqual(files, ['.gitignore.public', 'changelog.md', 'fixed.ts', 'package.json', 'src/manifest.json']);
    assert.equal(remoteGit('cat-file', '-t', 'v1.2.3'), 'tag');
    assert.equal(remoteGit('rev-parse', 'v1.2.3^{commit}'), remoteGit('rev-parse', 'main'));
    assert.equal(git('rev-parse', 'public'), remoteGit('rev-parse', 'main'));
    assert.match(remoteGit('log', '-1', '--format=%s', 'main'), /^release: v1\.2\.3$/);
    const again = run();
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Nothing to push/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sync-public refuses uncommitted changes and mismatched versions without pushing', () => {
  const { root, repo, run, git, remoteGit, writeVersion } = setup();
  try {
    const before = remoteGit('rev-parse', 'main');
    writeFileSync(join(repo, 'fixed.ts'), 'dirty');
    assert.match(run().stderr, /uncommitted changes/);
    git('checkout', '--', 'fixed.ts');
    writeVersion('1.2.4', '1.2.3'); git('commit', '-qam', 'bad bump');
    assert.match(run().stderr, /versions differ/);
    assert.equal(remoteGit('rev-parse', 'main'), before);
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/tags/v1.2.4'], { cwd: remote(root) }).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const remote = (root: string) => join(root, 'remote.git');
