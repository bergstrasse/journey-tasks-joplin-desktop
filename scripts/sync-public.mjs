// Mirror main into the public release branch, tag it from package/manifest versions, and push both.
// The public tree is main's tree plus public-only files, minus every tracked file matching .gitignore.public, whose
// content also becomes the public .gitignore. Deletions on main propagate too (#88).
//
// --no-tag pushes only the branch (no tag create/move, no release workflow), so main can be synced without a version bump (#95).
// Full documentation: documents/发布脚本说明.md (excluded from public by .gitignore.public).
//
// Usage: node scripts/sync-public.mjs [--no-tag] [--dry-run] [--skip-check] [--remote=github] [--remote-branch=main]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractReleaseNotes } from './release-notes.mjs';

const PUBLIC_ONLY_FILES = ['.gitignore.public'];
/** The public .gitignore is always .gitignore.public's content, so main's .gitignore never overrides it. */
const PUBLIC_IGNORE = '.gitignore.public';
const PUBLIC_GITIGNORE = '.gitignore';

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

/** Lists tracked paths in the given index that match .gitignore.public's rules (matching is git's own). */
function ignoredPaths(cwd, env, rulesFile) {
  return git(cwd, ['ls-files', '-z', '--cached', '--ignored', `--exclude-from=${rulesFile}`], { env }).split('\0').filter(Boolean);
}

/**
 * Builds (without touching the working tree) a public commit: main's tree, plus public-only files, minus tracked files
 * matching .gitignore.public, with .gitignore replaced by .gitignore.public's content.
 */
