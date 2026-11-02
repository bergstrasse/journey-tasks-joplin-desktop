// Runs against a disposable real Joplin profile, using public APIs for all writes.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';

const executable = process.env.JOURNEY_JOPLIN || '/Applications/Joplin.app/Contents/MacOS/Joplin';
const temporary = await mkdtemp(join(tmpdir(), 'journey-issue62-host-'));
const profile = join(temporary, 'profile'), plugin = join(temporary, 'plugin');
await mkdir(profile); await mkdir(plugin);
const reportTitle = 'Journey issue62 host verification report';
const probe = `import joplin from 'api';
import { startPlugin } from './src/bootstrap';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
joplin.plugins.register({ onStart: async () => {
  let runtime, folder;
  const report = { checkedAt: new Date().toISOString(), timingsMs: [], checks: {} };
  try {
    report.version = await joplin.versionInfo();
    folder = await joplin.data.post(['folders'], null, { title: 'Issue62 disposable verification' });
    const a = await joplin.data.post(['notes'], null, { parent_id: folder.id, title: 'Selected task', body: 'Keep A body', is_todo: 1 });
    const b = await joplin.data.post(['notes'], null, { parent_id: folder.id, title: 'Background task', body: 'Keep B body', is_todo: 1 });
    await joplin.commands.execute('openNote', a.id); await pause(800);
    runtime = await startPlugin(joplin); await pause(800);
    const app = runtime.app;
    const calls = { fullScans: 0, metadataScans: 0, noteReads: [] };
    const allNotes = app.gateway.allNotes.bind(app.gateway);
    app.gateway.allNotes = async (...args) => { calls.fullScans++; return allNotes(...args); };
    const versions = app.gateway.noteVersions.bind(app.gateway);
    app.gateway.noteVersions = async (...args) => { calls.metadataScans++; return versions(...args); };
    const getNote = app.gateway.getNote.bind(app.gateway);
    app.gateway.getNote = async (...args) => { calls.noteReads.push(args[0]); return getNote(...args); };
    await app.dispatch({ action: 'setFields', requestId: 'missing', noteId: 'missing-note', pinned: true });
    const saved = await app.dispatch({ action: 'setFields', requestId: 'recover-command', noteId: a.id, pinned: true });
    report.checks.commandErrorCleared = saved.status === 'saved' && !(await app.snapshot()).diagnostics.some(d => d.code === 'NOTE_UNAVAILABLE');
    await joplin.data.put(['notes', b.id], null, { title: 'Background externally completed', todo_completed: Date.now() });
    const created = await joplin.data.post(['notes'], null, { parent_id: folder.id, title: 'External creation', body: '', is_todo: 1 });
    await app.dispatch({ action: 'refresh', requestId: 'focus', checkChanges: true });
    const snapshot = await app.snapshot({ view: 'all', showCompleted: true });
    const background = snapshot.tasks.find(t => t.noteId === b.id);
    report.checks.backgroundUpdateWithoutSelection = background?.title === 'Background externally completed' && !!background.completedAt;
    report.checks.externalCreationDiscovered = snapshot.tasks.some(t => t.noteId === created.id);
    const metadataScans = calls.metadataScans;
    for (let i = 0; i < 3; i++) await app.dispatch({ action: 'refresh', requestId: 'focus-repeat-' + i, checkChanges: true });
    report.checks.focusThrottled = calls.metadataScans === metadataScans;
    for (let i = 0; i < 12; i++) {
      const result = await app.dispatch({ action: 'createTask', requestId: 'create-' + i, input: { title: 'Performance task ' + i, notebookId: folder.id, schedule: { kind: 'none' } } });
      if (result.status !== 'saved') throw new Error('Create failed: ' + result.message);
    }
    calls.noteReads.length = 0;
    for (let i = 0; i < 10; i++) {
      const started = Date.now();
      const result = await app.dispatch({ action: 'setFields', requestId: 'pin-' + i, noteId: a.id, pinned: !!(i % 2) });
      report.timingsMs.push(Date.now() - started);
      if (result.status !== 'saved') throw new Error('Pin failed: ' + result.message);
    }
    report.checks.noUnrelatedPinReads = calls.noteReads.every(id => id === a.id);
    report.checks.noFullScans = calls.fullScans === 0;
    report.checks.noteBodyPreserved = (await joplin.data.get(['notes', a.id], { fields: ['body'] })).body === 'Keep A body';
    report.refreshCalls = calls;
    await app.dispatch({ action: 'setFields', requestId: 'ui-reset', noteId: a.id, pinned: false });
    await app.dispatch({ action: 'savePreferences', requestId: 'ui-preferences', preferences: { language: 'en', startupMode: 'fixed', defaultView: 'inbox', lastView: 'inbox' } });
    await joplin.views.panels.onMessage(runtime.panel.handle, async message => {
      if (message.action === 'issue62-ui-report') { report.ui = message.report; return { ok: true }; }
      // Keep the real host response pending long enough to measure the optimistic DOM independently.
      if (message.command?.action === 'setFields' && message.command.noteId === a.id) { report.uiInjectedHostDelayMs = 750; await pause(750); }
      const reply = await runtime.panel.handleMessage(message);
      if (message.command?.action === 'setFields' && message.command.noteId === a.id) report.uiCommandSaved = reply.result?.status === 'saved';
      return reply;
    });
    runtime.panel.invalidate();
    await joplin.views.panels.addScript(runtime.panel.handle, 'verify-panel.js');
    for (let i = 0; i < 100 && (!report.ui || !report.uiCommandSaved); i++) await pause(200);
    report.checks.realPanelOptimisticPin = !!report.ui?.pinnedBeforeAcknowledgement && !!report.uiCommandSaved;
    report.checks.realPanelOtherRowsEnabled = !!report.ui?.otherRowsEnabled;
    report.passed = Object.values(report.checks).every(Boolean);
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
  await build({ stdin: { contents: probe, resolveDir: resolve('.'), sourcefile: 'issue62-host-probe.ts' }, outfile: join(plugin, 'index.js'), bundle: true, platform: 'browser', format: 'cjs', target: 'es2020', tsconfig: 'tsconfig.json' });
  for (const name of ['panel.js', 'panel.css', 'manifest.json']) await copyFile(join('dist', name), join(plugin, name));
  await writeFile(join(plugin, 'verify-panel.js'), `
