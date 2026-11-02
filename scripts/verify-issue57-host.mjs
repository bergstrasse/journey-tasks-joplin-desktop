// Runs against a disposable real Joplin profile, using public APIs for all writes.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';

const executable = process.env.JOURNEY_JOPLIN || '/Applications/Joplin.app/Contents/MacOS/Joplin';
const temporary = await mkdtemp(join(tmpdir(), 'journey-issue57-host-'));
const profile = join(temporary, 'profile'), plugin = join(temporary, 'plugin');
await mkdir(profile); await mkdir(plugin);
const reportTitle = 'Journey issue57 host verification report';
const probe = `import joplin from 'api';
import { startPlugin } from './src/bootstrap';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
joplin.plugins.register({ onStart: async () => {
  let runtime;
  const report = { checkedAt: new Date().toISOString(), calls: [] };
  try {
    report.version = await joplin.versionInfo();
    const execute = (...args) => joplin.commands.execute(...args);
    const api = { get data() { return joplin.data; }, get settings() { return joplin.settings; }, get views() { return joplin.views; }, get workspace() { return joplin.workspace; }, get plugins() { return joplin.plugins; }, commands: { register: (...args) => joplin.commands.register(...args), execute: async (...args) => {
      const result = await execute(...args);
      if (args[0] === 'openItem') report.calls.push(args);
      return result;
    } } };
    runtime = await startPlugin(api);
    await runtime.app.dispatch({ action: 'savePreferences', requestId: 'english', preferences: { language: 'en' } });
    runtime.panel.invalidate();
    await joplin.views.panels.addScript(runtime.panel.handle, 'click-report.js');
    for (let i=0; i<40 && !report.calls.length; i++) await pause(250);
    report.passed = report.calls.some(args => args[0] === 'openItem' && args[1] === 'https://github.com/tigerwoo/journey-tasks-joplin-desktop/issues');
    report.scope = 'Real Joplin panel DOM click through webview messaging to successful native openItem command; browser page appearance requires visual confirmation.';
  } catch (error) { report.error = { message: error?.message || String(error), stack: error?.stack }; report.passed = false; }
  finally {
    runtime?.dispose();
    await joplin.data.post(['notes'], null, { title: ${JSON.stringify(reportTitle)}, body: JSON.stringify(report, null, 2) });
  }
} });`;
let app;
try {
  await build({ stdin: { contents: probe, resolveDir: resolve('.'), sourcefile: 'issue57-host-probe.ts' }, outfile: join(plugin, 'index.js'), bundle: true, platform: 'browser', format: 'cjs', target: 'es2020', tsconfig: 'tsconfig.json' });
  for (const name of ['panel.js', 'panel.css', 'manifest.json']) await copyFile(join('dist', name), join(plugin, name));
  await writeFile(join(plugin, 'click-report.js'), `const clickReportTimer = setInterval(() => {
    const link = document.querySelector('.settings-about a');
    if (link) { clearInterval(clickReportTimer); link.click(); return; }
    const button = document.querySelector('button[aria-label="Settings"]');
    if (button && !button.disabled) button.click();
  }, 250);`);
  const archive = join(temporary, 'probe.jpl');
  execFileSync('tar', ['-cf', archive, '-C', plugin, 'index.js', 'panel.js', 'panel.css', 'manifest.json', 'click-report.js']);
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
  await writeFile('documents/validation/issue57-host.json', JSON.stringify(report, null, 2) + '\n');
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
