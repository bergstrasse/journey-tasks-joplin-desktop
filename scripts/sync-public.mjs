// Mirror main into the public release branch, tag it from package/manifest versions, and push both.
// The public tree is exactly main's tree plus public-only files, so deletions on main propagate too (#88).
//
// Usage: node scripts/sync-public.mjs [--dry-run] [--skip-check] [--remote=github] [--remote-branch=main]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractReleaseNotes } from './release-notes.mjs';

const PUBLIC_ONLY_FILES = ['.gitignore.public'];

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}
function tryGit(cwd, args) {
  try { return git(cwd, args); } catch { return undefined; }
}

/** Reads and cross-checks the release version from main's committed package.json, manifest and changelog. */
function releaseVersion(cwd, source = 'main') {
  const read = file => git(cwd, ['show', `${source}:${file}`]);
  const pkg = JSON.parse(read('package.json'));
  const manifest = JSON.parse(read('src/manifest.json'));
  if (pkg.version !== manifest.version) throw new Error(`package.json (${pkg.version}) and src/manifest.json (${manifest.version}) versions differ`);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error(`Release version must be stable semver, got ${pkg.version}`);
  const tag = `v${pkg.version}`;
  const changelog = read('changelog.md');
  extractReleaseNotes(changelog, tag);
  const newest = /^##\s+v?(\d+\.\d+\.\d+)\s*$/m.exec(changelog)?.[1];
  if (newest !== pkg.version) throw new Error(`Newest changelog section is v${newest}, but package version is ${pkg.version}`);
  return { name: pkg.name, version: pkg.version, tag };
}