(async () => {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const report = {};
  let started;
  let acknowledged = false;
  const post = webviewApi.postMessage.bind(webviewApi);
  try {
    webviewApi.postMessage = async message => {
      const reply = await post(message);
      if (message.command?.action === 'setFields') acknowledged = true;
      return reply;
    };
    for (let i = 0; i < 100; i++) {
      const row = [...document.querySelectorAll('.task-row')].find(row => row.querySelector('.task-title')?.textContent === 'Selected task');
      if (row && document.documentElement.lang === 'en') {
        row.querySelector('.more').click(); await pause(30);
        const pin = [...document.querySelectorAll('.task-menu button')].find(button => button.textContent.trim() === 'Pin');
        if (pin && !pin.disabled) { started = performance.now(); pin.click(); break; }
      }
      await pause(100);
    }
    if (started === undefined) throw new Error('Pin menu unavailable in real panel');
    for (let i = 0; i < 100; i++) {
      const row = [...document.querySelectorAll('.task-row')].find(row => row.querySelector('.task-title')?.textContent === 'Selected task');
      const group = row?.closest('.day-group');
      if (group?.querySelector('.section-title')?.textContent.includes('Pinned')) {
        report.renderLatencyMs = Math.round(performance.now() - started);
        report.pinnedBeforeAcknowledgement = !acknowledged;
        const otherRows = [...document.querySelectorAll('.task-row')].filter(other => other !== row);
        report.otherRowsEnabled = otherRows.length > 0 && otherRows.every(other => !other.querySelector('input[type=checkbox]')?.disabled);
        break;
      }
      await pause(10);
    }
  } catch (error) { report.error = String(error); }
  await post({ action: 'issue62-ui-report', report });
})();`);
  const archive = join(temporary, 'probe.jpl');
  execFileSync('tar', ['-cf', archive, '-C', plugin, 'index.js', 'panel.js', 'panel.css', 'manifest.json', 'verify-panel.js']);
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
  const deadline = Date.now() + 90000;
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
  await writeFile('documents/validation/issue62-host.json', JSON.stringify(report, null, 2) + '\n');
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
