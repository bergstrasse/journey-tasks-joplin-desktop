// Runs against a disposable real Joplin profile, using public APIs for all writes.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';

const executable = process.env.JOURNEY_JOPLIN || '/Applications/Joplin.app/Contents/MacOS/Joplin';
const temporary = await mkdtemp(join(tmpdir(), 'journey-issue54-host-'));
const profile = join(temporary, 'profile'), plugin = join(temporary, 'plugin');
await mkdir(profile); await mkdir(plugin);
const reportTitle = 'Journey issue54 host verification report';
const probe = `import joplin from 'api';
import { startPlugin } from './src/bootstrap';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
joplin.plugins.register({ onStart: async () => {
  let runtime;
  const report = { checkedAt: new Date().toISOString(), events: [] };
  let folder;
  try {
    report.version = await joplin.versionInfo();
    folder = await joplin.data.post(['folders'], null, { title: 'Issue54 disposable verification' });
    const a = await joplin.data.post(['notes'], null, { parent_id: folder.id, title: 'Selected task A', body: 'A body', is_todo: 1 });
    const b = await joplin.data.post(['notes'], null, { parent_id: folder.id, title: 'Background task B', body: 'B body', is_todo: 1 });
    const tag = await joplin.data.post(['tags'], null, { title: 'issue54-tag' });
    await joplin.data.post(['tags', tag.id, 'notes'], null, { id: b.id });
    await joplin.commands.execute('openNote', a.id); await pause(800);
    await joplin.workspace.onNoteChange(event => report.events.push({ kind: 'note', event }));
    await joplin.workspace.onNoteSelectionChange(event => report.events.push({ kind: 'selection', event }));
    runtime = await startPlugin(joplin); await pause(800);
    report.tagMembershipCorrect = (await runtime.app.snapshot()).tasks.find(t => t.noteId === b.id)?.tagIds.includes(tag.id);
    const calls = { fullScans: 0, singleReads: 0 };
    const allNotes = runtime.app.gateway.allNotes.bind(runtime.app.gateway);
    runtime.app.gateway.allNotes = async (...args) => { calls.fullScans++; return allNotes(...args); };
    const getNote = runtime.app.gateway.getNote.bind(runtime.app.gateway);
    runtime.app.gateway.getNote = async (...args) => { calls.singleReads++; return getNote(...args); };
    // Public API edit while A is selected models an edit made by another plugin.
    await joplin.data.put(['notes', b.id], null, { title: 'Background B externally updated', todo_completed: Date.now() });
    await pause(1200);
    const readB = async () => (await runtime.app.snapshot({ showCompleted: true })).tasks.find(t => t.noteId === b.id);
    const beforeSelection = await readB();
    report.backgroundUpdateBeforeSelection = beforeSelection?.title === 'Background B externally updated' && !!beforeSelection?.completedAt;
    await joplin.commands.execute('openNote', b.id); await pause(1200);
    const afterSelection = await readB();
    report.backgroundUpdateAfterSelection = afterSelection?.title === 'Background B externally updated' && !!afterSelection?.completedAt;
    report.refreshCalls = { ...calls };
    const before = (await runtime.app.snapshot()).snapshotVersion;
    for (const id of [a.id, b.id, a.id, b.id]) {
      await joplin.commands.execute('openNote', id); await pause(650);
    }
    report.unchangedSelectionVersionStable = (await runtime.app.snapshot()).snapshotVersion === before;
    report.noSelectionFullScan = calls.fullScans === 0;
    const result = await runtime.app.dispatch({ action: 'setFields', requestId: 'host-selection-command', expectedSnapshotVersion: before, noteId: a.id, pinned: true });
    report.commandWithOriginalVersion = { status: result.status, code: result.code };
    report.passed = report.tagMembershipCorrect && report.backgroundUpdateAfterSelection && report.unchangedSelectionVersionStable && report.noSelectionFullScan && result.status === 'saved';
  } catch (error) {
    report.error = { message: error?.message || String(error), stack: error?.stack };
    report.passed = false;
  } finally {
    runtime?.dispose();
    await joplin.data.post(['notes'], null, { parent_id: folder?.id, title: ${JSON.stringify(reportTitle)}, body: JSON.stringify(report, null, 2) });
  }
} });`;
let app;
try {
  await build({ stdin: { contents: probe, resolveDir: resolve('.'), sourcefile: 'issue54-host-probe.ts' }, outfile: join(plugin, 'index.js'), bundle: true, platform: 'browser', format: 'cjs', target: 'es2020', tsconfig: 'tsconfig.json' });
  for (const name of ['panel.js', 'panel.css', 'manifest.json']) await copyFile(join('dist', name), join(plugin, name));
  const archive = join(temporary, 'probe.jpl');
  execFileSync('tar', ['-cf', archive, '-C', plugin, 'index.js', 'panel.js', 'panel.css', 'manifest.json']);
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ locale: 'en_GB', 'plugins.devPluginPaths': archive }));
  app = spawn(executable, ['--profile', profile, '--running-tests'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  app.stderr.on('data', data => { errors = (errors + data).slice(-8000); });
  const query = `import sqlite3,sys
try:
 c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
 r=c.execute('select body from notes where title=?',(sys.argv[2],)).fetchone()
 if r: print(r[0])
except sqlite3.Error: pass`;
  const deadline = Date.now() + 60000;
  let report;
  while (Date.now() < deadline) {
    const text = execFileSync('python3', ['-c', query, join(profile, 'database.sqlite'), reportTitle], { encoding: 'utf8' }).trim();
    if (text) { report = JSON.parse(text); break; }
    if (app.exitCode !== null) throw new Error('Isolated Joplin exited: ' + errors);
    await delay(500);
  }
  if (!report) {
    let log = ''; try { log = (await readFile(join(profile, 'log.txt'), 'utf8')).slice(-20000); } catch {}
    throw new Error('Timed out waiting for host report: ' + errors + '\n' + log);
  }
  report.probeArchiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  report.hostEnvironment = { platform: process.platform, architecture: process.arch };
  await mkdir('documents/validation', { recursive: true });
  await writeFile('documents/validation/issue54-host.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  if (app && app.exitCode === null) {
    app.kill('SIGTERM');
    await Promise.race([new Promise(resolve => app.once('exit', resolve)), delay(1500)]);
    if (app.exitCode === null) { app.kill('SIGKILL'); await new Promise(resolve => app.once('exit', resolve)); }
  }
  await rm(temporary, { recursive: true, force: true });
}