/** Builds (without touching the working tree) a public commit whose tree is main's tree plus public-only files. */
function buildPublicCommit(cwd, { source = 'main', branch = 'public', message }) {
  const parent = git(cwd, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  const tempDir = mkdtempSync(path.join(tmpdir(), 'journey-public-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tempDir, 'index') };
    git(cwd, ['read-tree', source], { env });
    for (const file of PUBLIC_ONLY_FILES) {
      const blob = tryGit(cwd, ['rev-parse', '--verify', `${parent}:${file}`]);
      if (!blob) throw new Error(`${branch} is missing public-only file ${file}`);
      const mode = git(cwd, ['ls-tree', parent, '--', file]).split(/\s+/)[0];
      git(cwd, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${file}`], { env });
    }
    const tree = git(cwd, ['write-tree'], { env });
    if (tree === git(cwd, ['rev-parse', `${parent}^{tree}`])) return { commit: parent, parent, changed: false };
    const commit = git(cwd, ['commit-tree', tree, '-p', parent, '-m', message]);
    return { commit, parent, changed: true };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** The public commit must differ from main only by public-only files; anything else means the mirror is wrong. */
function assertMirrors(cwd, source, commit) {
  const diff = git(cwd, ['diff', '--name-only', source, commit]).split('\n').filter(Boolean);
  const unexpected = diff.filter(file => !PUBLIC_ONLY_FILES.includes(file));
  if (unexpected.length) throw new Error(`Public commit differs from ${source} beyond public-only files:\n${unexpected.join('\n')}`);
}

function npmPublished(name, version) {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (error) {
    if (/E404|404 Not Found/.test(String(error.stderr ?? ''))) return false;
    throw new Error(`Could not check npm for ${name}@${version}: ${String(error.stderr ?? error.message).trim()}`);
  }
}

function runReleaseChecks(cwd, commit, tag) {
  const dir = mkdtempSync(path.join(tmpdir(), 'journey-public-check-'));
  const worktree = path.join(dir, 'tree');
  git(cwd, ['worktree', 'add', '--detach', worktree, commit]);
  try {
    const modules = path.join(cwd, 'node_modules');
    if (!existsSync(modules)) throw new Error('node_modules is missing; run npm ci first');
    symlinkSync(modules, path.join(worktree, 'node_modules'), 'dir');
    const env = { ...process.env, TZ: 'UTC', RELEASE_TAG: tag };
    for (const script of ['build', 'check', 'verify:release']) {
      console.log(`\n> npm run ${script} (public tree, TZ=UTC)`);
      execFileSync('npm', ['run', script], { cwd: worktree, env, stdio: 'inherit' });
    }
  } finally {
    tryGit(cwd, ['worktree', 'remove', '--force', worktree]);
    tryGit(cwd, ['worktree', 'prune']);
    rmSync(dir, { recursive: true, force: true });
  }
}

function syncPublic({ cwd = process.cwd(), source = 'main', branch = 'public', remote = 'github', remoteBranch = 'main',
  dryRun = false, skipCheck = false, isPublished = npmPublished, log = console.log } = {}) {
  if (git(cwd, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Working tree has uncommitted changes; commit them to main first');
  const sourceCommit = git(cwd, ['rev-parse', '--verify', `${source}^{commit}`]);
  const { name, version, tag } = releaseVersion(cwd, source);
  log(`Release ${name}@${version} (${tag}) from ${source} ${sourceCommit.slice(0, 7)}`);

  git(cwd, ['fetch', remote, `+refs/heads/${remoteBranch}:refs/remotes/${remote}/${remoteBranch}`]);
  const remoteHead = tryGit(cwd, ['rev-parse', '--verify', `refs/remotes/${remote}/${remoteBranch}^{commit}`]);
  const localPublic = git(cwd, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  if (remoteHead && remoteHead !== localPublic) {
    try { git(cwd, ['merge-base', '--is-ancestor', remoteHead, localPublic]); } catch {
      throw new Error(`${remote}/${remoteBranch} (${remoteHead.slice(0, 7)}) has commits that local ${branch} lacks; reconcile them first`);
    }
  }

  const { commit, changed } = buildPublicCommit(cwd, { source, branch, message: `release: ${tag}\n\nSync ${source} ${sourceCommit}` });
  assertMirrors(cwd, source, commit);
  log(changed ? `New public commit ${commit.slice(0, 7)} on top of ${localPublic.slice(0, 7)}` : `Public tree already matches ${source}; reusing ${commit.slice(0, 7)}`);

  const remoteTagLine = git(cwd, ['ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const remoteTagTarget = (remoteTagLine.split('\n').find(line => line.endsWith('^{}')) ?? remoteTagLine.split('\n').find(Boolean))?.split(/\s+/)[0];
  const moveTag = Boolean(remoteTagTarget && remoteTagTarget !== commit);
  if (moveTag && isPublished(name, version)) throw new Error(`${name}@${version} is already on npm; bump package.json, src/manifest.json and changelog.md first`);
  const pushTag = !remoteTagTarget || moveTag;
  log(!remoteTagTarget ? `Tag ${tag} will be created` : moveTag ? `Tag ${tag} will move from ${remoteTagTarget.slice(0, 7)} (not on npm yet)` : `Tag ${tag} already points at ${commit.slice(0, 7)}`);
  const pushBranch = remoteHead !== commit;
  if (!pushBranch && !pushTag) {
    log('Nothing to push: remote branch and tag are already up to date. Bump the version to release again.');
    return { commit, tag, pushed: false };
  }

  if (!skipCheck) runReleaseChecks(cwd, commit, tag);
  if (dryRun) {
    log(`Dry run: would push ${commit.slice(0, 7)} to ${remote}/${remoteBranch}${pushTag ? ` and ${moveTag ? 'force-move' : 'create'} ${tag}` : ''}`);
    return { commit, tag, pushed: false };
  }

  git(cwd, ['update-ref', `refs/heads/${branch}`, commit, localPublic]);
  git(cwd, ['tag', '-f', '-a', tag, '-m', `Release version ${version}`, commit]);
  const refspecs = [`refs/heads/${branch}:refs/heads/${remoteBranch}`];
  if (pushTag) refspecs.push(`${moveTag ? '+' : ''}refs/tags/${tag}:refs/tags/${tag}`);
  execFileSync('git', ['push', '--atomic', remote, ...refspecs], { cwd, stdio: 'inherit' });
  log(pushTag ? `Pushed ${tag}; the Release workflow runs on the tag push.` : `Pushed ${branch}; ${tag} was unchanged, so no release workflow was triggered.`);
  return { commit, tag, pushed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1];
  try {
    syncPublic({ dryRun: args.includes('--dry-run'), skipCheck: args.includes('--skip-check'),
      remote: option('remote') ?? 'github', remoteBranch: option('remote-branch') ?? 'main' });
  } catch (error) {
    console.error(`sync-public failed: ${error.message}`);
    process.exit(1);
  }
}
