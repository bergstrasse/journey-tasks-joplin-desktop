import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostPanelStyle, hostPanelFragment } from '../fixtures/joplin-panel-host';

const executable = process.env.JOURNEY_BROWSER;
const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

test('issue67: real pointer hover never makes the menu dismiss button cover the panel', { skip: !executable, timeout: 45000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'journey-menu-'));
  const artifacts = resolve('.tmp/issue67-hover'); mkdirSync(artifacts, { recursive: true });
  const process = spawn(executable!, ['--headless', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(temporary, 'profile')}`, 'about:blank'], { stdio: 'ignore' });
  let socket: WebSocket | undefined;
  try {
    let port = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      try { port = readFileSync(join(temporary, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0]!; break; } catch { await pause(); }
    }
    assert.ok(port, 'isolated Chromium must expose its debugging port');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    socket = new WebSocket(targets.find(target => target.type === 'page')!.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener('open', () => resolve(), { once: true }); socket!.addEventListener('error', reject, { once: true }); });
    let seq = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void }>();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); if (message.error) entry.reject(message.error); else entry.resolve(message.result); }
    });
    const rpc = (method: string, params = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string) => {
      const result = await rpc('Runtime.evaluate', { expression, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const move = async (x: number, y: number) => { await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await pause(); };
    const click = async (x: number, y: number, button = 'left') => {
      await move(x, y);
      await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'right' ? 2 : 1, clickCount: 1 });
      await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
      await pause(100);
    };
    await rpc('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
    const css = readFileSync('dist/panel.css', 'utf8');
    const script = readFileSync('dist/panel.js', 'utf8').replace(/<\/script/gi, '<\\/script');
    for (const dark of [false, true]) for (const baseline of [true, false]) {
      // Negative control retains the previous transparent default and omits only the hover fix.
      const style = baseline ? css.replace(/\.menu-shade:not\(:disabled\):hover/g, '.unused-shade-hover') : css;
      const tasks = Array.from({ length: 2000 }, (_, i) => ({ taskId: `n${i}`, noteId: `n${i}`, title: `Task ${i}`, notebookId: 'book', tagIds: [], schedule: { kind: 'none' }, completedAt: 0, priority: 'none', pinned: false, reminder: { enabled: false } }));
      const snapshot = { snapshotVersion: 1, now: Date.now(), deviceZone: 'Asia/Shanghai', view: 'all', range: { start: '2026-10-01', end: '2026-11-01' }, tasks, items: tasks.map(task => ({ ...task, id: task.noteId, date: '', kind: 'actual', overdue: false, completed: false })), series: [], tags: [], folders: [{ id: 'book', title: 'Book' }], diagnostics: [], warnings: [], truncated: false, loading: false, preferences: { startupMode: 'fixed', defaultView: 'all', lastView: 'all', language: 'en', showCompleted: false } };
      const fixture = join(temporary, `menu-${dark}-${baseline}.html`);
      writeFileSync(fixture, `<!doctype html><html><head><style>${hostPanelStyle}${style}${dark ? ':root{--joplin-background-color:#202124;--joplin-color:#e8eaed;--joplin-color4:#8ab4f8}' : ''}</style></head><body>${hostPanelFragment}<script>const fixtureSnapshot=${JSON.stringify(snapshot)};window.webviewApi={onMessage(){},postMessage:async m=>{if(m.action==='snapshot')return {ok:true,snapshot:structuredClone(fixtureSnapshot)};const c=m.command;if(c?.action==='changeDate'){fixtureSnapshot.tasks[0].schedule=c.schedule;fixtureSnapshot.items[0].schedule=c.schedule;fixtureSnapshot.items[0].date=c.schedule.date;fixtureSnapshot.snapshotVersion++;}return {ok:true,result:{status:'saved',requestId:c?.requestId}};}};</script><script>${script}</script></body></html>`);
      await rpc('Page.navigate', { url: pathToFileURL(fixture).href });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate("document.querySelectorAll('.task-row').length===2000")) break;
        await pause();
      }
      assert.equal(await evaluate("document.querySelectorAll('.task-row').length"), 2000);
      const row = await evaluate("(()=>{const r=document.querySelector('.task-content').getBoundingClientRect();return {x:r.x+40,y:r.y+r.height/2}})()");
      await click(row.x, row.y, 'right');
      assert.equal(await evaluate("!!document.querySelector('.task-menu')"), true);
      const menu = await evaluate("(()=>{const r=document.querySelector('.task-menu').getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()");
      await move(menu.x, menu.y);
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.menu-shade')).backgroundColor"), 'rgba(0, 0, 0, 0)', 'shade starts transparent when pointer is over menu');
      await move(2, 2);
      assert.equal(await evaluate("document.querySelector('.menu-shade').matches(':hover')"), true, 'exercise actual CSS hover, not a synthetic mouseover event');
      const background = await evaluate("getComputedStyle(document.querySelector('.menu-shade')).backgroundColor");
      if (baseline) assert.notEqual(background, 'rgba(0, 0, 0, 0)', 'previous CSS reproduces an opaque full-screen cover');
      else assert.equal(background, 'rgba(0, 0, 0, 0)', 'hovered shade stays transparent');
      const screenshot = await rpc('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(artifacts, `${dark ? 'dark' : 'light'}-${baseline ? 'before' : 'after'}.png`), Buffer.from(screenshot.data, 'base64'));
      await click(2, 2);
      assert.equal(await evaluate("!!document.querySelector('.task-menu')"), false, 'outside click still dismisses menu');
      assert.equal(await evaluate("document.querySelectorAll('.task-row').length"), 2000);
      if (!baseline) {
        await click(row.x, row.y, 'right');
        const tomorrow = await evaluate("(()=>{const r=document.querySelectorAll('.menu-date-options button')[1].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
        await click(tomorrow.x, tomorrow.y);
        assert.equal(await evaluate("!!document.querySelector('.task-menu')"), false, 'date command still closes menu');
        assert.ok(await evaluate("document.querySelector('[title=\"Task 0\"]').closest('.task-row').querySelector('time').dateTime"), 'new date is rendered after authoritative refresh');
        assert.equal(await evaluate("document.querySelectorAll('.task-row').length"), 2000);
        assert.equal(await evaluate("document.querySelectorAll('[role=alert]').length"), 0);
      }
    }
  } finally {
    socket?.close();
    process.kill();
    await new Promise<void>(resolve => { if (process.exitCode !== null) resolve(); else process.once('exit', () => resolve()); });
    rmSync(temporary, { recursive: true, force: true });
  }
});