function buildPublicCommit(cwd, { source = 'main', branch = 'public', message }) {
  const parent = git(cwd, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  const tempDir = mkdtempSync(path.join(tmpdir(), 'journey-public-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tempDir, 'index') };
    git(cwd, ['read-tree', source], { env });
    const entry = file => {
      const blob = tryGit(cwd, ['rev-parse', '--verify', `${parent}:${file}`]);
      if (!blob) throw new Error(`${branch} is missing public-only file ${file}`);
      return { blob, mode: git(cwd, ['ls-tree', parent, '--', file]).split(/\s+/)[0] };
    };
    const rulesFile = path.join(tempDir, 'public-ignore');
    writeFileSync(rulesFile, git(cwd, ['cat-file', 'blob', entry(PUBLIC_IGNORE).blob]) + '\n');
    const excluded = ignoredPaths(cwd, env, rulesFile);
    for (const file of excluded) git(cwd, ['update-index', '--force-remove', '--', file], { env });
    for (const file of PUBLIC_ONLY_FILES) {
      const { blob, mode } = entry(file);
      git(cwd, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${file}`], { env });
    }
    const ignore = entry(PUBLIC_IGNORE);
    git(cwd, ['update-index', '--add', '--cacheinfo', `${ignore.mode},${ignore.blob},${PUBLIC_GITIGNORE}`], { env });
    const leaked = ignoredPaths(cwd, env, rulesFile);
    if (leaked.length) throw new Error(`Public tree still contains files matching ${PUBLIC_IGNORE}:\n${leaked.join('\n')}`);
    const tree = git(cwd, ['write-tree'], { env });
    if (tree === git(cwd, ['rev-parse', `${parent}^{tree}`])) return { commit: parent, parent, changed: false, excluded };
    const commit = git(cwd, ['commit-tree', tree, '-p', parent, '-m', message]);
    return { commit, parent, changed: true, excluded };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** The public commit may differ from main only by public-only files, the public .gitignore and excluded files. */
function assertMirrors(cwd, source, commit, excluded) {
  const allowed = new Set([...PUBLIC_ONLY_FILES, PUBLIC_GITIGNORE, ...excluded]);
  const diff = git(cwd, ['diff', '--name-only', '-z', source, commit]).split('\0').filter(Boolean);
  const unexpected = diff.filter(file => !allowed.has(file));
  if (unexpected.length) throw new Error(`Public commit differs from ${source} beyond public-only and excluded files:\n${unexpected.join('\n')}`);
  const present = excluded.filter(file => tryGit(cwd, ['rev-parse', '--verify', `${commit}:${file}`]));
  if (present.length) throw new Error(`Public commit contains files excluded by ${PUBLIC_IGNORE}:\n${present.join('\n')}`);
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

function runReleaseChecks(cwd, commit, tag) { // tag undefined → verify:release runs without RELEASE_TAG
  const dir = mkdtempSync(path.join(tmpdir(), 'journey-public-check-'));
  const worktree = path.join(dir, 'tree');
  git(cwd, ['worktree', 'add', '--detach', worktree, commit]);
  try {
    const modules = path.join(cwd, 'node_modules');
    if (!existsSync(modules)) throw new Error('node_modules is missing; run npm ci first');
    symlinkSync(modules, path.join(worktree, 'node_modules'), 'dir');
    const env = { ...process.env, TZ: 'UTC' };
    if (tag) env.RELEASE_TAG = tag; else delete env.RELEASE_TAG;
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

/** Reads package.json's version only; --no-tag does not release, so changelog/manifest strictness is not required. */
function currentVersion(cwd, source = 'main') {
  const pkg = JSON.parse(git(cwd, ['show', `${source}:package.json`]));
  return { name: pkg.name, version: pkg.version, tag: `v${pkg.version}` };
}

function pushBranchOnly({ cwd, branch, remote, remoteBranch, remoteHead, localPublic, commit, tag, dryRun, skipCheck, log }) {
  if (remoteHead === commit) {
    log(`Nothing to push: ${remote}/${remoteBranch} already matches.`);
    return { commit, tag, pushed: false };
  }
  if (!skipCheck) runReleaseChecks(cwd, commit, undefined);
  if (dryRun) {
    log(`Dry run: would push ${commit.slice(0, 7)} to ${remote}/${remoteBranch} without touching tags`);
    return { commit, tag, pushed: false };
  }
  git(cwd, ['update-ref', `refs/heads/${branch}`, commit, localPublic]);
  execFileSync('git', ['push', remote, `refs/heads/${branch}:refs/heads/${remoteBranch}`], { cwd, stdio: 'inherit' });
  log(`Pushed ${branch} to ${remote}/${remoteBranch}; no tag was pushed, so no release workflow was triggered.`);
  return { commit, tag, pushed: true };
}

function syncPublic({ cwd = process.cwd(), source = 'main', branch = 'public', remote = 'github', remoteBranch = 'main',
  dryRun = false, skipCheck = false, noTag = false, isPublished = npmPublished, log = console.log } = {}) {
  if (git(cwd, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('Working tree has uncommitted changes; commit them to main first');
  const sourceCommit = git(cwd, ['rev-parse', '--verify', `${source}^{commit}`]);
  const { name, version, tag } = noTag ? currentVersion(cwd, source) : releaseVersion(cwd, source);
  log(noTag ? `Sync ${source} ${sourceCommit.slice(0, 7)} to public without tagging (${name}@${version})`
    : `Release ${name}@${version} (${tag}) from ${source} ${sourceCommit.slice(0, 7)}`);

  git(cwd, ['fetch', remote, `+refs/heads/${remoteBranch}:refs/remotes/${remote}/${remoteBranch}`]);
  const remoteHead = tryGit(cwd, ['rev-parse', '--verify', `refs/remotes/${remote}/${remoteBranch}^{commit}`]);
  const localPublic = git(cwd, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  if (remoteHead && remoteHead !== localPublic) {
    try { git(cwd, ['merge-base', '--is-ancestor', remoteHead, localPublic]); } catch {
      throw new Error(`${remote}/${remoteBranch} (${remoteHead.slice(0, 7)}) has commits that local ${branch} lacks; reconcile them first`);
    }
  }

  const message = noTag ? `sync: ${source} ${sourceCommit.slice(0, 7)} (based on ${tag})\n\nSync ${source} ${sourceCommit}`
    : `release: ${tag}\n\nSync ${source} ${sourceCommit}`;
  const { commit, changed, excluded } = buildPublicCommit(cwd, { source, branch, message });
  assertMirrors(cwd, source, commit, excluded);
  if (excluded.length) log(`Excluded ${excluded.length} tracked file(s) matching ${PUBLIC_IGNORE}`);
  log(changed ? `New public commit ${commit.slice(0, 7)} on top of ${localPublic.slice(0, 7)}` : `Public tree already matches ${source}; reusing ${commit.slice(0, 7)}`);

  if (noTag) return pushBranchOnly({ cwd, branch, remote, remoteBranch, remoteHead, localPublic, commit, tag, dryRun, skipCheck, log });

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
    syncPublic({ dryRun: args.includes('--dry-run'), skipCheck: args.includes('--skip-check'), noTag: args.includes('--no-tag'),
      remote: option('remote') ?? 'github', remoteBranch: option('remote-branch') ?? 'main' });
  } catch (error) {
    console.error(`sync-public failed: ${error.message}`);
    process.exit(1);
  }
}
